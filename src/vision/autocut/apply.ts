/**
 * Puts an auto-cut on the timeline: its own "Auto-cut" track, clips tagged with `meta.autocut`, one undo step.
 * Running it again replaces only auto-cut clips nobody has touched; clips the user made or edited on that track
 * stay and the new cut goes around them. A locked Auto-cut track is kept as is and the new cut goes on a new track.
 */
import type { EditCommand } from '../../model/commands.ts'
import { anim, createImageClip, createTrack, createVideoClip } from '../../model/factory.ts'
import { clipsOnTrack } from '../../model/queries.ts'
import type { Clip, Id, JsonObject, Project, Seconds, Track, VisualClip } from '../../model/types.ts'
import type { TimeRange } from '../types.ts'
import type { PickReason } from './choose.ts'

export const AUTOCUT_META_KEY = 'autocut'
export const AUTOCUT_TRACK_NAME = 'Auto-cut'
const EPS = 1e-3
const round3 = (t: number) => Math.round(t * 1000) / 1000

export interface AutoCutShot {
  /** Timeline seconds. */
  start: Seconds
  end: Seconds
  assetId: Id
  sourceStart: Seconds
  playbackRate: number
  sectionId: Id
  reason: PickReason
  lyricLineId?: Id
  score?: number
}

