/**
 * Public data types of the vision area. Everything here is plain serializable data
 * (typed arrays included), so results can be cached in OPFS, stored with the project,
 * and read identically by preview and export.
 */

export interface Size {
  width: number
  height: number
}

/** Normalized rectangle: 0..1 relative to the source frame. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Media time range in seconds. */
export interface TimeRange {
  start: number
  end: number
}

/** Single-channel 8-bit soft mask, row-major. 0 = background, 255 = subject. */
export interface Mask {
  width: number
  height: number
  data: Uint8Array
}

/** Grayscale image (luma 0..255), row-major. Used as a guide for smoothing and motion. */
export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
}

/** RGBA image, row-major, 4 bytes per pixel (ImageData-compatible). */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

// ---------------------------------------------------------------------------
// Segmentation

export type MaskKind = 'person' | 'selection'
export type MaskQuality = 'standard' | 'high'

export interface MaskTrackMeta {
  version: 1
  kind: MaskKind
  mediaId: string
  sourceSize: Size
  maskSize: Size
  /** Masks are sampled uniformly: frame i is at `start + i / fps` (media time, seconds). */
  fps: number
  start: number
  frameCount: number
  model: string
  quality: MaskQuality
  /** Subject coverage per frame, 0..1. */
  coverage: number[]
  /** Selection tracks: frame indices where tracking was lost and the mask is held or empty. */
  lostFrames?: number[]
  /**
   * Person tracks: share of the subject that pops on or off at each frame (`mask/pops.ts`); missing in tracks stored
   * before it was measured.
   */
  pops?: number[]
}

export interface MaskTrack {
  meta: MaskTrackMeta
  /** One mask per frame, each `maskSize.width * maskSize.height` bytes. */
  frames: Uint8Array[]
}

/** Mask track with every frame run-length encoded (see `mask/track.ts`). */
export interface PackedMaskTrack {
  meta: MaskTrackMeta
  packed: Uint8Array[]
}

/** Two neighbouring mask frames and the blend weight of the second, for a media time. */
export interface MaskSample {
  i0: number
  i1: number
  /** 0 = use frame i0 only, 1 = use frame i1 only. */
  weight: number
}

export type SuitabilityVerdict = 'good' | 'marginal' | 'unsuitable'

/** Machine-readable reasons; the UI maps them to translated explanations. */
export type SuitabilityReason =
  | 'no-subject'
  /** The segmenter cut out a shape large enough, but no person was found there (an animal, or a missed person). */
  | 'no-person-found'
  | 'subject-too-small'
  | 'subject-fills-frame'
  | 'many-small-subjects'
  | 'unstable-mask'

export interface SuitabilityReport {
  verdict: SuitabilityVerdict
  /** Most important first. Empty when the verdict is 'good'. */
  reasons: SuitabilityReason[]
  /** Fraction of sampled frames where the effect works. */
  usableFraction: number
  meanCoverage: number
  /**
   * 1 minus the mean share of the subject that flickers for a single frame (1 = no flicker), or null when the samples
   * came without neighbouring frames (the quick check) or were too few.
   */
  stability: number | null
  sampledFrames: number
  /** Time ranges where the effect can be offered. */
  suitableRanges: TimeRange[]
  /**
   * Set when the person detector could not be downloaded or loaded, so no one was looked for and the verdict counts
   * the whole mask, including animals and vehicles the segmenter cuts out.
   */
  peopleSkipped?: boolean
  /** What the verdict was judged from, so a part of the shot (a clip's used range) can be judged on its own. */
  evidence?: SuitabilityEvidence
}

export type SuitabilityFrameVerdict = 'ok' | SuitabilityReason

export interface SuitabilityEvidence {
  /** Each judged frame, ascending: media time, verdict and mask coverage. */
  frames: Array<{ t: number; verdict: SuitabilityFrameVerdict; coverage: number }>
  /** Nominal time between judged frames. */
  spacing: number
  /**
   * The frames that pop visibly, as indices of the `count` frames from `start` at `fps` (media time); null when
   * pops were not measured (the quick check).
   */
  pops: { start: number; fps: number; count: number; popping: number[] } | null
  /**
   * The shortest suitable range in seconds the frames were judged with, when not the default 1 s: the quick check
   * asks for more (`checkMinRangeSeconds`), and a part of the shot is judged with it too.
   */
  minRangeSeconds?: number
}

// ---------------------------------------------------------------------------
// Depth and camera moves

export type DepthQuality = 'preview' | 'full'

