/**
 * Public surface of the vision area. Other areas import from here only.
 */
export type * from './types.ts'
export type { EmbeddingModel, PersonModel, SegmentationRole, VisionBackends } from './backends.ts'
export { createVisionService, type VisionService, type VisionServiceOptions } from './service.ts'
export { createWorkerBackends, type WorkerBackends } from './workers/backends.ts'
export { createOpfsCache, createMemoryCache, type BlobCache } from './runtime/cache.ts'
export { createVideoElementSource, type FrameSource } from './runtime/frames.ts'
export { createAssetFrameSource } from './runtime/assetSource.ts'
export { encodeMaskVideo, maskAssetInfo, behindSubjectMatte } from './mask/video.ts'
export {
  buildVisualAnalysis,
  projectLibrary,
  readClipIndex,
  readSubjectTrack,
  reframePlanFor,
  VISION_ANALYSIS_VERSION,
} from './analysisData.ts'
export {
  createDirectorFootageMatcher,
  type DirectorFootageMatcher,
  type DirectorFootageMatch,
  type FootageInfo,
} from './director.ts'
export { VISION_MODELS } from './runtime/models.ts'
export { resolveMood } from './matching/prompts.ts'
export { fromJob, type TaskOptions } from './runtime/tasks.ts'
export {
  appendFrame,
  createPackedTrack,
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
export { baseCropSize, cropAt, planReframe, type ReframeOptions } from './reframe/planner.ts'
export type { PersonTrackOptions, PersonTrackResult } from './segmentation/personTrack.ts'
export { selectionStateAt } from './segmentation/selectionTrack.ts'
export type {
  SelectionClick,
  SelectionSpan,
  SelectionState,
  SelectionTrackOptions,
  SelectionTrackResult,
} from './segmentation/selectionTrack.ts'
export type { LivePreviewSegmenter, LivePreviewOptions } from './segmentation/preview.ts'
export type { FootageMatcher } from './matching/matcher.ts'
export type { DepthService, DepthRequest } from './depth/service.ts'
export { prepareDepthForParallax, suggestFocus } from './depth/prepare.ts'
export { CAMERA_PRESETS, cameraPoseAt, defaultCameraMove, requiredOverscan } from './render/camera.ts'
export { createParallaxRenderer, type ParallaxRenderer } from './render/parallax.ts'
export { CAMERA_EFFECT_ID, DEFAULT_CAMERA_PRESET } from './render/cameraEffect.ts'
export {
  AUTOCUT_JOB,
  autoCut,
  applyAutoCut,
  autoCutCommands,
  autoCutPool,
  planAutoCut,
  type AutoCutDeps,
  type AutoCutOn,
  type AutoCutOptions,
  type AutoCutOrder,
  type AutoCutPace,
  type AutoCutPlan,
  type AutoCutResult,
  type AutoCutShot,
} from './autocut/index.ts'
export { AUTOCUT_TRACK_NAME, isUntouchedAutoCut } from './autocut/apply.ts'
export {
  chooseClips,
  type ChooseInput,
  type ChooseResult,
  type ChooseSpan,
  type ClipPick,
  type PickReason,
  type PoolItem,
} from './autocut/choose.ts'
export type { CutSpan } from './autocut/rhythm.ts'
export {
  createFootageService,
  FOOTAGE_INDEX_JOB,
  STRONG_MATCH,
  type AssetIndexStatus,
  type FootageIndexer,
  type FootageQueryOptions,
  type FootageResult,
  type FootageService,
  type FootageServiceDeps,
  type IndexingState,
} from './footage/service.ts'
export { createImageFrameSource } from './runtime/imageSource.ts'
export {
  addCameraMove,
  cameraMoveCommands,
  cameraMoveEffect,
  encodeDepthImage,
  findDepthAsset,
  type CameraMoveDeps,
  type CameraMoveOptions,
} from './cameraMove.ts'