interface AutoCutClipMeta {
  v: 1
  /** The run that made the clip. */
  run: string
  /** Fingerprint of the clip as auto-cut made it; a clip that no longer matches was edited by the user. */
  fp: string
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** FNV-1a of everything the user can change about a clip (not its id, track or provenance). */
export function clipFingerprint(clip: Clip): string {
  const { id: _id, trackId: _track, meta: _meta, ...rest } = clip
  const text = stableStringify(rest)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function autoCutMeta(clip: Clip): AutoCutClipMeta | undefined {
  const m = clip.meta?.[AUTOCUT_META_KEY]
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined
  const { run, fp } = m as Record<string, unknown>
  return typeof run === 'string' && typeof fp === 'string' ? { v: 1, run, fp } : undefined
}

/** An auto-cut clip exactly as auto-cut left it, so running auto-cut again may replace it. */
export function isUntouchedAutoCut(clip: Clip): boolean {
  const meta = autoCutMeta(clip)
  return !!meta && meta.fp === clipFingerprint(clip)
}

export interface TrackState {
  /** Existing Auto-cut track to use, or undefined to add one at `newIndex`. */
  track?: Track
  newIndex: number
  /** A locked Auto-cut track that is kept as is. */
  lockedTrack?: Track
  /** Clips on the track that auto-cut may replace. */
  replaceable: Clip[]
  /** Clips on the track that stay: made or edited by the user. */
  kept: Clip[]
}

const isAutoCutTrack = (project: Project, track: Track) => {
  if (track.kind !== 'visual') return false
  const clips = clipsOnTrack(project, track.id)
  return clips.some((c) => autoCutMeta(c)) || (clips.length === 0 && track.name === AUTOCUT_TRACK_NAME)
}

/** The Auto-cut track auto-cut writes to, and which of its clips it may replace. */
export function autoCutTrackState(project: Project): TrackState {
  const candidates = project.tracks.filter((t) => isAutoCutTrack(project, t))
  const track = candidates.find((t) => !t.locked)
  if (track) {
    const clips = clipsOnTrack(project, track.id)
    return {
      track,
      newIndex: project.tracks.indexOf(track),
      replaceable: clips.filter(isUntouchedAutoCut),
      kept: clips.filter((c) => !isUntouchedAutoCut(c)),
    }
  }
  const lockedTrack = candidates[0]
  let newIndex: number
  if (lockedTrack) newIndex = project.tracks.indexOf(lockedTrack)
  else {
    // Above the topmost footage, so the cut is what shows; with no footage, at the bottom of the visual stack.
    const footage = project.tracks.findIndex(
      (t) =>
        t.kind === 'visual' &&
        clipsOnTrack(project, t.id).some((c) => c.type === 'video' || c.type === 'image'),
    )
    const lastVisual = project.tracks.map((t) => t.kind).lastIndexOf('visual')
    newIndex = footage >= 0 ? footage : lastVisual + 1
  }
  return { newIndex, ...(lockedTrack ? { lockedTrack } : {}), replaceable: [], kept: [] }
}

/** `range` grown to cover replaceable clips that cross its edges, so no auto-cut clip is left cut in half. */
export function expandRange(range: TimeRange, replaceable: readonly Clip[]): TimeRange {
  let { start, end } = range
  for (let changed = true; changed;) {
    changed = false
    for (const c of replaceable) {
      const cEnd = c.start + c.duration
      if (c.start < start - EPS && cEnd > start + EPS) {
        start = c.start
        changed = true
      }
      if (cEnd > end + EPS && c.start < end - EPS) {
        end = cEnd
        changed = true
      }
    }
  }
  return { start, end }
}

export interface AutoCutCompiled {
  commands: EditCommand[]
  /** Undo menu label. */
  label: string
  stats: {
    cuts: number
    /** Earlier auto-cut clips replaced. */
    replaced: number
    /** Clips on the Auto-cut track that were kept because the user made or edited them. */
    kept: number
    newTrack: boolean
  }
  warnings: string[]
}

/** EditCommands for an auto-cut, against the project as it is now. Dispatch them as one undo step. */
export function compileAutoCut(
  project: Project,
  plan: { id: string; range: TimeRange; shots: readonly AutoCutShot[] },
): AutoCutCompiled {
  const state = autoCutTrackState(project)
  const warnings: string[] = []
  const commands: EditCommand[] = []
  let trackId = state.track?.id
  if (!trackId) {
    const track = createTrack('visual', AUTOCUT_TRACK_NAME)
    commands.push({ type: 'track.add', track, index: state.newIndex })
    trackId = track.id
    if (state.lockedTrack)
      warnings.push('The Auto-cut track is locked, so the new cut is on a new track above it.')
  }
  const range = expandRange(plan.range, state.replaceable)
  const inRange = (c: { start: number; duration: number }) =>
    c.start < range.end - EPS && c.start + c.duration > range.start + EPS
  const replaced = state.replaceable.filter(inRange)
  if (replaced.length) commands.push({ type: 'clip.remove', clipIds: replaced.map((c) => c.id) })
  const keptInRange = state.kept.filter(inRange)
  if (keptInRange.length) {
    const n = keptInRange.length
    warnings.push(`Kept ${n} ${n === 1 ? 'clip' : 'clips'} you made or edited on the Auto-cut track.`)
  }

  let cuts = 0
  let missing = false
  for (const shot of [...plan.shots].sort((a, b) => a.start - b.start)) {
    const duration = round3(shot.end - shot.start)
    const blocked = state.kept.some(
      (c) => shot.start < c.start + c.duration - EPS && shot.end > c.start + EPS,
    )
    const asset = project.assets[shot.assetId]
    if (!asset || (asset.kind !== 'video' && asset.kind !== 'image')) missing = true
    if (blocked || !asset || (asset.kind !== 'video' && asset.kind !== 'image') || duration <= EPS) continue
    const base = { trackId, assetId: asset.id, start: round3(shot.start), duration }
    let clip: VisualClip
    if (asset.kind === 'video') {
      clip = {
        ...createVideoClip({ ...base, sourceStart: round3(shot.sourceStart) }),
        playbackRate: shot.playbackRate,
        // The song is the soundtrack; the user can unmute a clip to hear its own sound.
        muted: true,
        volume: anim(1),
      }
    } else clip = createImageClip(base)
    clip.name = asset.name
    const meta: JsonObject = { v: 1, run: plan.id, fp: clipFingerprint(clip) }
    clip.meta = { [AUTOCUT_META_KEY]: meta }
    commands.push({ type: 'clip.add', clip })
    cuts++
  }
  if (missing)
    warnings.push('Some planned clips use media that is no longer in the project and were left out.')
  return {
    commands,
    label: `Auto-cut: ${cuts} ${cuts === 1 ? 'cut' : 'cuts'}`,
    stats: { cuts, replaced: replaced.length, kept: keptInRange.length, newTrack: !state.track },
    warnings,
  }
}
