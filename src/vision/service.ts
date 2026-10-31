import type { EmbeddingModel, VisionBackends } from './backends.ts'
import { createDepthService, type DepthService } from './depth/service.ts'
import {
  deserializeClipIndex,
  indexClip,
  serializeClipIndex,
  CLIP_INDEX_VERSION,
  type ClipIndexOptions,
} from './matching/indexer.ts'
import { createFootageMatcher, type FootageMatcher } from './matching/matcher.ts'
import {
  analyzeSubjects,
  planReframes,
  subjectTrackFrom,
  SUBJECT_TRACK_VERSION,
  type SubjectAnalysisOptions,
} from './reframe/analyze.ts'
import { planReframe, type ReframeOptions } from './reframe/planner.ts'
import type { FrameObservation } from './reframe/track.ts'
import { cacheKey, type BlobCache } from './runtime/cache.ts'
import { rgbaToGrayFast, toRgba } from './runtime/canvas.ts'
import { decodeContainer, encodeContainer } from './runtime/container.ts'
import type { FrameSource } from './runtime/frames.ts'
import { createSharedRunner } from './runtime/shared.ts'
import type { TaskOptions } from './runtime/tasks.ts'
import { SUITABILITY_VERSION } from './mask/suitability.ts'
import {
  buildPersonTrack,
  personTrackParams,
  PERSON_TRACK_VERSION,
  trackSuitability,
  type PersonTrackOptions,
  type PersonTrackResult,
} from './segmentation/personTrack.ts'
import {
  createLivePreview,
  type LivePreviewOptions,
  type LivePreviewSegmenter,
} from './segmentation/preview.ts'
import {
  buildSelectionTrack,
  selectionResult,
  SELECTION_TRACK_VERSION,
  type SelectionClick,
  type SelectionState,
  type SelectionTrackOptions,
  type SelectionTrackResult,
} from './segmentation/selectionTrack.ts'
import { checkSuitability, type SuitabilityCheckOptions } from './segmentation/suitability.ts'
import type {
  ClipVisionIndex,
  GrayImage,
  MaskTrackMeta,
  ReframeAspect,
  ReframePlan,
  Size,
  SubjectTrack,
  SuitabilityReport,
} from './types.ts'

export interface VisionServiceOptions {
  backends: VisionBackends
  /** Persistent cache for analysis results, keyed by media id (which must identify the content). */
  cache: BlobCache
  embeddingModel?: EmbeddingModel
  toGray?: (bitmap: ImageBitmap, size: Size) => GrayImage
}

/** Everything the rest of the app uses from the vision area. */
export interface VisionService {
  /** Live person masks for preview playback. */
  livePreview(options?: LivePreviewOptions): LivePreviewSegmenter
  /** Fast "will text-behind-subject work here?" check with reasons for the UI. */
  checkSuitability(source: FrameSource, options?: SuitabilityCheckOptions): Promise<SuitabilityReport>
  /** Export-quality person mask track (cached), with suitability and subject observations. */
  personTrack(source: FrameSource, options?: PersonTrackOptions): Promise<PersonTrackResult>
  /** The cached person track for these options, without computing. */
  cachedPersonTrack(source: FrameSource, options?: PersonTrackOptions): Promise<PersonTrackResult | null>
  /**
   * Mask track of an object the user clicked, followed through the clip (cached), with per-frame states for the
   * UI. Pass later clicks on the same object as `options.corrections` to re-anchor it where it was lost.
   */
  selectionTrack(
    source: FrameSource,
    click: SelectionClick,
    options?: SelectionTrackOptions,
  ): Promise<SelectionTrackResult>
  /** Subject positions over a clip (cached); reuses a cached person track's observations when present. */
  subjects(source: FrameSource, options?: SubjectAnalysisOptions): Promise<SubjectTrack>
  reframe(track: SubjectTrack, aspect: ReframeAspect, options?: ReframeOptions): ReframePlan
  reframeAll(
    track: SubjectTrack,
    aspects: readonly ReframeAspect[],
    options?: ReframeOptions,
  ): Record<string, ReframePlan>
  /** Footage-matching index of a clip (cached). */
  indexClip(source: FrameSource, options?: ClipIndexOptions): Promise<ClipVisionIndex>
  readonly matcher: FootageMatcher
  /** Depth maps for 2.5D camera moves (cached; preview and full quality). */
  readonly depth: DepthService
}

interface SelectionFileMeta {
  track: MaskTrackMeta
  states: SelectionState[]
  confidence: number[]
}

interface PersonTrackFileMeta {
  track: MaskTrackMeta
  suitability: SuitabilityReport
  /** `SUITABILITY_VERSION` the report was judged with; missing in files written before it existed. */
  suitabilityVersion?: number
  observations: FrameObservation[]
  hqFrames: number
}

function defaultToGray(bitmap: ImageBitmap, size: Size): GrayImage {
  return rgbaToGrayFast(toRgba(bitmap, size))
}

