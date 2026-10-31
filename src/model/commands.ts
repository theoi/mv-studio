/**
 * Edit commands: the single way to change a project. Commands are serializable data, so the UI, director, VJ
 * recording and plain-language commands all produce the same thing, and every change is undoable.
 * Apply them through ProjectEditor (./editor.ts); applyCommand() is the pure reducer behind it.
 */
import type { Draft } from 'immer'
import {
  STEM_NAMES,
  type Asset,
  type AudioAnalysis,
  type Clip,
  type ClipAudioSource,
  type EffectInstance,
  type Id,
  type JsonValue,
  type Keyframe,
  type LyricLine,
  type LyricsDoc,
  type Marker,
  type ParamValue,
  type Project,
  type ProjectSettings,
  type Seconds,
  type SongSection,
  type Track,
  type VisualAnalysis,
} from './types.ts'

/** The fields a beat refinement owns. */
export type RefinedAnalysis = Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats' | 'sections'>

/** Path from a clip to a property, e.g. ['transform', 'x'] or ['effects', 0, 'params', 'radius']. */
export type PropertyPath = (string | number)[]

export type EditCommand =
  | { type: 'project.rename'; name: string }
  | { type: 'project.updateSettings'; settings: Partial<ProjectSettings> }
  | { type: 'project.setSong'; assetId: Id | null }
  | { type: 'project.setDuration'; duration: Seconds | null }
  /** Sets (or with null, removes) the feature-owned entry project.extensions[key]. */
  | { type: 'project.setExtension'; key: string; value: JsonValue | null }
  | { type: 'asset.add'; asset: Asset }
  | { type: 'asset.rename'; assetId: Id; name: string }
  /** Removes the asset and every clip that uses it. */
  | { type: 'asset.remove'; assetId: Id }
  | { type: 'track.add'; track: Track; index?: number }
  /** Removes the track and its clips. */
  | { type: 'track.remove'; trackId: Id }
  | { type: 'track.update'; trackId: Id; patch: Partial<Omit<Track, 'id' | 'kind'>> }
  | { type: 'track.move'; trackId: Id; toIndex: number }
  | { type: 'clip.add'; clip: Clip }
  | { type: 'clip.remove'; clipIds: Id[] }
  | { type: 'clip.move'; moves: { clipId: Id; start: Seconds; trackId?: Id }[] }
  /** Sets a clip's timeline span. For media clips, moving the start edge shifts sourceStart by the same amount. */
  | { type: 'clip.trim'; clipId: Id; start: Seconds; duration: Seconds }
  /** Splits at an absolute timeline time; the right part gets newClipId. */
  | { type: 'clip.split'; clipId: Id; time: Seconds; newClipId: Id }
  /** Sets any property by path, e.g. ['transform', 'x', 'value'] or ['style', 'color']. */
  /** `value` must be JSON-serializable. */
  | { type: 'clip.set'; clipId: Id; path: PropertyPath; value: unknown }
  /** Picks the audio a generator clip reacts to, e.g. { stem: 'drums' }; null goes back to the song's full mix. */
  | { type: 'clip.setAudioSource'; clipId: Id; source: ClipAudioSource | null }
  /** Adds or replaces (same time) a keyframe on the Animatable at `path`. */
  | { type: 'keyframe.set'; clipId: Id; path: PropertyPath; keyframe: Keyframe<ParamValue> }
  | { type: 'keyframe.remove'; clipId: Id; path: PropertyPath; time: Seconds }
  | { type: 'effect.add'; clipId: Id; effect: EffectInstance; index?: number }
  | { type: 'effect.remove'; clipId: Id; effectInstanceId: Id }
  | { type: 'effect.move'; clipId: Id; effectInstanceId: Id; toIndex: number }
  | { type: 'marker.add'; marker: Marker }
  | { type: 'marker.update'; markerId: Id; patch: Partial<Omit<Marker, 'id'>> }
  | { type: 'marker.remove'; markerId: Id }
  /** Replaces an asset's whole analysis. Background jobs use the narrow commands below instead. */
  | { type: 'analysis.setAudio'; analysis: AudioAnalysis }
  /**
   * A fresh analysis of an audio asset (everything but stems), keeping any stems already attached. It replaces the
   * user's corrections, so `history: 'skip'` is only for the first analysis after import; a re-analysis the user asks
   * for is a normal, undoable dispatch.
   */
  | { type: 'analysis.setDetected'; analysis: Omit<AudioAnalysis, 'stems' | 'stemFeatures'> }
  /**
   * Refined beat grid and sections, applied only where the analysis still equals `baseline` (the result the
   * refinement started from), so corrections the user made in the meantime are kept. Background results.
   */
  | { type: 'analysis.setRefined'; assetId: Id; refined: RefinedAnalysis; baseline: RefinedAnalysis }
  /**
   * Separated stems (asset ids) and their features. Background results. Without an analysis it creates an entry
   * with only stems and an empty version (not analyzed), rather than failing and orphaning the stem assets.
   */
  | {
      type: 'analysis.setStems'
      assetId: Id
      stems: NonNullable<AudioAnalysis['stems']>
      stemFeatures: NonNullable<AudioAnalysis['stemFeatures']>
    }
  /** A user correction of the beat grid, e.g. doubling the tempo or moving the downbeat. Writes only the given fields. */
  | { type: 'analysis.setGrid'; assetId: Id; grid: Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats'> }
  | { type: 'analysis.removeAudio'; assetId: Id }
  | { type: 'analysis.updateSection'; assetId: Id; sectionId: Id; patch: Partial<Omit<SongSection, 'id'>> }
  | { type: 'analysis.setVisual'; analysis: VisualAnalysis }
  | { type: 'lyrics.set'; lyrics: LyricsDoc | null }
  | { type: 'lyrics.updateLine'; lineId: Id; patch: Partial<Omit<LyricLine, 'id'>> }

export type EditErrorCode = 'not-found' | 'invalid' | 'locked'

export class EditError extends Error {
  readonly code: EditErrorCode
  constructor(code: EditErrorCode, message: string) {
    super(message)
    this.name = 'EditError'
    this.code = code
  }
}

const MIN_CLIP_DURATION = 1 / 240

function clipOf(p: Draft<Project>, id: Id): Draft<Clip> {
  const clip = p.clips[id]
  if (!clip) throw new EditError('not-found', `Clip ${id} not found`)
  return clip
}

function trackOf(p: Draft<Project>, id: Id): Draft<Track> {
  const track = p.tracks.find((t) => t.id === id)
  if (!track) throw new EditError('not-found', `Track ${id} not found`)
  return track
}

function assertUnlocked(p: Draft<Project>, trackId: Id) {
  if (trackOf(p, trackId).locked) throw new EditError('locked', 'Track is locked')
}

function assertTrackAccepts(track: Track, clip: Clip) {
  const wantsAudio = clip.type === 'audio'
  if (wantsAudio !== (track.kind === 'audio'))
    throw new EditError('invalid', `A ${clip.type} clip cannot go on a ${track.kind} track`)
}

function resolve(
  target: unknown,
  path: PropertyPath,
): { parent: Record<string | number, unknown>; key: string | number } {
  if (path.length === 0) throw new EditError('invalid', 'Empty property path')
  let node = target as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (typeof next !== 'object' || next === null)
      throw new EditError('not-found', `No property at ${path.join('.')}`)
    node = next as Record<string | number, unknown>
  }
  return { parent: node, key: path[path.length - 1] as string | number }
}

