import { useMemo, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { nearestBeatIndex } from '../../analysis/beats/grid.ts'
import type { SongAnalysisService } from '../../analysis/client.ts'
import { fitTappedTempo, keepUserSections, moveDownbeat, rescaleTempo } from '../../analysis/edits.ts'
import { isUserSection } from '../../analysis/structure/sections.ts'
import {
  BARS_NOTES,
  hasFoundBars,
  type AudioAnalysis,
  type EditCommand,
  type Id,
  type Project,
  type Seconds,
} from '../../model/index.ts'
import { JobError, type JobHandle } from '../../shared/jobs.ts'
import { formatBpm, formatTime, plural } from '../format.ts'
import { backgroundAnalysisOn } from './footage.ts'
import { isRunning, JOB_KINDS } from './jobs.ts'
import { bpmOf, dispatch, editor, songAnalysis, useProject } from './project.ts'
import { toast } from './ui.ts'

/*
 * Assist › Song analysis: corrections to the beat grid (tap tempo, set first beat) as undoable edits, and analyzing
 * the song again on request as one job whose result is one undo step, so undo brings back the user's corrections.
 * Also the song's bars: found by the refinement step after the first analysis, and only stored once found, so
 * anything that cuts, snaps or counts on bars reads `useBars()` / `barsState()` or waits with `ensureBars()`.
 */

type AnalysisBackend = Pick<
  SongAnalysisService,
  'analyze' | 'analyzeAgain' | 'trackAtTempo' | 'refine' | 'release'
>

let service: Promise<AnalysisBackend> | null = null

/** The app's song analysis service (one worker, shared by import, refinement and corrections). */
export function analysisService(): Promise<AnalysisBackend> {
  service ??= import('../../analysis/client.ts').then((m) => new m.SongAnalysisService())
  return service
}

/** Songs whose first analysis is asked for but has not started yet (the file is still loading). */
const usePendingSongs = create<{ ids: Id[] }>(() => ({ ids: [] }))

export function markSongPending(songId: Id, pending: boolean): void {
  usePendingSongs.setState((s) => ({
    ids: pending ? [...s.ids.filter((id) => id !== songId), songId] : s.ids.filter((id) => id !== songId),
  }))
}

export function useSongPending(songId: Id | undefined): boolean {
  return usePendingSongs((s) => !!songId && s.ids.includes(songId))
}

/**
 * Where the song's analysis stands, said the same way in Inspector › Song, the Library song card and Assist:
 * 'analyzed' (a beat was found), 'no-beat' (analyzed, but silent or without a beat), 'analyzing', 'failed', or
 * 'not-analyzed' (never analyzed, or the analysis was cancelled). `job` is the phase of the latest analysis job.
 */
export type SongState = 'analyzed' | 'no-beat' | 'analyzing' | 'failed' | 'not-analyzed'

/** How each surface names a song state other than its facts. */
export const SONG_STATE_TEXT: Record<SongState, string> = {
  analyzed: 'Analyzed',
  'no-beat': 'No beat found',
  analyzing: 'Analyzing the song…',
  failed: 'Couldn’t analyze the song',
  'not-analyzed': 'Not analyzed yet',
}

export function songState(
  project: Project,
  job: 'idle' | 'running' | 'done' | 'failed',
  pending: boolean,
): SongState {
  if (bpmOf(project) !== undefined) return 'analyzed'
  if (job === 'running' || pending) return 'analyzing'
  if (job === 'failed') return 'failed'
  return songAnalysis(project) ? 'no-beat' : 'not-analyzed'
}

/** What an analysis found, for its toast: "Found 120 BPM and 7 sections", or that it found no beat. */
export function foundText(analysis: Pick<AudioAnalysis, 'tempo' | 'sections'>): string {
  const sections = analysis.sections?.length ?? 0
  const bpm = analysis.tempo?.bpm ?? 0
  if (bpm > 0) return `Found ${formatBpm(bpm)} and ${plural(sections, 'section')}`
  return sections ? `No beat found. The song has ${plural(sections, 'section')}` : 'No beat found'
}

/** For end-to-end tests: a stand-in for song analysis. */
export function setSongAnalysisServiceForTests(fake: Partial<AnalysisBackend>): void {
  service = Promise.resolve(fake as AnalysisBackend)
}

async function songFile(songId: string): Promise<Blob> {
  const { appMedia } = await import('./media.ts')
  const asset = editor.getProject().assets[songId]
  if (!asset) throw new JobError('invalid-input', 'The song is no longer in the project')
  return appMedia.getFile(asset)
}

function undoable(label: string, message: string, commands: EditCommand | EditCommand[]): void {
  if (!dispatch(commands, { label })) return
  toast(message, {
    label: 'Undo',
    run: () => {
      if (editor.undoLabel() === label) editor.undo()
      else toast('The project has changed since. Use Undo in the top bar to step back.')
    },
  })
}

/**
 * Uses a tapped tempo: at once when the beats found follow it at some level (the same, twice or half as many),
 * otherwise by tracking the beats again around it (job analysis.tempo). One undo step, "Set tempo".
 */
export async function applyTappedTempo(bpm: number): Promise<void> {
  const project = editor.getProject()
  const analysis = songAnalysis(project)
  const songId = project.songAssetId
  if (!analysis || !songId || isRunning(JOB_KINDS.tempo)) return
  const fit = fitTappedTempo(analysis, bpm)
  if (fit.kind === 'same') {
    toast(`The beats already follow ${formatBpm(bpm)}`)
    return
  }
  if (fit.kind === 'rescale') {
    undoable('Set tempo', `Tempo set to ${formatBpm(fit.edit.grid.tempo?.bpm ?? bpm)}`, fit.edit)
    return
  }
  try {
    const grid = await (await analysisService()).trackAtTempo(songId, bpm, () => songFile(songId)).promise
    if (editor.getProject().songAssetId !== songId) return
    undoable('Set tempo', `Tempo set to ${formatBpm(grid.tempo?.bpm ?? bpm)}`, {
      type: 'analysis.setGrid',
      assetId: songId,
      // Bars of the old beats no longer apply: an explicit undefined removes them when none fit the new beats.
      grid: { tempo: grid.tempo, beats: grid.beats, downbeats: grid.downbeats },
    })
  } catch (error) {
    if (!(error instanceof JobError)) throw error
    if (error.code !== 'cancelled') toast(`Could not follow that tempo. ${error.message}`)
  }
}

/** Tempo bounds for Half and Double, so the beat level stays one a listener could tap. */
export const TEMPO_LEVEL_RANGE = { min: 40, max: 300 }

type Grid = Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats'>

/**
 * The song's grid before its latest Double and the grid Double made. Halving that gives back the same beats, but
 * which of each pair of bar starts was found is lost, so Half right after Double restores the grid from before.
 */
let lastDouble: { assetId: Id; before: Grid; after: Grid } | null = null

const sameTimes = (a: readonly number[] = [], b: readonly number[] = []) =>
  a.length === b.length && a.every((t, i) => t === b[i])

/**
 * Halves (0.5) or doubles (2) the beat level as one undo step, "Half tempo" or "Double tempo": the one-click fix when
 * the analysis found the beat at twice or half the speed it is felt. Found bars stay bars of four (`rescaleTempo`);
 * when Half leaves none, the toast says so.
 */
export function setTempoLevel(factor: 2 | 0.5): void {
  const analysis = songAnalysis(editor.getProject())
  if (!analysis?.beats?.length || isRunning(JOB_KINDS.tempo)) return
  let edit = rescaleTempo(analysis, factor)
  const back = lastDouble
  if (
    factor === 0.5 &&
    back?.assetId === analysis.assetId &&
    sameTimes(analysis.beats, back.after.beats) &&
    sameTimes(analysis.downbeats, back.after.downbeats) &&
    sameTimes(edit.grid.beats, back.before.beats)
  ) {
    edit = { ...edit, grid: back.before }
  }
  const bpm = edit.grid.tempo?.bpm
  if (!bpm || bpm < TEMPO_LEVEL_RANGE.min || bpm > TEMPO_LEVEL_RANGE.max) return
  if (factor === 2) {
    const { tempo, beats, downbeats } = analysis
    lastDouble = { assetId: analysis.assetId, before: { tempo, beats, downbeats }, after: edit.grid }
  }
  const cleared = hasFoundBars(analysis) && !hasFoundBars(edit.grid)
  undoable(
    factor === 2 ? 'Double tempo' : 'Half tempo',
    `Tempo set to ${formatBpm(bpm)}${cleared ? '. Bars cleared: use Set first beat to start them again.' : ''}`,
    edit,
  )
}

/** Makes the beat nearest `time` the first beat of a bar and renumbers the bars from it. */
export function setFirstBeat(time: number): void {
  const analysis = songAnalysis(editor.getProject())
  const beats = analysis?.beats ?? []
  if (!analysis || !beats.length) return
  const index = nearestBeatIndex({ beats }, time)
  undoable(
    'Set first beat',
    `Bars now start on the beat at ${formatTime(beats[index] ?? time, true)}`,
    moveDownbeat(analysis, index),
  )
}

/**
 * Analyzes the song again (beats, bars, sections, energy) as one undo step; the sections the user named and the lyrics'
 * chorus are kept.
 */
export async function analyzeAgain(): Promise<void> {
  const songId = editor.getProject().songAssetId
  if (!songId || isRunning(JOB_KINDS.analysis)) return
  try {
    const analysis = await (await analysisService()).analyzeAgain(songId, () => songFile(songId)).promise
    const project = editor.getProject()
    if (project.songAssetId !== songId) return
    const { lyricChorusCommand, setAnalysisCommand } = await import('../../analysis/client.ts')
    const previous = project.analysis.audio[songId]?.sections ?? []
    const kept = previous.filter(isUserSection).length
    const merged = kept
      ? { ...analysis, sections: keepUserSections(analysis.sections ?? [], previous) }
      : analysis
    const chorus = project.lyrics ? lyricChorusCommand(merged, project.lyrics) : null
    const found = foundText(merged)
    undoable('Analyze again', kept ? `${found}. Kept ${plural(kept, 'section')} you named.` : found, [
      setAnalysisCommand(merged),
      ...(chorus ? [chorus] : []),
    ])
  } catch (error) {
    // Failures and their messages show in Assist › Song analysis, from the job.
    if (!(error instanceof JobError)) throw error
  }
}

/* ---------- bars ---------- */

/**
 * The song's bars as the timeline sees them. 'ready': found (by the refinement step or the user), with the bar
 * starts in timeline time. 'finding': the refinement step is running. 'unavailable': not found, because finding them
 * failed or was cancelled, background analysis is off, or the beats the user set leave no bars that fit. 'none': no
 * analyzed song. Until 'ready', nothing should cut, snap or count on bars; fall back to beats or wait (`ensureBars`).
 */
export type BarsState =
  | { status: 'ready'; downbeats: Seconds[] }
  | { status: 'finding' }
  | { status: 'unavailable' }
  | { status: 'none' }

type Attempt = 'running' | 'failed' | 'cancelled'

/** A refinement run for a song: whether it found bars, and its job once started (null if it never started one). */
interface Run {
  promise: Promise<boolean>
  job: Promise<JobHandle<unknown> | null>
}

let attempts: ReadonlyMap<Id, Attempt> = new Map()
const listeners = new Set<() => void>()
const runs = new Map<Id, Run>()

function setAttempt(songId: Id, attempt: Attempt | null): void {
  const next = new Map(attempts)
  if (attempt) next.set(songId, attempt)
  else next.delete(songId)
  attempts = next
  for (const l of listeners) l()
}

function subscribeBars(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Song (asset) times on the timeline, through the first enabled clip that plays the song; outside it they drop. */
function songTimesOnTimeline(project: Project, songId: Id, times: readonly Seconds[]): Seconds[] {
  const clip = Object.values(project.clips)
    .filter((c) => c.type === 'audio' && c.enabled && c.assetId === songId)
    .sort((a, b) => a.start - b.start)[0]
  if (!clip || clip.type !== 'audio') return [...times]
  const end = clip.start + clip.duration + 1e-6
  return times
    .map((t) => clip.start + (t - clip.sourceStart) / clip.playbackRate)
    .filter((t) => t >= clip.start - 1e-6 && t <= end)
}

/** The song's beats in timeline time (see `songTimesOnTimeline`); empty without analyzed beats. */
export function songBeatsOnTimeline(project: Project): Seconds[] {
  const songId = project.songAssetId
  const beats = songId ? project.analysis.audio[songId]?.beats : undefined
  return songId && beats ? songTimesOnTimeline(project, songId, beats) : []
}

/** How many of the sorted `times` are at or before `t`. */
function countUpTo(times: readonly Seconds[], t: Seconds): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] as number) <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Where `t` falls in the song's bars, all in timeline time: the bar (1 = the first bar found) and the beat in it
 * (1 = its downbeat). Null before the first bar.
 */
