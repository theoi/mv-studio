import type { ClipVisionIndex, Mood } from '../types.ts'
import type { FootageMatcher } from './matcher.ts'
import { LABEL_PROMPTS, MOOD_PROMPTS } from './prompts.ts'
import { clipEnergyLevel, scoreSemantic } from './ranking.ts'

/** What stands out in a clip: content labels and moods (best first), and how busy it is. */
export interface ClipDescription {
  labels: string[]
  moods: Mood[]
  /** 0 = static, 1 = very busy (subject and camera motion). */
  motion: number
}

/** Activity level (mean residual luma change at 64 px) at which `motion` reaches ~0.63. */
const MOTION_SCALE = 6
const MAX_LABELS = 3
const MAX_MOODS = 2
/** Motion from which a clip is tagged "fast", and up to which it is tagged "slow". */
const FAST = 0.6
const SLOW = 0.2

export const motionOf = (clip: ClipVisionIndex) => 1 - Math.exp(-clipEnergyLevel(clip) / MOTION_SCALE)

/** Describes clips from their matching indexes; the label and mood captions are embedded once per matcher. */
export async function describeClips(
  clips: readonly ClipVisionIndex[],
  matcher: Pick<FootageMatcher, 'promptVector'>,
  signal?: AbortSignal,
): Promise<ClipDescription[]> {
  if (!clips.length) return []
  const labelNames = Object.keys(LABEL_PROMPTS)
  const moods = Object.keys(MOOD_PROMPTS) as Mood[]
  const labelVectors = await Promise.all(
    labelNames.map((l) => matcher.promptVector(LABEL_PROMPTS[l]!, signal)),
  )
  const moodVectors = await Promise.all(moods.map((m) => matcher.promptVector(MOOD_PROMPTS[m], signal)))
  return clips.map((clip) => ({
    labels: standouts(clip, labelNames, labelVectors, MAX_LABELS),
    moods: standouts(clip, moods, moodVectors, MAX_MOODS),
    motion: motionOf(clip),
  }))
}

/**
 * The words shown for a clip ("crowd", "lights", "energetic", "fast"): up to three labels, its strongest mood and,
 * for video, "fast" or "slow" when its motion says so.
 */
export function tagWords(description: ClipDescription, kind: 'video' | 'image'): string[] {
  const words = [...description.labels, ...description.moods.slice(0, 1)]
  if (kind === 'video' && description.motion >= FAST) words.push('fast')
  else if (kind === 'video' && description.motion <= SLOW) words.push('slow')
  return words
}

/**
 * Names whose prompt scores stand out for this clip (z-score > 1 among all candidates), best first. Absolute CLIP
 * similarities vary per clip, so a fixed threshold would label busy clips with everything.
 */
function standouts<T extends string>(
  clip: ClipVisionIndex,
  names: T[],
  vectors: Array<Float32Array | undefined>,
  max: number,
): T[] {
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