const PROTECTED_CLIP_KEYS = new Set(['id', 'type', 'trackId'])

/** Feature ids: lowercase words with hyphens, optionally dotted ('vj', 'audio.stems'). */
const EXTENSION_KEY = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/

function moveInArray<T>(arr: T[], from: number, to: number) {
  const clamped = Math.max(0, Math.min(arr.length - 1, to))
  const [item] = arr.splice(from, 1)
  if (item !== undefined) arr.splice(clamped, 0, item)
}

/** Applies one command to an immer draft. Throws EditError on invalid input; the editor then discards the change. */
export function applyCommand(p: Draft<Project>, cmd: EditCommand): void {
  switch (cmd.type) {
    case 'project.rename':
      p.name = cmd.name
      return
    case 'project.updateSettings':
      Object.assign(p.settings, cmd.settings)
      return
    case 'project.setSong':
      if (cmd.assetId !== null && !p.assets[cmd.assetId]) throw new EditError('not-found', 'Asset not found')
      if (cmd.assetId === null) delete p.songAssetId
      else p.songAssetId = cmd.assetId
      return
    case 'project.setDuration':
      if (cmd.duration === null) delete p.duration
      else p.duration = Math.max(0, cmd.duration)
      return
    case 'project.setExtension':
      // Also keeps out keys like __proto__, which would replace the prototype of extensions instead of adding a key.
      if (!EXTENSION_KEY.test(cmd.key))
        throw new EditError('invalid', `Invalid extension key "${cmd.key}": use a feature id such as "vj"`)
      if (cmd.value !== null) {
        p.extensions ??= {}
        p.extensions[cmd.key] = cmd.value
      } else if (p.extensions) {
        delete p.extensions[cmd.key]
        if (Object.keys(p.extensions).length === 0) delete p.extensions
      }
      return

    case 'asset.add':
      if (p.assets[cmd.asset.id]) throw new EditError('invalid', 'Asset id already exists')
      p.assets[cmd.asset.id] = cmd.asset
      return
    case 'asset.rename': {
      const asset = p.assets[cmd.assetId]
      if (!asset) throw new EditError('not-found', 'Asset not found')
      asset.name = cmd.name
      return
    }
    case 'asset.remove': {
      if (!p.assets[cmd.assetId]) throw new EditError('not-found', 'Asset not found')
      for (const clip of Object.values(p.clips)) {
        if ('assetId' in clip && clip.assetId === cmd.assetId) delete p.clips[clip.id]
      }
      delete p.assets[cmd.assetId]
      delete p.analysis.audio[cmd.assetId]
      delete p.analysis.visual[cmd.assetId]
      if (p.songAssetId === cmd.assetId) delete p.songAssetId
      return
    }

    case 'track.add': {
      if (p.tracks.some((t) => t.id === cmd.track.id))
        throw new EditError('invalid', 'Track id already exists')
      const index = cmd.index ?? p.tracks.length
      p.tracks.splice(Math.max(0, Math.min(p.tracks.length, index)), 0, cmd.track)
      return
    }
    case 'track.remove': {
      trackOf(p, cmd.trackId)
      for (const clip of Object.values(p.clips)) if (clip.trackId === cmd.trackId) delete p.clips[clip.id]
      p.tracks = p.tracks.filter((t) => t.id !== cmd.trackId)
      return
    }
    case 'track.update':
      Object.assign(trackOf(p, cmd.trackId), cmd.patch)
      return
    case 'track.move': {
      const from = p.tracks.findIndex((t) => t.id === cmd.trackId)
      if (from < 0) throw new EditError('not-found', 'Track not found')
      moveInArray(p.tracks, from, cmd.toIndex)
      return
    }

    case 'clip.add': {
      if (p.clips[cmd.clip.id]) throw new EditError('invalid', 'Clip id already exists')
      const track = trackOf(p, cmd.clip.trackId)
      assertUnlocked(p, track.id)
      assertTrackAccepts(track, cmd.clip)
      if ('assetId' in cmd.clip && !p.assets[cmd.clip.assetId])
        throw new EditError('not-found', 'Asset not found')
      if (cmd.clip.duration <= 0) throw new EditError('invalid', 'Clip duration must be positive')
      p.clips[cmd.clip.id] = cmd.clip
      return
    }
    case 'clip.remove':
      for (const id of cmd.clipIds) {
        assertUnlocked(p, clipOf(p, id).trackId)
        delete p.clips[id]
      }
      return
    case 'clip.move':
      for (const move of cmd.moves) {
        const clip = clipOf(p, move.clipId)
        assertUnlocked(p, clip.trackId)
        if (move.trackId && move.trackId !== clip.trackId) {
          const target = trackOf(p, move.trackId)
          assertUnlocked(p, target.id)
          assertTrackAccepts(target, clip as Clip)
          clip.trackId = target.id
        }
        clip.start = Math.max(0, move.start)
      }
      return
    case 'clip.trim': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      if (cmd.duration < MIN_CLIP_DURATION) throw new EditError('invalid', 'Clip too short')
      const start = Math.max(0, cmd.start)
      if ('sourceStart' in clip) {
        const shift = (start - clip.start) * clip.playbackRate
        clip.sourceStart = Math.max(0, clip.sourceStart + shift)
      }
      clip.start = start
      clip.duration = cmd.duration
      return
    }
    case 'clip.split': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      const offset = cmd.time - clip.start
      if (offset < MIN_CLIP_DURATION || clip.duration - offset < MIN_CLIP_DURATION)
        throw new EditError('invalid', 'Split point is outside the clip')
      if (p.clips[cmd.newClipId]) throw new EditError('invalid', 'Clip id already exists')
      const right = JSON.parse(JSON.stringify(clip)) as Clip
      right.id = cmd.newClipId
      right.start = cmd.time
      right.duration = clip.duration - offset
      if ('sourceStart' in right) right.sourceStart += offset * right.playbackRate
      shiftKeyframes(right, -offset)
      if ('transitionIn' in right) delete right.transitionIn
      clip.duration = offset
      if ('transitionOut' in clip) delete clip.transitionOut
      p.clips[right.id] = right
      return
    }
    case 'clip.set': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      if (typeof cmd.path[0] === 'string' && PROTECTED_CLIP_KEYS.has(cmd.path[0]) && cmd.path.length === 1)
        throw new EditError('invalid', `Use a dedicated command to change ${cmd.path[0]}`)
      const { parent, key } = resolve(clip, cmd.path)
      parent[key] = cmd.value
      return
    }
    case 'clip.setAudioSource': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      if (clip.type !== 'generator')
        throw new EditError('invalid', `A ${clip.type} clip has no audio source; only generator clips do`)
      if (cmd.source === null) {
        delete clip.audio
        return
      }
      if (!STEM_NAMES.includes(cmd.source.stem))
        throw new EditError('invalid', `Unknown stem: ${String(cmd.source.stem)}`)
      clip.audio = { stem: cmd.source.stem }
      return
    }
    case 'keyframe.set': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      const { parent, key } = resolve(clip, cmd.path)
      const anim = parent[key] as { value: unknown; keyframes?: Keyframe<ParamValue>[] } | undefined
      if (!anim || typeof anim !== 'object' || !('value' in anim))
        throw new EditError('invalid', `${cmd.path.join('.')} is not animatable`)
      const list = (anim.keyframes ??= [])
      const i = list.findIndex((k) => Math.abs(k.time - cmd.keyframe.time) < 1e-6)
      if (i >= 0) list[i] = cmd.keyframe
      else list.push(cmd.keyframe)
      list.sort((a, b) => a.time - b.time)
      return
    }
    case 'keyframe.remove': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      const { parent, key } = resolve(clip, cmd.path)
      const anim = parent[key] as { keyframes?: Keyframe<ParamValue>[] } | undefined
      if (!anim?.keyframes) throw new EditError('not-found', 'No keyframes at that path')
      anim.keyframes = anim.keyframes.filter((k) => Math.abs(k.time - cmd.time) >= 1e-6)
      if (anim.keyframes.length === 0) delete anim.keyframes
      return
    }

    case 'effect.add': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      if (!('effects' in clip)) throw new EditError('invalid', 'Audio clips have no visual effects')
      const index = cmd.index ?? clip.effects.length
      clip.effects.splice(Math.max(0, Math.min(clip.effects.length, index)), 0, cmd.effect)
      return
    }
    case 'effect.remove': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      if (!('effects' in clip)) throw new EditError('invalid', 'Audio clips have no visual effects')
      clip.effects = clip.effects.filter((e) => e.id !== cmd.effectInstanceId)
      return
    }
    case 'effect.move': {
      const clip = clipOf(p, cmd.clipId)
      assertUnlocked(p, clip.trackId)
      if (!('effects' in clip)) throw new EditError('invalid', 'Audio clips have no visual effects')
      const from = clip.effects.findIndex((e) => e.id === cmd.effectInstanceId)
      if (from < 0) throw new EditError('not-found', 'Effect not found')
      moveInArray(clip.effects, from, cmd.toIndex)
      return
    }

    case 'marker.add':
      p.markers.push(cmd.marker)
      p.markers.sort((a, b) => a.time - b.time)
      return
    case 'marker.update': {
      const marker = p.markers.find((m) => m.id === cmd.markerId)
      if (!marker) throw new EditError('not-found', 'Marker not found')
      Object.assign(marker, cmd.patch)
      p.markers.sort((a, b) => a.time - b.time)
      return
    }
    case 'marker.remove':
      p.markers = p.markers.filter((m) => m.id !== cmd.markerId)
      return

    case 'analysis.setAudio':
      p.analysis.audio[cmd.analysis.assetId] = cmd.analysis
      return
    case 'analysis.setDetected': {
      const current = p.analysis.audio[cmd.analysis.assetId]
      const next: AudioAnalysis = { ...cmd.analysis }
      if (current?.stems) next.stems = current.stems
      if (current?.stemFeatures) next.stemFeatures = current.stemFeatures
      p.analysis.audio[cmd.analysis.assetId] = next
      return
    }
    case 'analysis.setRefined': {
      const a = p.analysis.audio[cmd.assetId]
      if (!a) return
      const gridUntouched =
        sameData(a.tempo, cmd.baseline.tempo) &&
        sameData(a.beats, cmd.baseline.beats) &&
        sameData(a.downbeats, cmd.baseline.downbeats)
      if (gridUntouched) setFields(a, cmd.refined, ['tempo', 'beats', 'downbeats'])
      if (sameData(a.sections, cmd.baseline.sections)) setFields(a, cmd.refined, ['sections'])
      return
    }
    case 'analysis.setStems': {
      const a = (p.analysis.audio[cmd.assetId] ??= { assetId: cmd.assetId, version: '' })
      a.stems = cmd.stems
      a.stemFeatures = cmd.stemFeatures
      return
    }
    case 'analysis.setGrid': {
      const a = p.analysis.audio[cmd.assetId]
      if (!a) throw new EditError('not-found', 'No analysis for that asset')
      setFields(a, cmd.grid, ['tempo', 'beats', 'downbeats'])
      return
    }
    case 'analysis.removeAudio':
      delete p.analysis.audio[cmd.assetId]
      return
    case 'analysis.updateSection': {
      const section = p.analysis.audio[cmd.assetId]?.sections?.find((s) => s.id === cmd.sectionId)
      if (!section) throw new EditError('not-found', 'Section not found')
      Object.assign(section, cmd.patch)
      if (cmd.patch.label !== undefined && cmd.patch.confidence === undefined) section.confidence = 1
      return
    }
    case 'analysis.setVisual':
      p.analysis.visual[cmd.analysis.assetId] = cmd.analysis
      return

    case 'lyrics.set':
      if (cmd.lyrics === null) delete p.lyrics
      else p.lyrics = cmd.lyrics
      return
    case 'lyrics.updateLine': {
      const line = p.lyrics?.lines.find((l) => l.id === cmd.lineId)
      if (!line) throw new EditError('not-found', 'Lyric line not found')
      Object.assign(line, cmd.patch)
      return
    }

    default: {
      const unknown: never = cmd
      throw new EditError('invalid', `Unknown command ${(unknown as { type: string }).type}`)
    }
  }
}