/** Relative depth, 0 = far, 255 = near. */
export interface DepthMap {
  version: 1
  width: number
  height: number
  data: Uint8Array
  sourceSize: Size
  model: string
  quality: DepthQuality
}

export type CameraPreset =
  | 'dolly-in'
  | 'dolly-out'
  | 'pan-left'
  | 'pan-right'
  | 'tilt-up'
  | 'tilt-down'
  | 'orbit-left'
  | 'orbit-right'
  | 'crane-up'
  | 'ken-burns'

export interface CameraMove {
  preset: CameraPreset
  /** 0..1, scales the parallax amount. */
  intensity: number
  /** Depth (0 = far, 1 = near) that stays fixed on screen while the camera moves. */
  focus: number
}

/** Camera pose for the parallax renderer at one moment of a move. */
export interface CameraPose {
  /** Parallax offset in normalized image units (fraction of width / height) applied at depth 1. */
  offsetX: number
  offsetY: number
  /** >= 1, uniform zoom about the image centre. */
  zoom: number
  /** Depth that does not move, 0..1. */
  focus: number
  /**
   * Translation of the whole image in normalized source units (fraction of width / height), applied before
   * parallax; positive moves content right / down. Absent means 0.
   */
  panX?: number
  panY?: number
  /**
   * Depth-dependent scale about the image centre: a point at depth d is scaled by about `1 + dolly * (d - focus)`,
   * so positive values make near content grow relative to far content (a dolly-in). Absent means 0.
   */
  dolly?: number
}

// ---------------------------------------------------------------------------
// Footage matching

export type Mood = 'calm' | 'energetic' | 'dark' | 'bright' | 'melancholic' | 'romantic' | 'epic' | 'dreamy'

export interface MotionAnalysis {
  /** Sampling rate of the curves below. */
  fps: number
  /** Subject motion after compensating camera motion: mean abs luma difference (0..255) per sample. */
  energy: number[]
  /** Camera motion: magnitude of the estimated global shift, in % of frame width per second. */
  camera: number[]
  /** Detected hard cuts (media time, seconds). */
  cuts: number[]
  meanEnergy: number
  p90Energy: number
  meanCamera: number
}

export interface ClipVisionIndex {
  version: 1
  mediaId: string
  duration: number
  model: string
  dim: number
  /** Media times of the embedded frames. */
  times: number[]
  /** Unit-length embeddings, `times.length * dim` floats, frame-major. */
  embeddings: Float32Array
  /** Mean similarity of each frame to the reference prompt bank (hubness correction). */
  hubness: number[]
  motion: MotionAnalysis
}

export interface MatchQuery {
  /** Free text such as a lyric line ("driving through the rain"). */
  text?: string
  /** A `Mood`, or any mood word or phrase: it maps to the nearest `Mood` (`resolveMood`) and is ignored if none fits. */
  mood?: string
  /** Desired energy 0..1 (for example the song section energy). */
  energy?: number
  /** Desired segment length in seconds, used to pick the best range inside a clip. */
  duration?: number
}

export interface ClipMatch {
  mediaId: string
  /** Combined score, higher is better (not a probability). */
  score: number
  components: {
    semantic: number | null
    mood: number | null
    energy: number | null
  }
  /** Best-matching range inside the clip for the query. */
  bestRange: TimeRange
}

// ---------------------------------------------------------------------------
// Subject tracking and reframing

export type SubjectSource = 'face' | 'person' | 'selection' | 'none'

/** Subject observation in normalized source coordinates. */
export interface SubjectSample {
  t: number
  /** Point the framing should keep in view (e.g. the face, or upper body). */
  focus: Point
  /** Bounding box of the whole subject (union of people), or null when none. */
  box: Rect | null
  confidence: number
  source: SubjectSource
}

export interface SubjectTrack {
  version: 1
  mediaId: string
  sourceSize: Size
  samples: SubjectSample[]
}

export type ReframeAspect = '16:9' | '9:16' | '1:1' | '4:5'

/** Crop window centre and zoom at a time; the window keeps the target aspect. */
export interface CropKeyframe {
  t: number
  /** Centre of the crop in normalized source coordinates. */
  cx: number
  cy: number
  /** 1 = the largest crop of the target aspect that fits the source; > 1 zooms in. */
  zoom: number
  /** First keyframe of a new shot, placed at the cut: the crop holds the previous keyframe until then and jumps. */
  cut?: boolean
}

export interface ReframePlan {
  version: 1
  mediaId: string
  aspect: ReframeAspect
  sourceSize: Size
  /** Crop size at zoom 1 in normalized source units. */
  baseCrop: { width: number; height: number }
  keyframes: CropKeyframe[]
}
