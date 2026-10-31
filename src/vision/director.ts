import type { Id, Project } from '../model/types.ts'
import { projectLibrary } from './analysisData.ts'
import type { FootageMatcher } from './matching/matcher.ts'
import { describeClips } from './matching/tags.ts'
import type { MatchQuery, TimeRange } from './types.ts'

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
      const descriptions = await describeClips(clips, matcher)
      const visual = deps.getProject().analysis.visual
      return clips.map((clip, i): FootageInfo => {
        const coverage = visual[clip.mediaId]?.data.suitability
        const meanCoverage =
          typeof coverage === 'object' && coverage !== null && !Array.isArray(coverage)
            ? coverage.meanCoverage
            : undefined
        const { labels, moods, motion } = descriptions[i]!
        return {
          assetId: clip.mediaId,
          labels,
          motion,
          mood: moods,
          ...(typeof meanCoverage === 'number' ? { subjectCoverage: meanCoverage } : {}),
        }
      })
    },
  }
}
