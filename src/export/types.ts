import type { ExportResolution } from '../engine/export.ts'
import type { AspectPreset, Seconds } from '../model/types.ts'
import type { ReframeMode } from './formats.ts'

/** 'video': the whole timeline. 'teaser': a 15-30 s highlight. 'loop': a seamless 3-8 s vertical loop. */
export type OutputKind = 'video' | 'teaser' | 'loop'

export type ExportQuality = 'high' | 'balanced' | 'small'

/** One file the export dialog makes. Plain data, saved with the project as the dialog's outputs list. */
export interface OutputSpec {
  id: string
  kind: OutputKind
  /** File name without the extension. */
  name: string
  aspect: AspectPreset
  resolution: ExportResolution
  fps: number
  quality: ExportQuality
  /** How footage fills a frame of another aspect ratio. */
  reframe: ReframeMode
  /** Teaser and loop: the timeline range. Picked automatically when absent. */
  range?: { start: Seconds; end: Seconds }
  /**
   * Teaser: the longest it may run (15 or 30 s), ending on the last bar before that. Absent: as long as the section
   * it starts on, 15 to 30 s.
   */
  maxLength?: Seconds
  /** Include the song. Loops default to silent, like Spotify Canvas. */
  audio?: boolean
}
