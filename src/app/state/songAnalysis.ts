import { useMemo, useSyncExternalStore } from 'react'
import { nearestBeatIndex } from '../../analysis/beats/grid.ts'
import type { SongAnalysisService } from '../../analysis/client.ts'
import { fitTappedTempo, moveDownbeat } from '../../analysis/edits.ts'
import type { AudioAnalysis, EditCommand, Id, Project, Seconds } from '../../model/index.ts'
import { JobError, type JobHandle } from '../../shared/jobs.ts'
import { formatBpm, formatTime, plural } from '../format.ts'
import { backgroundAnalysisOn } from './footage.ts'
import { isRunning, JOB_KINDS } from './jobs.ts'
import { dispatch, editor, songAnalysis, useProject } from './project.ts'
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

/** Analyzes the song again (beats, bars, sections, energy) as one undo step; the lyrics' chorus is kept. */
export async function analyzeAgain(): Promise<void> {
  const songId = editor.getProject().songAssetId
  if (!songId || isRunning(JOB_KINDS.analysis)) return
  try {
    const analysis = await (await analysisService()).analyzeAgain(songId, () => songFile(songId)).promise
    const project = editor.getProject()
    if (project.songAssetId !== songId) return
    const { lyricChorusCommand, setAnalysisCommand } = await import('../../analysis/client.ts')
    const chorus = project.lyrics ? lyricChorusCommand(analysis, project.lyrics) : null
    const sections = analysis.sections?.length ?? 0
    const bpm = analysis.tempo ? formatBpm(analysis.tempo.bpm) : 'the beat'
    undoable('Analyze again', `Found ${bpm} and ${plural(sections, 'section')}`, [
      setAnalysisCommand(analysis),
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
function toTimeline(project: Project, songId: Id, times: readonly Seconds[]): Seconds[] {
  const clip = Object.values(project.clips)
    .filter((c) => c.type === 'audio' && c.enabled && c.assetId === songId)
    .sort((a, b) => a.start - b.start)[0]
  if (!clip || clip.type !== 'audio') return [...times]
  const end = clip.start + clip.duration + 1e-6
  return times
    .map((t) => clip.start + (t - clip.sourceStart) / clip.playbackRate)
    .filter((t) => t >= clip.start - 1e-6 && t <= end)
}

function barsOf(project: Project, current: ReadonlyMap<Id, Attempt>): BarsState {
  const songId = project.songAssetId
  const analysis = songId ? project.analysis.audio[songId] : undefined
  if (!songId || !analysis?.beats?.length) return { status: 'none' }
  if (analysis.downbeats?.length)
    return { status: 'ready', downbeats: toTimeline(project, songId, analysis.downbeats) }
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
        const { refinedBarsCommand } = await import('../../analysis/client.ts')
        const command = refinedBarsCommand(now, baseline, refined, { sections: options.sections })
        if (command) dispatch(command, { history: 'skip' })
      } finally {
        void backend.release(songId).catch(() => undefined)
      }
      return Boolean(editor.getProject().analysis.audio[songId]?.downbeats?.length)
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
        toast(`Could not find the bars, so the first analysis is kept. ${error.message}`)
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
  if (analysis.downbeats?.length) return true
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
    if (!songId || !analysis?.beats?.length || analysis.downbeats?.length) return
    if (attempts.has(songId) || !backgroundAnalysisOn()) return
    void findBars(songId)
  }
  check()
  return editor.subscribe(check)
}
