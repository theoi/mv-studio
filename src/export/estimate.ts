/**
 * How long an output takes to export on this device, worked out before it runs. What a frame costs depends on the
 * project far more than on its size: on a 4-core machine without a GPU, a 1080p frame of the sample project (a look,
 * lyrics with shadows, visualizers) takes about 0.6 s to render and encode, one of a clip and a photo about 0.05 s.
 * So no fixed frame rate fits. Instead the render worker draws and encodes a few short runs of the output's own frames
 * (probeExport): spread over its range, in the looks (what is drawn, see frameLooks) that take most of its frames, at
 * its busiest look, and for a loop in its crossfade. Each look's frames take the pace measured in it; a look no run
 * measured takes the slowest pace. After an export, its own pace is kept per project and frame size, shown at once
 * the next time and never undercut by a trial.
 */
import type { ExportProbe } from '../engine/encode.ts'
import { probeExport } from '../engine/export.ts'
import type { MediaFileSource } from '../engine/types.ts'
import { clipsAt } from '../model/queries.ts'
import type { Id, Project, Seconds, VisualClip } from '../model/types.ts'
import type { PlannedOutput } from './outputs.ts'

/** Frames in each trial run. Its first frame seeks the decoders (and in the first run warms up), so it is timed apart. */
const RUN_FRAMES = 4
/**
 * On top of a trial's pace: the export runs while the page shows its progress, and on a machine without a GPU the
 * compositor shares the GPU process with the export (about 1.15 times slower than the trial on a 4-core machine);
 * runs also vary, and a few runs can miss a costly moment.
 */
const TRIAL_MARGIN = 1.4
/** On top of a past export's pace, which already includes all of that: run-to-run variation only. */
const REMEMBERED_MARGIN = 1.15
/** Besides rendering: checking the encoder, removing old exports, finishing the file and reading it back. */
const FIXED_SECONDS = 2
/** Mixing the audio on the main thread before rendering, per second of output. */
const MIX_SECONDS_PER_SECOND = 0.02
/** A remembered pace is used while the project's busyness has changed less than this share since it was measured. */
const SAME_PROJECT = 0.25
/** Looks that get a trial run of their own, besides the busiest: those that take the most renders. */
const LOOK_RUNS = 3

/** The clips drawn at `time`. */
function drawnAt(project: Project, time: Seconds): VisualClip[] {
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id))
  return clipsAt(project, time).filter((c): c is VisualClip => c.type !== 'audio' && !hidden.has(c.trackId))
}

function clipBusyness(clip: VisualClip): number {
  let score = 1 + 2 * clip.effects.filter((e) => e.enabled).length
  if (clip.adjustments) score += 1
  if (clip.matte) score += 1
  if (clip.type === 'text') score += clip.style.shadow ? 3 : 1
  if (clip.type === 'generator') score += 2
  if (clip.type === 'adjustment') score += 1
  return score
}

/** How much is drawn at `time`, roughly: layers, effects, text and generators. */
export function busyness(project: Project, time: Seconds): number {
  return drawnAt(project, time).reduce((sum, clip) => sum + clipBusyness(clip), 0)
}

/** What a clip draws, as far as it decides the cost: its kind, source, enabled effects, adjustments and matte. */
function clipLook(clip: VisualClip): string {
  const source =
    clip.type === 'video' || clip.type === 'image'
      ? clip.assetId
      : clip.type === 'generator'
        ? clip.generatorId
        : clip.type === 'text' && clip.style.shadow
          ? 'shadow'
          : ''
  const effects = clip.effects.filter((e) => e.enabled).map((e) => e.effectId)
  return [
    clip.type,
    source,
    effects.join(','),
    clip.adjustments ? 'adjusted' : '',
    clip.matte ? 'matte' : '',
  ].join(':')
}

/** Frames with the same look, by `frameLooks`. */
interface Look {
  renders: number
  busyness: number
  /** Its longest stretch of consecutive frames. */
  longest: { start: number; length: number }
}

interface FrameLooks {
  keys: string[]
  looks: Map<string, Look>
}

/** Planned outputs are not changed once made, and the export dialog asks about the same ones on every render. */
const lookCache = new WeakMap<PlannedOutput, FrameLooks>()