export function createVisionService(options: VisionServiceOptions): VisionService {
  const { backends, cache } = options
  const model = options.embeddingModel ?? 'clipB32'
  const toGray = options.toGray ?? defaultToGray
  const shared = createSharedRunner()
  const matcher = createFootageMatcher({ onnx: backends.onnx(), model })

  /** Cache read that treats unreadable or corrupt entries as misses. */
  const cached = async <T>(key: string, decode: (bytes: Uint8Array) => Promise<T>): Promise<T | null> => {
    try {
      const bytes = await cache.get(key)
      return bytes ? await decode(bytes) : null
    } catch {
      await cache.delete(key).catch(() => undefined)
      return null
    }
  }
  const store = (key: string, bytes: Uint8Array) => cache.put(key, bytes).catch(() => undefined)

  /** Cached, deduplicated task. */
  const memo = <T>(
    key: string,
    decode: (b: Uint8Array) => Promise<T>,
    encode: (v: T) => Promise<Uint8Array>,
    run: (o: TaskOptions & { signal: AbortSignal }) => Promise<T>,
    task: TaskOptions,
  ) =>
    shared(
      key,
      async (o) => {
        const hit = await cached(key, decode)
        if (hit) return hit
        const value = await run(o)
        await store(key, await encode(value))
        return value
      },
      task,
    )

  const personKey = (source: FrameSource, o: PersonTrackOptions) => {
    const p = personTrackParams(source, o)
    return cacheKey(
      'person-track',
      source.mediaId,
      PERSON_TRACK_VERSION,
      JSON.stringify([p, o.hqRanges ?? [], o.hqShortSide ?? 256, o.delegate ?? 'CPU']),
    )
  }
  const decodePerson = async (bytes: Uint8Array): Promise<PersonTrackResult> => {
    const { meta, chunks } = await decodeContainer<PersonTrackFileMeta>(bytes)
    if (meta.track.frameCount !== chunks.length) throw new Error('inconsistent person track')
    const track = { meta: meta.track, packed: chunks.map((c) => c.slice()) }
    return {
      track,
      // A report judged by older criteria is judged again from the stored masks, without segmenting again.
      suitability:
        meta.suitabilityVersion === SUITABILITY_VERSION ? meta.suitability : trackSuitability(track),
      observations: meta.observations,
      hqFrames: meta.hqFrames,
    }
  }
  const encodePerson = (r: PersonTrackResult) =>
    encodeContainer<PersonTrackFileMeta>(
      {
        track: r.track.meta,
        suitability: r.suitability,
        suitabilityVersion: SUITABILITY_VERSION,
        observations: r.observations,
        hqFrames: r.hqFrames,
      },
      r.track.packed,
    )
  const json = {
    encode: <T>(v: T) => encodeContainer(v, []),
    decode: async <T>(b: Uint8Array) => (await decodeContainer<T>(b)).meta,
  }

  const cachedPersonTrack = (source: FrameSource, o: PersonTrackOptions = {}) =>
    cached(personKey(source, o), decodePerson)

  return {
    livePreview(o) {
      return createLivePreview(backends.segmentation('interactive'), o)
    },
    checkSuitability(source, o = {}) {
      return checkSuitability(backends.segmentation('interactive'), source, o)
    },
    personTrack(source, o = {}) {
      const { signal, onProgress, ...rest } = o
      return memo(
        personKey(source, o),
        decodePerson,
        encodePerson,
        (task) =>
          buildPersonTrack(
            { segmentation: backends.segmentation('background'), onnx: backends.onnx() },
            source,
            { ...rest, ...task },
          ),
        { ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) },
      )
    },
    cachedPersonTrack,
    selectionTrack(source, click, o = {}) {
      const { signal, onProgress, ...rest } = o
      const key = cacheKey(
        'selection-track',
        source.mediaId,
        SELECTION_TRACK_VERSION,
        JSON.stringify([click, rest]),
      )
      return memo<SelectionTrackResult>(
        key,
        async (bytes) => {
          const { meta, chunks } = await decodeContainer<SelectionFileMeta>(bytes)
          if (meta.track.frameCount !== chunks.length || meta.states.length !== chunks.length)
            throw new Error('inconsistent selection track')
          const track = { meta: meta.track, packed: chunks.map((c) => c.slice()) }
          return selectionResult(track, meta.states, meta.confidence)
        },
        (r) =>
          encodeContainer<SelectionFileMeta>(
            { track: r.track.meta, states: r.states, confidence: r.confidence },
            r.track.packed,
          ),
        (task) =>
          buildSelectionTrack(
            {
              segmentation: backends.segmentation('interactive'),
              toGray,
              ...(options.toGray ? {} : { toRgba }),
            },
            source,
            click,
            { ...rest, ...task },
          ),
        { ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) },
      )
    },
    async subjects(source, o = {}) {
      const { signal, onProgress, ...rest } = o
      const person = await cachedPersonTrack(source)
      if (person?.observations.length && !rest.range) return subjectTrackFrom(source, person.observations)
      const key = cacheKey('subjects', source.mediaId, SUBJECT_TRACK_VERSION, JSON.stringify(rest))
      return memo<SubjectTrack>(
        key,
        json.decode,
        json.encode,
        (task) => analyzeSubjects(backends.segmentation('background'), source, { ...rest, ...task }),
        { ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) },
      )
    },
    reframe(track, aspect, o) {
      return planReframe(track, aspect, o)
    },
    reframeAll(track, aspects, o) {
      return planReframes(track, aspects, o)
    },
    indexClip(source, o = {}) {
      const { signal, onProgress, ...rest } = o
      return memo(
        cacheKey('clip-index', source.mediaId, model, CLIP_INDEX_VERSION, JSON.stringify(rest)),
        deserializeClipIndex,
        serializeClipIndex,
        (task) =>
          indexClip(
            { onnx: backends.onnx(), model, toGray, referenceVectors: () => matcher.referenceVectors() },
            source,
            { ...rest, ...task },
          ),
        { ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) },
      )
    },
    matcher,
    depth: createDepthService({ onnx: backends.onnx(), cache }),
  }
}
