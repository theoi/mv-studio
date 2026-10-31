import type { Id, Project } from '../model/types.ts'
import { projectLibrary } from './analysisData.ts'
import type { FootageMatcher } from './matching/matcher.ts'
import { LABEL_PROMPTS, MOOD_PROMPTS } from './matching/prompts.ts'
import { clipEnergyLevel, scoreSemantic } from './matching/ranking.ts'
import type { ClipVisionIndex, MatchQuery, Mood, TimeRange } from './types.ts'

/**
 * Footage matching in the shape the AI director consumes (src/director/inputs.ts). Reads the clip indexes stored
 * in the project's visual analysis, so it always reflects what preview and export see.
 */
export interface DirectorFootageMatcher {
  /** Best clips for a lyric line or description, best first. `score` is 0..1, comparable within one call. */
  rank(
    query: string | MatchQuery,
    options?: { assetIds?: Id[]; limit?: number },
  ): Promise<DirectorFootageMatch[]>
  /** Per-asset descriptors for planning. Assets without a matching index are omitted. */
  info(assetIds?: Id[]): Promise<FootageInfo[]>
}

export interface DirectorFootageMatch {
  assetId: Id
  score: number
  /** Source time where the best-matching range starts. */
  time?: number
  range?: TimeRange
}

export interface FootageInfo {
  assetId: Id
  labels?: string[]
  /** 0 = static, 1 = very busy (subject and camera motion). */
  motion?: number
  mood?: string[]
  /** Mean fraction of the frame covered by people, when masks were analysed. */
  subjectCoverage?: number
}

/** Activity level (mean residual luma change at 64 px) at which `motion` reaches ~0.63. */
const MOTION_SCALE = 6
const MAX_LABELS = 3
const MAX_MOODS = 2

export function createDirectorFootageMatcher(deps: {
  matcher: FootageMatcher
  getProject: () => Pick<Project, 'analysis'>
}): DirectorFootageMatcher {
  const { matcher } = deps
  const library = (assetIds?: Id[]) => {
    const all = projectLibrary(deps.getProject()).filter((c) => c.model === matcher.model)
    if (!assetIds) return all
    const wanted = new Set(assetIds)
    return all.filter((c) => wanted.has(c.mediaId))
  }

  return {
    async rank(query, options = {}) {
      const clips = library(options.assetIds)
      const matches = await matcher.rank(clips, typeof query === 'string' ? { text: query } : query)
      const limited = options.limit !== undefined ? matches.slice(0, Math.max(0, options.limit)) : matches
      return limited.map((m) => ({
        assetId: m.mediaId,
        score: 1 / (1 + Math.exp(-m.score)),
        time: m.bestRange.start,
        range: m.bestRange,
      }))
    },

    async info(assetIds) {
      const clips = library(assetIds)
      if (!clips.length) return []
      const labelNames = Object.keys(LABEL_PROMPTS)
      const moods = Object.keys(MOOD_PROMPTS) as Mood[]
      const labelVectors = await Promise.all(labelNames.map((l) => matcher.promptVector(LABEL_PROMPTS[l]!)))
      const moodVectors = await Promise.all(moods.map((m) => matcher.promptVector(MOOD_PROMPTS[m])))
      const visual = deps.getProject().analysis.visual
      return clips.map((clip): FootageInfo => {
        const coverage = visual[clip.mediaId]?.data.suitability
        const meanCoverage =
          typeof coverage === 'object' && coverage !== null && !Array.isArray(coverage)
            ? coverage.meanCoverage
            : undefined
        return {
          assetId: clip.mediaId,
          labels: standouts(clip, labelNames, labelVectors, MAX_LABELS),
          motion: 1 - Math.exp(-clipEnergyLevel(clip) / MOTION_SCALE),
          mood: standouts(clip, moods, moodVectors, MAX_MOODS),
          ...(typeof meanCoverage === 'number' ? { subjectCoverage: meanCoverage } : {}),
        }
      })
    },
  }
}

/**
 * Names whose prompt scores stand out for this clip (z-score > 1 among all candidates), best first. Absolute CLIP
 * similarities vary per clip, so a fixed threshold would label busy clips with everything.
 */
function standouts(
  clip: ClipVisionIndex,
  names: string[],
  vectors: Array<Float32Array | undefined>,
  max: number,
): string[] {
  const scores = vectors.map((v) => (v && v.length === clip.dim ? scoreSemantic(clip, v).score : Number.NaN))
  const valid = scores.filter((s) => Number.isFinite(s))
  if (valid.length < 2) return []
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length
  const std = Math.sqrt(valid.reduce((a, s) => a + (s - mean) ** 2, 0) / valid.length)
  if (!(std > 1e-6)) return []
  return names
    .map((name, i) => ({ name, z: (scores[i]! - mean) / std }))
    .filter((s) => s.z > 1)
    .sort((a, b) => b.z - a.z)
    .slice(0, max)
    .map((s) => s.name)
}