/**
 * Each frame's look: what its renders draw, as far as that decides what they cost. Frames of a look cost about the
 * same whatever the words of a lyric line or the frame of a clip, so one trial run stands for all of them.
 */
function frameLooks(planned: PlannedOutput): FrameLooks {
  const known = lookCache.get(planned)
  if (known) return known
  const { project, range, frames, spec } = planned
  const frameTimes = planned.exportOptions.frameTimes
  const keys: string[] = []
  const looks = new Map<string, Look>()
  let stretch = 0
  for (let i = 0; i < frames; i++) {
    const times = frameTimes ? frameTimes(i / spec.fps).map((l) => l.time) : [range.start + i / spec.fps]
    const drawn = times.map((t) => drawnAt(project, t))
    const key = drawn.map((clips) => clips.map(clipLook).sort().join('|')).join(' + ')
    keys.push(key)
    let look = looks.get(key)
    if (!look) {
      const busy = Math.max(...drawn.map((clips) => clips.reduce((sum, c) => sum + clipBusyness(c), 0)))
      look = { renders: 0, busyness: busy, longest: { start: i, length: 0 } }
      looks.set(key, look)
    }
    look.renders += times.length
    stretch = i > 0 && keys[i - 1] === key ? stretch + 1 : 1
    if (stretch > look.longest.length) look.longest = { start: i - stretch + 1, length: stretch }
  }
  const result = { keys, looks }
  lookCache.set(planned, result)
  return result
}

/** How busy the output's renders are on average. */
function meanBusyness(planned: PlannedOutput): number {
  let sum = 0
  let renders = 0
  for (const look of frameLooks(planned).looks.values()) {
    sum += look.busyness * look.renders
    renders += look.renders
  }
  return sum / Math.max(1, renders)
}

/**
 * The frames a trial renders, as runs of consecutive output frames in increasing order: near the start, middle and
 * end of the range, in the looks that take the most renders and the busiest look (each in the middle of its longest
 * stretch), and for a loop at its end, where frames blend two renders.
 */
export function trialRuns(planned: PlannedOutput): number[][] {
  const { frames, range } = planned
  const n = Math.min(RUN_FRAMES, frames)
  const clamp = (i: number) => Math.min(frames - n, Math.max(0, i))
  const duration = range.end - range.start
  const starts = [0.1, 0.5, 0.9].map((f) => clamp(Math.round(f * duration * planned.spec.fps)))
  const looks = [...frameLooks(planned).looks.values()]
  const picked = new Set([...looks].sort((x, y) => y.renders - x.renders).slice(0, LOOK_RUNS))
  const busiest = looks.reduce((x, y) => (y.busyness > x.busyness ? y : x), looks[0]!)
  picked.add(busiest)
  for (const { longest } of picked) starts.push(clamp(longest.start + Math.floor((longest.length - n) / 2)))
  if (planned.loop && planned.loop.crossfade > 0) starts.push(frames - n)
  const runs: number[][] = []
  for (const s of [...new Set(starts)].sort((x, y) => x - y)) {
    const last = runs.at(-1)?.at(-1)
    if (last !== undefined && s <= last) continue
    runs.push(Array.from({ length: n }, (_, k) => s + k))
  }
  return runs
}

/** Compositor renders the whole output takes: one per frame, more where a loop blends. */
function renderCount(planned: PlannedOutput): number {
  let renders = 0
  for (const look of frameLooks(planned).looks.values()) renders += look.renders
  return renders
}

/** Footage and photo clips the output cuts to after its first frame; each makes the renderer seek or load. */
function cutCount(planned: PlannedOutput): number {
  const { start, end } = planned.range
  return Object.values(planned.project.clips).filter(
    (c) => (c.type === 'video' || c.type === 'image') && c.enabled && c.start > start && c.start < end,
  ).length
}

