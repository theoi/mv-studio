/**
 * Everything a planner needs, as plain data plus two narrow interfaces. Song analysis comes from
 * project.analysis.audio (src/analysis); footage tags and matching come from src/vision, which provides an object
 * with the FootageMatcher shape (structural typing, so neither module imports the other).
 */
import type { AspectPreset, FeatureSeries, Id, LyricsDoc, Project, Seconds } from '../model/types.ts'
import { projectDuration } from '../model/queries.ts'
import type { CostEstimate } from '../cloud/pricing.ts'
import type { GenerationRequest, GenerationTier } from '../cloud/types.ts'
import { DEFAULT_CATALOG, type DirectorCatalog } from './catalog.ts'
import type { Pace } from './plan.ts'

export type VideoKind = 'lyric' | 'visualizer' | 'beat-cut' | 'ai'

/** Footage tags from src/vision (FootageInfo in src/vision/director.ts). */
export interface FootageInfo {
  assetId: Id
  labels?: string[]
  /** 0..1, absolute motion energy. */
  motion?: number
  /** Weak hints; prefer motion for energy. */
  mood?: string[]
  /** 0..1 share of the frame covered by people, once masks are analysed. */
  subjectCoverage?: number
}

export interface MatchQuery {
  text?: string
  mood?: string
  energy?: number
  /** Sizes the best-matching range in the result. */
  duration?: Seconds
}

export interface FootageMatch {
  assetId: Id
  /** 0..1, comparable only within one call. */
  score: number
  /** Start of the best-matching range, in source seconds. */
  time?: Seconds
  range?: { start: Seconds; end: Seconds }
}

/** Matches src/vision's DirectorFootageMatcher. Assets without a match index are left out of results. */
export interface FootageMatcher {
  rank(query: string | MatchQuery, options?: { assetIds?: Id[]; limit?: number }): Promise<FootageMatch[]>
  info(assetIds?: Id[]): Promise<FootageInfo[]>
}

export interface SectionInfo {
  id: Id
  label: string
  start: Seconds
  end: Seconds
  /** 0..1 relative to the rest of the song. */
  energy: number
  repeatGroup?: number
}

export interface SongInfo {
  assetId?: Id
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
  matcher?: FootageMatcher
  settings: { aspect: AspectPreset; width: number; height: number; fps: number }
  catalog: DirectorCatalog
  /** Present only when a generation provider is configured and the user chose to generate. */
  generation?: GenerationOptions
  pace?: Pace
  seed: number
  /** Use the user's clips and images (default true). */
  useMedia: boolean
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
  }))
  return {
    assetId,
    duration,
    bpm: analysis?.tempo?.bpm,
    beats,
    downbeats,
    sections: sections.filter((s) => s.end - s.start > 0.05),
    energy: analysis?.energy,
    analyzed: beats.length > 0 || sections.length > 0,
  }
}

/** The user's clips and images (imported or generated), excluding stems, masks and proxies. */
export function mediaFromProject(project: Project, info: FootageInfo[] = []): MediaItem[] {
  const byId = new Map(info.map((i) => [i.assetId, i]))
  return Object.values(project.assets)
    .filter(
      (a): a is typeof a & { kind: 'video' | 'image' } =>
        (a.kind === 'video' || a.kind === 'image') &&
        (a.origin.type === 'import' || a.origin.type === 'generated'),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
    .map((a) => ({
      assetId: a.id,
      kind: a.kind,
      name: a.name,
      duration: a.duration,
      width: a.width,
      height: a.height,
      generated: a.origin.type === 'generated',
      info: byId.get(a.id),
    }))
}

export interface BuildInputOptions {
  kind: VideoKind
  prompt?: string
  catalog?: DirectorCatalog
  matcher?: FootageMatcher
  generation?: GenerationOptions
  pace?: Pace
  seed?: number
  useMedia?: boolean
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
  return {
    kind: options.kind,
    prompt: (options.prompt ?? '').trim(),
    song: songInfoFromProject(project),
    lyrics: project.lyrics,
    media: mediaFromProject(project, info),
    matcher: options.matcher,
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
  }
}
