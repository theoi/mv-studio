/**
 * Public surface of the vision area. Other areas import from here only.
 */
export type * from './types.ts'
export type { EmbeddingModel, PersonModel, SegmentationRole, VisionBackends } from './backends.ts'
export { createVisionService, type VisionService, type VisionServiceOptions } from './service.ts'
export { createWorkerBackends, type WorkerBackends } from './workers/backends.ts'
export { createOpfsCache, createMemoryCache, type BlobCache } from './runtime/cache.ts'
export { createVideoElementSource, type FrameSource } from './runtime/frames.ts'
export {
  buildVisualAnalysis,
  projectLibrary,
  readClipIndex,
  readSubjectTrack,
  VISION_ANALYSIS_VERSION,
} from './analysisData.ts'
export {
  createDirectorFootageMatcher,
  type DirectorFootageMatcher,
  type DirectorFootageMatch,
  type FootageInfo,
} from './director.ts'
export { VISION_MODELS } from './runtime/models.ts'
export { fromJob, type TaskOptions } from './runtime/tasks.ts'
export {
  createTrackReader,
  sampleAt,
  serializeTrack,
  deserializeTrack,
  type MaskTrackReader,
} from './mask/track.ts'
export {
  MASK_REFINE_GLSL,
  maskRefineUniforms,
  createMaskRefinePass,
  type MaskRefinePass,
} from './render/maskShader.ts'
export { cropAt } from './reframe/planner.ts'
export type { PersonTrackOptions, PersonTrackResult } from './segmentation/personTrack.ts'
export type { SelectionTrackOptions, SelectionTrackResult } from './segmentation/selectionTrack.ts'
export type { LivePreviewSegmenter, LivePreviewOptions } from './segmentation/preview.ts'
export type { FootageMatcher } from './matching/matcher.ts'