function hasAudio(planned: PlannedOutput): boolean {
  return planned.exportOptions.audio !== 'none'
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Seconds the output takes to export, from a trial of some of its frames on this device. */
export function estimateFromTrial(planned: PlannedOutput, trial: ExportProbe): number {
  const { keys, looks } = frameLooks(planned)
  // A run's frames after its first are timed; they stand for their look.
  const paces = new Map<string, number>()
  for (const w of trial.windows) {
    if (!(w.renders > 0)) continue
    const key = keys[w.first + 1] ?? keys[w.first] ?? ''
    paces.set(key, Math.max(paces.get(key) ?? 0, w.ms / w.renders))
  }
  const slowest = Math.max(0, ...paces.values())
  const paceOf = (key: string) => paces.get(key) ?? slowest
  let framesMs = 0
  for (const [key, look] of looks) framesMs += look.renders * paceOf(key)
  const [first, ...rest] = trial.windows
  // A run's first frame costs its renders plus a seek; after the first run (which also warms up), that seek stands
  // for what each cut to another clip costs.
  const seekMs = median(rest.map((w) => Math.max(0, w.firstMs - paceOf(keys[w.first] ?? ''))))
  const renderMs =
    trial.setupMs + (first?.firstMs ?? 0) + framesMs + cutCount(planned) * seekMs + trial.flushMs
  const other = FIXED_SECONDS + (hasAudio(planned) ? MIX_SECONDS_PER_SECOND * planned.duration : 0)
  return TRIAL_MARGIN * (renderMs / 1000 + other)
}

/** A finished export's pace: its whole time per compositor render, and how busy its frames were. */
export interface ExportPace {
  secondsPerRender: number
  busyness: number
}

/** Where paces of finished exports are kept between sessions, by project and frame size (`paceKey`). */
export interface ExportPaceStore {
  get(projectId: Id, key: string): ExportPace | undefined
  set(projectId: Id, key: string, pace: ExportPace): void
}

export function paceKey(planned: PlannedOutput): string {
  const { width, height, fps } = planned.settings
  return `${width}x${height}@${fps}`
}

const PACE_KEY = 'mv-studio.export-pace'
/** Projects whose paces are kept; the least recently exported go first. */
const PACE_PROJECTS = 30

type StoredPaces = Record<Id, { at: number; paces: Record<string, ExportPace> }>

function readPaces(): StoredPaces {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(PACE_KEY) ?? '{}')
    return stored && typeof stored === 'object' ? (stored as StoredPaces) : {}
  } catch {
    return {}
  }
}

/** Paces in this browser's localStorage; reads and writes that fail (no storage, private mode) are ignored. */
export const localExportPaceStore: ExportPaceStore = {
  get(projectId, key) {
    const pace = readPaces()[projectId]?.paces[key]
    return typeof pace?.secondsPerRender === 'number' && typeof pace.busyness === 'number' ? pace : undefined
  },
  set(projectId, key, pace) {
    const all = readPaces()
    all[projectId] = { at: Date.now(), paces: { ...all[projectId]?.paces, [key]: pace } }
    const kept = Object.entries(all)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, PACE_PROJECTS)
    try {
      globalThis.localStorage?.setItem(PACE_KEY, JSON.stringify(Object.fromEntries(kept)))
    } catch {
      // Estimates keep coming from trials.
    }
  },
}

/** Keeps how long an output of `projectId` took, for estimates of its next exports at that frame size. */
export function rememberPace(
  projectId: Id,
  planned: PlannedOutput,
  seconds: number,
  store: ExportPaceStore = localExportPaceStore,
): void {
  if (!(seconds > 0)) return
  store.set(projectId, paceKey(planned), {
    secondsPerRender: seconds / renderCount(planned),
    busyness: meanBusyness(planned),
  })
}

/**
 * Seconds the output takes at the pace an earlier export of this project at this frame size had, or null when there
 * was none or the project has changed much since.
 */
export function rememberedEstimate(
  projectId: Id,
  planned: PlannedOutput,
  store: ExportPaceStore = localExportPaceStore,
): number | null {
  const pace = store.get(projectId, paceKey(planned))
  if (!pace) return null
  const now = meanBusyness(planned)
  if (Math.abs(now - pace.busyness) > SAME_PROJECT * Math.max(pace.busyness, 1)) return null
  return REMEMBERED_MARGIN * renderCount(planned) * pace.secondsPerRender
}

/** Runs a trial of the output in a render worker and estimates its export time; null when no trial can run. */
export async function estimateOutput(
  planned: PlannedOutput,
  options: { signal: AbortSignal; media?: MediaFileSource },
): Promise<number | null> {
  const trial = await probeExport(planned.project, planned.settings, trialRuns(planned), {
    media: options.media,
    frameTimes: planned.exportOptions.frameTimes,
    signal: options.signal,
  })
  return trial && estimateFromTrial(planned, trial)
}