function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Copies the listed keys that `from` has (an explicit undefined removes the field), touching no others. */
function setFields<T extends object, K extends keyof T>(target: T, from: Partial<T>, keys: K[]) {
  for (const key of keys) {
    if (!(key in from)) continue
    if (from[key] === undefined) delete target[key]
    else target[key] = from[key] as T[K]
  }
}

/** Shifts every keyframe in a clip by `delta` seconds (used when splitting). */
function shiftKeyframes(node: unknown, delta: number) {
  if (Array.isArray(node)) {
    for (const item of node) shiftKeyframes(item, delta)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const obj = node as Record<string, unknown>
  if (Array.isArray(obj.keyframes) && 'value' in obj) {
    for (const k of obj.keyframes as Keyframe<unknown>[]) k.time += delta
  }
  for (const value of Object.values(obj)) shiftKeyframes(value, delta)
}

/** Short user-facing label for undo/redo menus. */
export function describeCommand(cmd: EditCommand): string {
  const labels: Partial<Record<EditCommand['type'], string>> = {
    'project.rename': 'Rename project',
    'project.updateSettings': 'Change project settings',
    'project.setExtension': 'Change project settings',
    'asset.add': 'Import media',
    'asset.remove': 'Remove media',
    'track.add': 'Add track',
    'track.remove': 'Delete track',
    'track.move': 'Reorder track',
    'clip.add': 'Add clip',
    'clip.remove': 'Delete clip',
    'clip.move': 'Move clip',
    'clip.trim': 'Trim clip',
    'clip.split': 'Split clip',
    'clip.set': 'Change property',
    'keyframe.set': 'Set keyframe',
    'keyframe.remove': 'Remove keyframe',
    'effect.add': 'Add effect',
    'effect.remove': 'Remove effect',
    'marker.add': 'Add marker',
    'marker.remove': 'Remove marker',
    'analysis.updateSection': 'Edit section',
    'analysis.setGrid': 'Change beat grid',
    'lyrics.set': 'Edit lyrics',
    'lyrics.updateLine': 'Edit lyric line',
  }
  return labels[cmd.type] ?? 'Edit'
}
