/**
 * Everything a planner needs, as plain data plus the footage matchers. Song analysis comes from
 * project.analysis.audio (src/analysis); footage tags (createDirectorFootageMatcher), clip indexes and the matcher
 * that ranks clips per shot come from src/vision, whose types are used as is.
 */
import type { AspectPreset, Clip, FeatureSeries, Id, LyricsDoc, Project, Seconds } from '../model/types.ts'
import { projectDuration } from '../model/queries.ts'
import type { CostEstimate } from '../cloud/pricing.ts'
import type { GenerationRequest, GenerationTier } from '../cloud/types.ts'
import type { MediaFileSource } from '../engine/types.ts'
import { DEFAULT_CATALOG, type DirectorCatalog } from './catalog.ts'
import { createBrightnessProbe, type BrightnessProbe } from './contrast.ts'
import { directorMeta } from './meta.ts'
import { songTitle } from './songTitle.ts'
import type { Pace } from './plan.ts'
import type { DirectorFootageMatch, DirectorFootageMatcher, FootageInfo } from '../vision/director.ts'
import { blankAssets, isBlankClip, readClipIndex, readSubjectTrack } from '../vision/analysisData.ts'
import type { FootageMatcher as ClipMatcher } from '../vision/matching/matcher.ts'
import type { ClipVisionIndex, MatchQuery, Mood, SubjectTrack } from '../vision/types.ts'

export type { FootageInfo, MatchQuery }
export type FootageMood = Mood
export type FootageMatch = DirectorFootageMatch
export type FootageMatcher = DirectorFootageMatcher
/** src/vision's own footage matcher (`vision.matcher`): ranks clips shot by shot against the line sung then. */
export type FootageRanker = Pick<ClipMatcher, 'model' | 'rankAll'>

export type VideoKind = 'lyric' | 'visualizer' | 'beat-cut' | 'ai'

export interface SectionInfo {
  id: Id
  label: string
  start: Seconds
  end: Seconds
  /** 0..1 relative to the rest of the song. */
  energy: number
  repeatGroup?: number
  /** How sure the label is: about 0.4 from the audio alone, 0.8 from repeated lyrics, 1 typed by the user. */
  confidence?: number
}

export interface SongInfo {
  assetId?: Id
  /** From the song's title and artist tags, else its file name ("Artist - Title.mp3"), for title cards. */
  title?: string
  artist?: string
  duration: Seconds
  bpm?: number
  beats: Seconds[]
  downbeats: Seconds[]
  sections: SectionInfo[]
  energy?: FeatureSeries
  /** False when no beat or section analysis exists yet (the planner then uses an even grid). */
  analyzed: boolean
}

export interface MediaItem {
  assetId: Id
  kind: 'video' | 'image'
  name: string
  duration?: Seconds
  width?: number
  height?: number
  generated: boolean
  info?: FootageInfo
  /** The clip's vision index (embeddings and motion), when src/vision has analyzed it. */
  index?: ClipVisionIndex
  /** Where the people are over time (faces first), when src/vision has tracked them. */
  subjects?: SubjectTrack
  /** A subject mask video made for the clip by src/vision, for lyrics behind the subject. */
  subjectMask?: Id
}

export interface GenerationOptions {
  /** 'images' makes stills animated with camera moves (cheap); 'video' makes clips (costs more). */
  mode: 'images' | 'video'
  tier: GenerationTier
  imageModelId: string
  videoModelId: string
  /** Typical clip length for the video model, so shots line up with what one request returns. */
  videoDuration: Seconds
  maxVideoDuration: Seconds
  estimate(request: GenerationRequest): CostEstimate
  /** Upper limit on shots to generate; the rest reuse generated or user media. */
  maxShots: number
}

