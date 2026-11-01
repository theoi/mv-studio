import type { GrayImage, Mask, PackedMaskTrack, Point, Rect, RgbaImage, Size } from './types.ts'
import type { CallOptions } from '../shared/worker.ts'
import type { MaskTrackBuildConfig, TrackFrameStats } from './segmentation/trackBuilder.ts'
import type { WatchDownloads } from './runtime/downloads.ts'

/**
 * Contracts between the main-thread vision services and the model workers. Job logic
 * depends only on these interfaces, so it can be unit-tested with fakes.
 */

export type PersonModel = 'selfieLandscape' | 'selfie' | 'selfieMulticlass'
export type Delegate = 'CPU' | 'GPU'

export interface FaceObservation {
  box: Rect
  score: number
}

/** A person (or, in `animals`, an animal) the object detector found, with the box normalized to the frame. */
export interface PersonDetection {
  box: Rect
  score: number
}

export interface FrameAnalysisRequest {
  bitmap: ImageBitmap
  /** Monotonic per stream, required by MediaPipe VIDEO mode. */
  timestampMs: number
  mask?: boolean
  /** Mask size (default: bitmap size), so people can be detected on a larger frame than the mask needs. */
  maskSize?: Size
  faces?: boolean
  /** People found by the object detector (score at least `DETECTOR_MIN_SCORE`; the verdicts count those from 0.3). */
  people?: boolean
  /** Return the frame as luma at bitmap size (guide for smoothing and motion). */
  gray?: boolean
  /** Return the frame as RGBA at bitmap size (guide for edge-aware upsampling). */
  rgba?: boolean
}

export interface FrameAnalysis {
  mask?: Mask
  faces?: FaceObservation[]
  people?: PersonDetection[]
  /**
   * Animals the object detector found along with the people (the COCO animal classes, score at least
   * `DETECTOR_MIN_SCORE`), so a "person" box that is really an animal can be ruled out (`peopleIndex`).
   */
  animals?: PersonDetection[]
  /** Set instead of `faces` when the face detector cannot be downloaded or loaded (offline, a blocked host). */
  facesUnavailable?: boolean
  /** Set instead of `people` when the person detector cannot be downloaded or loaded. */
  peopleUnavailable?: boolean
  gray?: GrayImage
  rgba?: RgbaImage
}

export interface SelectRequest {
  bitmap: ImageBitmap
  /** Positive points, normalized. One point is a click; several are treated as a scribble. */
  points: Point[]
  /** Output mask size (default: bitmap size). */
  maskSize?: Size
}

export interface TrackFrameRequest {
  id: number
  bitmap: ImageBitmap
  timestampMs: number
  /**
   * High-quality matte for this frame (any size). Used instead of the standard mask when the
   * two broadly agree, so a matting failure on an unusual shot can't replace a usable mask.
   */
  hq?: Mask
  faces?: boolean
  people?: boolean
}

export interface TrackFrameResult extends TrackFrameStats {
  faces?: FaceObservation[]
  people?: PersonDetection[]
  animals?: PersonDetection[]
  /** As in `FrameAnalysis`. */
  facesUnavailable?: boolean
  peopleUnavailable?: boolean
  usedHq: boolean
}

export interface SegmentationBackend {
  configure(input: { model: PersonModel; delegate: Delegate }, options?: CallOptions): Promise<void>
  /** Person mask (at bitmap size), faces and guides for one frame. The bitmap is consumed. */
  analyze(input: FrameAnalysisRequest, options?: CallOptions): Promise<FrameAnalysis>
  /** Object mask from positive points. The bitmap is consumed. */
  select(input: SelectRequest, options?: CallOptions): Promise<Mask>
  /** Restarts VIDEO-mode timestamps, e.g. before a new clip. */
  resetStream(input: null, options?: CallOptions): Promise<void>
  /** Starts building a person mask track inside the worker. */
  beginTrack(input: MaskTrackBuildConfig, options?: CallOptions): Promise<{ id: number }>
  /** Segments one frame (ascending times) into the track. The bitmap is consumed. */
  pushTrackFrame(input: TrackFrameRequest, options?: CallOptions): Promise<TrackFrameResult>
  /** The stored track, with each stored mask's bounding box (null when empty) for the subject observations. */
  endTrack(
    input: { id: number },
    options?: CallOptions,
  ): Promise<{ track: PackedMaskTrack; boxes: ReadonlyArray<Rect | null> }>
  cancelTrack(input: { id: number }, options?: CallOptions): Promise<void>
}

export interface OnnxBackend {
  /** Relative depth at model output size, 0 = far, 255 = near. The bitmap is consumed. */
  depth(
    input: { bitmap: ImageBitmap; shortSide: number },
    options?: CallOptions,
  ): Promise<{ width: number; height: number; data: Uint8Array }>
  /** High-quality portrait matte at the given processing size. The bitmap is consumed. */
  matte(input: { bitmap: ImageBitmap; shortSide: number }, options?: CallOptions): Promise<Mask>
  /** Unit-length image embeddings, frame-major. Bitmaps are consumed. */
  embedImages(
    input: { bitmaps: ImageBitmap[]; model: EmbeddingModel },
    options?: CallOptions,
  ): Promise<{ dim: number; data: Float32Array }>
  /** Unit-length text embeddings. */
  embedTexts(
    input: { texts: string[]; model: EmbeddingModel },
    options?: CallOptions,
  ): Promise<{ dim: number; data: Float32Array }>
}

export type EmbeddingModel = 'clipB32' | 'siglipB16'

/**
 * 'interactive' serves the live preview and clicks; 'background' serves long analysis jobs,
 * so a running export analysis never stalls the preview.
 */
export type SegmentationRole = 'interactive' | 'background'

export interface VisionBackends {
  segmentation(role?: SegmentationRole): SegmentationBackend
  onnx(): OnnxBackend
  /** First-time model downloads in any worker, whichever call started them (see `downloadLines`). Returns stop. */
  watchDownloads?: WatchDownloads
}

export type { Size }
