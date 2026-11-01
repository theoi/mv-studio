/**
 * The `meta.director` tag on clips a director draft made. Kept free of other director imports so plugins (looks)
 * can recognize director clips without pulling in the planner.
 */
import type { Clip, Id } from '../model/types.ts'
import type { GenerateSource } from './plan.ts'

export const DIRECTOR_META_KEY = 'director'

export type DirectorTrackRole = 'title' | 'text' | 'look' | 'accent' | 'overlay' | 'shots'
export type DirectorClipRole = DirectorTrackRole | 'song'

export interface DirectorClipMeta {
  planId: string
  role: DirectorClipRole
  shotId?: string
  sectionId?: string
  /** Text clips: a lyric line, a title, a line's emphasized word, or the next line shown in advance. */
  textRole?: 'lyric' | 'title' | 'emphasis' | 'preview'
  /** Text clips from a lyric line, including emphasis and preview clips, which are not linked to it. */
  lyricLineId?: string
  /** Title cards shown at once each get a row (track) of their own: this card's, from 0 at the top (absent for 0). */
  titleRow?: number
  /** Title cards: the song whose title or artist they show, so a later draft takes a name corrected on one only for it. */
  songId?: Id
  /**
   * Title cards: the font size the text was laid out from and the size it fit at, so laying the card out again after
   * an edit can grow its text back, unless the user has since set another size.
   */
  titleSize?: { base: number; fitted: number }
  /** Set on placeholders for AI shots that have not been generated yet. */
  pending?: { task: GenerateSource['task']; prompt: string; modelId: string; duration?: number }
}

export function directorMeta(clip: Clip): DirectorClipMeta | undefined {
  const raw = clip.meta?.[DIRECTOR_META_KEY]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const meta = raw as Record<string, unknown>
  if (typeof meta.planId !== 'string' || typeof meta.role !== 'string') return undefined
  return meta as unknown as DirectorClipMeta
}

export function isDirectorClip(clip: Clip): boolean {
  return directorMeta(clip) !== undefined
}