export interface PlannerInput {
  kind: VideoKind
  prompt: string
  song: SongInfo
  lyrics?: LyricsDoc
  media: MediaItem[]
  /** Names of the clips and images left out of `media` because they show nothing (black or fully transparent). */
  blank?: string[]
  matcher?: FootageMatcher
  footage?: FootageRanker
  settings: { aspect: AspectPreset; width: number; height: number; fps: number }
  catalog: DirectorCatalog
  /** Present only when a generation provider is configured and the user chose to generate. */
  generation?: GenerationOptions
  pace?: Pace
  seed: number
  /** Use the user's clips and images (default true). */
  useMedia: boolean
  /** Measures footage brightness under text boxes, for scrims behind lyrics over bright frames. */
  brightness?: BrightnessProbe
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Mean of a feature curve over [start, end). */
export function meanOver(
  series: FeatureSeries | undefined,
  start: Seconds,
  end: Seconds,
): number | undefined {
  if (!series || series.values.length === 0 || series.rate <= 0) return undefined
  const a = Math.max(0, Math.floor(start * series.rate))
  const b = Math.min(series.values.length, Math.max(a + 1, Math.ceil(end * series.rate)))
  let sum = 0
  for (let i = a; i < b; i++) sum += series.values[i] ?? 0
  return b > a ? sum / (b - a) : undefined
}

export type EnergyAt = (start: Seconds, end: Seconds) => number | undefined

/** Song energy over a span, 0..1 between the song's 10th and 90th percentile; undefined without an energy curve. */
export function energyScale(song: Pick<SongInfo, 'energy'>): EnergyAt | undefined {
  const series = song.energy
  if (!series?.values.length || series.rate <= 0) return undefined
  const sorted = [...series.values].sort((a, b) => a - b)
  const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const hi = sorted[Math.floor(sorted.length * 0.9)] ?? 1
  if (!(hi - lo > 1e-9)) return undefined
  return (start, end) => {
    const v = meanOver(series, start, end)
    return v === undefined ? undefined : clamp01((v - lo) / (hi - lo))
  }
}

/**
 * When the music stops: the start of a trailing stretch of near-silence at least `minTail` long (a fade-out tail or
 * silence after the last note), else the end of the song.
 */
export function musicEnd(song: Pick<SongInfo, 'energy' | 'duration'>, minTail: Seconds = 1.5): Seconds {
  const series = song.energy
  if (!series?.values.length || series.rate <= 0) return song.duration
  const sorted = [...series.values].sort((a, b) => a - b)
  const threshold = (sorted[Math.floor(sorted.length * 0.9)] ?? 0) * 0.05
  let i = series.values.length - 1
  while (i >= 0 && (series.values[i] ?? 0) <= threshold) i--
  const end = Math.min(song.duration, (i + 1) / series.rate)
  return song.duration - end >= minTail ? end : song.duration
}

/** Rank-normalizes raw section energies to 0..1 so "the loudest part" is high even in a quiet song. */
function normalizeEnergy(raw: number[]): number[] {
  if (raw.length <= 1) return raw.map(() => 0.6)
  const min = Math.min(...raw)
  const max = Math.max(...raw)
  if (max - min < 1e-6) return raw.map(() => 0.5)
  return raw.map((v) => clamp01((v - min) / (max - min)))
}

/** Song facts for planning, from the project's analysis of its main song. */
export function songInfoFromProject(project: Project): SongInfo {
  const assetId = project.songAssetId
  const asset = assetId ? project.assets[assetId] : undefined
  const analysis = assetId ? project.analysis.audio[assetId] : undefined
  const duration = asset?.duration ?? (project.duration || projectDuration(project)) ?? 0
  const beats = [...(analysis?.beats ?? [])].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b)
  const downbeats = [...(analysis?.downbeats ?? [])]
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b)
  const rawSections = [...(analysis?.sections ?? [])].sort((a, b) => a.start - b.start)
  const raw = rawSections.map((s) => s.energy ?? meanOver(analysis?.energy, s.start, s.end) ?? 0.5)
  const energies = normalizeEnergy(raw)
  const sections: SectionInfo[] = rawSections.map((s, i) => ({
    id: s.id,
    label: s.label,
    start: Math.max(0, s.start),
    end: Math.min(duration || s.end, s.end),
    energy: energies[i] ?? 0.5,
    repeatGroup: s.repeatGroup,
    ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
  }))
  return {
    assetId,
    ...(asset ? songTitle(asset) : {}),
    duration,
    bpm: analysis?.tempo?.bpm,
    beats,
    downbeats,
    sections: sections.filter((s) => s.end - s.start > 0.05),
    energy: analysis?.energy,
    analyzed: beats.length > 0 || sections.length > 0,
  }
}

const TITLE_FIELDS = ['title', 'artist'] as const
const words = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The song's title and artist as the user corrected them on a Director title card of this song (usually a name the
 * file name got wrong): the first row's text where it differs from the song's own title, the second row's from its
 * artist. Compared with the song's own each time, so a correction lasts through later drafts and a card put back to
 * the song's own name ends it. Only names the song gives: an untitled song's card text is the planner's, not a fix.
 * Only each row's first card counts: duplicated and pasted copies keep the card's tag, but what the user types on a
 * copy ("Chapter 2", "Thanks for watching") is new text, not a correction.
 */
