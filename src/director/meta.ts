/**
 * The `meta.director` tag on clips a director draft made. Kept free of other director imports so plugins (looks)
 * can recognize director clips without pulling in the planner.
 */
import type { Clip } from '../model/types.ts'
import type { GenerateSource } from './plan.ts'

export const DIRECTOR_META_KEY = 'director'

export type DirectorTrackRole = 'text' | 'look' | 'accent' | 'overlay' | 'shots'
export type DirectorClipRole = DirectorTrackRole | 'song'

export interface DirectorClipMeta {
  planId: string
  role: DirectorClipRole
  shotId?: string
  sectionId?: string
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