export function barPosition(
  downbeats: readonly Seconds[],
  beats: readonly Seconds[],
  t: Seconds,
): { bar: number; beat: number } | null {
  const bar = countUpTo(downbeats, t + 1e-3)
  if (bar === 0) return null
  const start = downbeats[bar - 1] as number
  return { bar, beat: countUpTo(beats, t + 1e-3) - countUpTo(beats, start + 1e-3) + 1 }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function barsOf(project: Project, current: ReadonlyMap<Id, Attempt>): BarsState {
  const songId = project.songAssetId
  const analysis = songId ? project.analysis.audio[songId] : undefined
  if (!songId || !analysis?.beats?.length) return { status: 'none' }
  if (analysis.downbeats && hasFoundBars(analysis))
    return { status: 'ready', downbeats: songTimesOnTimeline(project, songId, analysis.downbeats) }
  return current.get(songId) === 'running' ? { status: 'finding' } : { status: 'unavailable' }
}

/** The song's bars in `project` (see BarsState). */
export function barsState(project: Project = editor.getProject()): BarsState {
  return barsOf(project, attempts)
}

/** The open project's bars (see BarsState), updating as they are found. */
export function useBars(): BarsState {
  const project = useProject()
  const current = useSyncExternalStore(subscribeBars, () => attempts)
  return useMemo(() => barsOf(project, current), [project, current])
}

/**
 * Runs the refinement step for the song (job analysis.downbeats) and stores the bars it finds; see
 * `refinedBarsCommand` for how they land when the user changed the beats meanwhile. One run per song at a time.
 * `baseline` is the analysis the run starts from (default: the song's analysis now); `sections` lets the refined
 * sections replace untouched ones, for the run right after the first analysis. Resolves whether the song has bars.
 */
export function findBars(
  songId: Id,
  options: { baseline?: AudioAnalysis; sections?: boolean; quiet?: boolean } = {},
): Promise<boolean> {
  return startRun(songId, options).promise
}

function startRun(
  songId: Id,
  options: { baseline?: AudioAnalysis; sections?: boolean; quiet?: boolean },
): Run {
  const running = runs.get(songId)
  if (running) return running
  setAttempt(songId, 'running')
  let started: (job: JobHandle<unknown> | null) => void = () => {}
  const job = new Promise<JobHandle<unknown> | null>((resolve) => (started = resolve))
  const promise = (async () => {
    try {
      const baseline = options.baseline ?? editor.getProject().analysis.audio[songId]
      if (!baseline) return false
      const backend = await analysisService()
      const handle = backend.refine(songId, () => songFile(songId))
      started(handle)
      try {
        const refined = await handle.promise
        const now = editor.getProject().analysis.audio[songId]
        if (!now) return false
        const { chorusEdgesCommand, lyricChorusCommand, refinedBarsCommand } =
          await import('../../analysis/client.ts')
        const lyrics = editor.getProject().lyrics
        const chorus = (a: AudioAnalysis) => (lyrics ? lyricChorusCommand(a, lyrics) : null)
        const relabeled = chorus(baseline)
        // Sections the lyrics' chorus relabeled are still the detected ones: the refined sections replace them and the
        // chorus is found again on those.
        const detected =
          sameJson(now.sections, baseline.sections) ||
          (relabeled?.type === 'analysis.setRefined' && sameJson(now.sections, relabeled.refined.sections))
        const from = detected ? { ...baseline, sections: now.sections } : baseline
        const command = refinedBarsCommand(now, from, refined, { sections: options.sections })
        if (command) dispatch(command, { history: 'skip' })
        const after = editor.getProject().analysis.audio[songId]
        if (command && hasFoundBars(after)) {
          const fresh = !sameJson(after.sections, now.sections)
          const next = fresh ? chorus(after) : chorusEdgesCommand(after)
          if (next) dispatch(next, { history: 'skip' })
        }
      } finally {
        void backend.release(songId).catch(() => undefined)
      }
      return hasFoundBars(editor.getProject().analysis.audio[songId])
    } finally {
      started(null)
    }
  })().then(
    (found) => {
      setAttempt(songId, found ? null : 'failed')
      return found
    },
    (error: unknown) => {
      const cancelled = error instanceof JobError && error.code === 'cancelled'
      setAttempt(songId, cancelled ? 'cancelled' : 'failed')
      if (!(error instanceof JobError)) throw error
      if (!cancelled && !options.quiet)
        toast(`${BARS_NOTES.notFound}. ${error.message} ${BARS_NOTES.analyzeAgain}`)
      return false
    },
  )
  const run = { promise, job }
  runs.set(songId, run)
  const forget = () => {
    if (runs.get(songId) === run) runs.delete(songId)
  }
  promise.then(forget, forget)
  return run
}

/**
 * Waits until the song has bars, for a job the user started that needs them (auto-cut, the director): resolves at
 * once when they are found, follows the refinement step when it is running, and starts it otherwise (also where
 * background analysis is off, because the user asked). `progress` gets the step's fraction (0..1). Cancelling
 * `signal` stops waiting and cancels a step this call started. Resolves whether the song has bars; without them,
 * plan on beats and say so.
 */
export async function ensureBars(
  options: { signal?: AbortSignal; progress?: (fraction: number) => void } = {},
): Promise<boolean> {
  const project = editor.getProject()
  const songId = project.songAssetId
  const analysis = songId ? project.analysis.audio[songId] : undefined
  if (!songId || !analysis?.beats?.length) return false
  if (hasFoundBars(analysis)) return true
  const { signal, progress } = options
  const ours = !runs.has(songId)
  const run = startRun(songId, { quiet: true })
  let done = false
  const cleanups: (() => void)[] = []
  void run.job.then((job) => {
    if (!job || done) return
    if (progress) {
      cleanups.push(job.subscribe((s) => progress(s.progress.fraction ?? 0)))
      progress(job.snapshot().progress.fraction ?? 0)
    }
    if (ours && signal) {
      const cancel = () => job.cancel()
      if (signal.aborted) cancel()
      signal.addEventListener('abort', cancel, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', cancel))
    }
  })
  try {
    if (!signal) return await run.promise
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new JobError('cancelled', 'Cancelled'))
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
    return await Promise.race([run.promise, aborted])
  } finally {
    done = true
    for (const cleanup of cleanups) cleanup()
  }
}

/**
 * Finds the bars of the open project's song whenever it has beats but none, while background analysis is on: after
 * opening a project saved before they were found, or once the user's tempo change left none that fit. A song is
 * tried once per session unless the user asks again (`ensureBars`, Analyze again). Returns stop watching.
 */
export function findBarsInBackground(): () => void {
  const check = () => {
    const project = editor.getProject()
    const songId = project.songAssetId
    const analysis = songId ? project.analysis.audio[songId] : undefined
    if (!songId || !analysis?.beats?.length || hasFoundBars(analysis)) return
    if (attempts.has(songId) || !backgroundAnalysisOn()) return
    void findBars(songId)
  }
  check()
  return editor.subscribe(check)
}