function withCorrectedTitles(project: Project, song: SongInfo): SongInfo {
  const first = new Map<number, Clip>()
  for (const clip of Object.values(project.clips)) {
    const meta = directorMeta(clip)
    // Only title cards record their song.
    if (clip.type !== 'text' || !song.assetId || meta?.songId !== song.assetId) continue
    const row = meta.titleRow ?? 0
    const earlier = first.get(row)
    if (!earlier || clip.start < earlier.start) first.set(row, clip)
  }
  const fixed: Partial<Record<(typeof TITLE_FIELDS)[number], string>> = {}
  for (const [row, clip] of first) {
    const field = TITLE_FIELDS[row]
    const own = field && song[field]
    if (!field || !own || clip.type !== 'text') continue
    const text = words(clip.text)
    if (text && text !== words(own)) fixed[field] = text
  }
  return { ...song, ...fixed }
}

/** Subject masks src/vision stored for a clip (maskAssetInfo): derived videos named "<clip> (subject mask).webm". */
function subjectMasks(project: Project): Map<Id, Id> {
  const masks = new Map<Id, Id>()
  for (const a of Object.values(project.assets)) {
    const parent = a.origin.type === 'derived' ? a.origin.parentAssetId : undefined
    if (parent && a.kind === 'video' && /\(subject mask\)\.[a-z0-9]+$/i.test(a.name)) masks.set(parent, a.id)
  }
  return masks
}

/**
 * The user's clips and images (imported or generated), excluding stems, masks, proxies and the ones footage analysis
 * found to show nothing (`isBlankClip`), unless they are in `keep` (chosen by the user).
 */
export function mediaFromProject(
  project: Project,
  info: FootageInfo[] = [],
  keep: ReadonlySet<Id> = new Set(),
): MediaItem[] {
  const byId = new Map(info.map((i) => [i.assetId, i]))
  const masks = subjectMasks(project)
  return Object.values(project.assets)
    .filter(
      (a): a is typeof a & { kind: 'video' | 'image' } =>
        (a.kind === 'video' || a.kind === 'image') &&
        (a.origin.type === 'import' || a.origin.type === 'generated') &&
        (keep.has(a.id) || !isBlankClip(project.analysis.visual[a.id])),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
    .map((a) => {
      const index = readClipIndex(project.analysis.visual[a.id])
      const subjects = readSubjectTrack(project.analysis.visual[a.id])
      const mask = masks.get(a.id)
      return {
        assetId: a.id,
        kind: a.kind,
        name: a.name,
        duration: a.duration,
        width: a.width,
        height: a.height,
        generated: a.origin.type === 'generated',
        info: byId.get(a.id),
        ...(index ? { index } : {}),
        ...(subjects ? { subjects } : {}),
        ...(mask ? { subjectMask: mask } : {}),
      }
    })
}

export interface BuildInputOptions {
  kind: VideoKind
  prompt?: string
  catalog?: DirectorCatalog
  matcher?: FootageMatcher
  footage?: FootageRanker
  generation?: GenerationOptions
  pace?: Pace
  seed?: number
  useMedia?: boolean
  /** Reads stored media (the app's media store), so text over bright footage can be measured and given a scrim. */
  media?: MediaFileSource
  /** Overrides the probe made from `media`. */
  brightness?: BrightnessProbe
}

/** Gathers planner input from a project. Footage tags are fetched from the matcher when one is available. */
export async function buildPlannerInput(project: Project, options: BuildInputOptions): Promise<PlannerInput> {
  let info: FootageInfo[] = []
  if (options.matcher) {
    try {
      info = await options.matcher.info()
    } catch {
      info = []
    }
  }
  const blank = blankAssets(project).map((a) => a.name)
  return {
    kind: options.kind,
    prompt: (options.prompt ?? '').trim(),
    song: withCorrectedTitles(project, songInfoFromProject(project)),
    lyrics: project.lyrics,
    media: mediaFromProject(project, info),
    ...(blank.length ? { blank } : {}),
    matcher: options.matcher,
    ...(options.footage ? { footage: options.footage } : {}),
    settings: {
      aspect: project.settings.aspect,
      width: project.settings.width,
      height: project.settings.height,
      fps: project.settings.fps,
    },
    catalog: options.catalog ?? DEFAULT_CATALOG,
    generation: options.generation,
    pace: options.pace,
    seed: options.seed ?? 1,
    useMedia: options.useMedia ?? true,
    ...(options.brightness
      ? { brightness: options.brightness }
      : options.media
        ? { brightness: createBrightnessProbe(project, options.media) }
        : {}),
  }
}
