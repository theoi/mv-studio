/**
 * How long an output takes to export on this device, worked out before it runs. What a frame costs depends on the
 * project far more than on its size: on a 4-core machine without a GPU, a 1080p frame of the sample project (a look,
 * lyrics with shadows, visualizers) takes about 0.6 s to render and encode, one of a clip and a photo about 0.05 s.
 * So no fixed frame rate fits. Instead the render worker draws and encodes a few short runs of the output's own frames
 * (probeExport): spread over its range, in the looks (what is drawn, see frameLooks) that take most of its frames, at
 * its busiest look, in a transition, and for a loop in its crossfade. Each look's frames take the pace measured in it;
 * a look no run measured takes the slowest pace. After an export, its own pace is kept per project and frame size, shown at once
 * the next time and never undercut by a trial.
 */
import type { ExportProbe } from '../engine/encode.ts'
import { probeExport } from '../engine/export.ts'
import { planFrame, type LayerPlan } from '../engine/layout.ts'
import type { MediaFileSource } from '../engine/types.ts'
import type { Id, Project, VisualClip } from '../model/types.ts'
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
/** A transition's own cost on top of its two clips: it draws both into textures and blends them in a shader. */
const TRANSITION_BUSYNESS = 3

function clipBusyness(clip: VisualClip): number {
  let score = 1 + 2 * clip.effects.filter((e) => e.enabled).length
  if (clip.adjustments) score += 1
  if (clip.matte) score += 1
  if (clip.type === 'text') score += clip.style.shadow ? 3 : 1
  if (clip.type === 'generator') score += 2
  if (clip.type === 'adjustment') score += 1
  return score
}

function layerBusyness(layer: LayerPlan): number {
  if (layer.kind !== 'transition') return clipBusyness(layer.clip)
  const from = layer.from ? clipBusyness(layer.from) : 0
  const to = layer.to ? clipBusyness(layer.to) : 0
  return TRANSITION_BUSYNESS + from + to
}

/**
 * What a clip draws, as far as it decides the cost: its kind, source, enabled effects, adjustments and matte. Footage
 * and photos count by their type and size: decoding and drawing one costs about what another of the same size does.
 */
function clipLook(clip: VisualClip, assets: Project['assets']): string {
  const asset = clip.type === 'video' || clip.type === 'image' ? assets[clip.assetId] : undefined
  const source =
    clip.type === 'video' || clip.type === 'image'
      ? asset?.width && asset.height
        ? `${asset.mimeType}@${asset.width}x${asset.height}`
        : clip.assetId
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

/** What a layer of the compositor's plan draws: a clip's look, or a transition's kind and both its clips' looks. */
function layerLook(layer: LayerPlan, assets: Project['assets']): string {
  if (layer.kind !== 'transition') return clipLook(layer.clip, assets)
  const from = layer.from ? clipLook(layer.from, assets) : ''
  const to = layer.to ? clipLook(layer.to, assets) : ''
  return `transition:${layer.transition.kind}(${from} > ${to})`
}

/** Frames with the same look, by `frameLooks`. */
interface Look {
  renders: number
  busyness: number
  /** Whether its frames draw a transition. */
  transition: boolean
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
 * Each frame's look: what its renders draw (by the compositor's plan, so with solo tracks and transitions), as far as
 * that decides what they cost. Frames of a look cost about the same whatever the words of a lyric line or the frame
 * of a clip, so one trial run stands for all of them.
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
    const drawn = times.map((t) => planFrame(project, t))
    const key = drawn
      .map((layers) =>
        layers
          .map((l) => layerLook(l, project.assets))
          .sort()
          .join('|'),
      )
      .join(' + ')
    keys.push(key)
    let look = looks.get(key)
    if (!look) {
      const busy = Math.max(...drawn.map((layers) => layers.reduce((sum, l) => sum + layerBusyness(l), 0)))
      const transition = drawn.some((layers) => layers.some((l) => l.kind === 'transition'))
      look = { renders: 0, busyness: busy, transition, longest: { start: i, length: 0 } }
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
 * end of the range, in the looks that take the most renders, the busiest look and the transition look with the
 * longest stretch (each in the middle of its longest stretch), and for a loop at its end, where frames blend two
 * renders. Transitions get a run of their own because they sit at the edges of clips, where no other run goes.
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
  const transitions = looks.filter((l) => l.transition)
  if (transitions.length)
    picked.add(transitions.reduce((x, y) => (y.longest.length > x.longest.length ? y : x)))
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
  const lookOf = (w: ExportProbe['windows'][number]) => keys[w.first + 1] ?? keys[w.first] ?? ''
  const timed = trial.windows.filter((w) => w.renders > 0)
  const paces = new Map<string, number>()
  for (const [i, w] of timed.entries()) {
    const key = lookOf(w)
    // The renderer is still warming up past the first run's first frame (its frames took about 1.4 times what a
    // later run's took in the same look), so a look that a later run also timed takes that run's pace.
    if (i === 0 && timed.slice(1).some((o) => lookOf(o) === key)) continue
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
