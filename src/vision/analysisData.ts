import type { Asset, Id, JsonObject, JsonValue, Project, VisualAnalysis } from '../model/types.ts'
import { shortFileName } from '../shared/text.ts'
import { planReframe, type ReframeOptions } from './reframe/planner.ts'
import type {
  ClipVisionIndex,
  MotionAnalysis,
  ReframeAspect,
  ReframePlan,
  Size,
  SubjectSample,
  SubjectTrack,
  SuitabilityReport,
} from './types.ts'

/**
 * Shape of `VisualAnalysis.data` (the project stores it as plain JSON, so preview, export, the director and the
 * portable project file all read the same values). Embeddings are stored as int8 with a per-frame scale: a 3-minute
 * clip at 1 fps is ~120 KB instead of ~490 KB, and cosine similarities change by < 0.002.
 */
export const VISION_ANALYSIS_VERSION = 'vision-1'

export interface VisualAnalysisParts {
  assetId: Id
  duration: number
  sourceSize: Size
  index?: ClipVisionIndex
  subjects?: SubjectTrack
  /** "Text behind the subject" suitability of the clip. */
  suitability?: SuitabilityReport
  /** Stored person mask track for the clip. */
  personMask?: { assetId: Id; quality: string; fps: number }
  /** Words describing the clip (`readClipTags`), from its matching index. */
  tags?: readonly string[]
  /**
   * The fast blank check (`samplePeakLuma`): the brightest luma it saw in the clip's first frame and `frames` frames
   * spread over it. It stops at the first frame of at least `BLANK_PEAK_LUMA`, so a value at or above that is only a
   * lower bound.
   */
  blankCheck?: { peakLuma: number; frames: number }
}

const round = (v: number, digits = 3) => {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
const roundAll = (values: readonly number[], digits = 3) => values.map((v) => round(v, digits))

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function encodeEmbeddings(index: ClipVisionIndex): JsonObject {
  const n = index.times.length
  const q = new Int8Array(n * index.dim)
  const scales: number[] = []
  for (let i = 0; i < n; i++) {
    let max = 0
    for (let k = 0; k < index.dim; k++) max = Math.max(max, Math.abs(index.embeddings[i * index.dim + k]!))
    const scale = max > 0 ? max / 127 : 1
    scales.push(scale)
    for (let k = 0; k < index.dim; k++)
      q[i * index.dim + k] = Math.round(index.embeddings[i * index.dim + k]! / scale)
  }
  return {
    model: index.model,
    dim: index.dim,
    times: roundAll(index.times),
    hubness: roundAll(index.hubness, 5),
    scales: scales.map((s) => Number(s.toPrecision(6))),
    data: toBase64(new Uint8Array(q.buffer)),
  }
}

function encodeMotion(m: MotionAnalysis): JsonObject {
  return {
    fps: m.fps,
    energy: roundAll(m.energy, 2),
    camera: roundAll(m.camera, 2),
    cuts: roundAll(m.cuts),
    meanEnergy: round(m.meanEnergy),
    p90Energy: round(m.p90Energy),
    meanCamera: round(m.meanCamera),
    ...(m.peakLuma === undefined ? {} : { peakLuma: m.peakLuma }),
  }
}

function encodeSubjects(track: SubjectTrack): JsonObject {
  return {
    samples: track.samples.map((s): JsonObject => ({
      t: round(s.t),
      fx: round(s.focus.x, 4),
      fy: round(s.focus.y, 4),
      box: s.box
        ? [round(s.box.x, 4), round(s.box.y, 4), round(s.box.width, 4), round(s.box.height, 4)]
        : null,
      c: round(s.confidence, 2),
      src: s.source,
    })),
  }
}

/** JSON-safe copy (drops undefined, which JsonValue cannot hold). */
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * Builds the project's VisualAnalysis for an asset, merging new parts into a previous analysis so independent
 * analyses (matching index, masks, subject tracking) can be added one at a time.
 */
export function buildVisualAnalysis(parts: VisualAnalysisParts, previous?: VisualAnalysis): VisualAnalysis {
  const base: JsonObject = previous?.version === VISION_ANALYSIS_VERSION ? { ...previous.data } : {}
  const data: JsonObject = {
    ...base,
    duration: round(parts.duration),
    sourceSize: { width: parts.sourceSize.width, height: parts.sourceSize.height },
  }
  if (parts.index) {
    data.embedding = encodeEmbeddings(parts.index)
    data.motion = encodeMotion(parts.index.motion)
  }
  if (parts.subjects) data.subjects = encodeSubjects(parts.subjects)
  if (parts.suitability) data.suitability = json(parts.suitability)
  if (parts.personMask) data.personMask = json(parts.personMask)
  if (parts.tags) data.tags = [...parts.tags]
  if (parts.blankCheck)
    data.blankCheck = { peakLuma: round(parts.blankCheck.peakLuma, 1), frames: parts.blankCheck.frames }
  return { assetId: parts.assetId, version: VISION_ANALYSIS_VERSION, data }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading. Project data can come from older versions or imported files, so every reader validates and returns
// null when the data is missing or malformed (the caller then recomputes).

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number')

export function readClipIndex(analysis: VisualAnalysis | undefined): ClipVisionIndex | null {
  if (analysis?.version !== VISION_ANALYSIS_VERSION) return null
  const { embedding: e, motion: m, duration } = analysis.data
  if (!isObject(e) || !isObject(m) || typeof duration !== 'number') return null
  const { model, dim, times, hubness, scales, data } = e
  if (typeof model !== 'string' || typeof dim !== 'number' || typeof data !== 'string') return null
  if (!isNumbers(times) || !isNumbers(hubness) || !isNumbers(scales)) return null
  if (hubness.length !== times.length || scales.length !== times.length) return null
  let bytes: Uint8Array
  try {
    bytes = fromBase64(data)
  } catch {
    return null
  }
  if (bytes.length !== times.length * dim) return null
  const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)
  const embeddings = new Float32Array(q.length)
  for (let i = 0; i < times.length; i++) {
    let sq = 0
    for (let k = 0; k < dim; k++) {
      const v = q[i * dim + k]! * scales[i]!
      embeddings[i * dim + k] = v
      sq += v * v
    }
    const inv = sq > 0 ? 1 / Math.sqrt(sq) : 0
    for (let k = 0; k < dim; k++) embeddings[i * dim + k]! *= inv
  }
  const motion = readMotion(m)
  if (!motion) return null
  return { version: 1, mediaId: analysis.assetId, duration, model, dim, times, embeddings, hubness, motion }
}

function readMotion(m: Record<string, unknown>): MotionAnalysis | null {
  const { fps, energy, camera, cuts, meanEnergy, p90Energy, meanCamera, peakLuma } = m
  if (typeof fps !== 'number' || !isNumbers(energy) || !isNumbers(camera) || !isNumbers(cuts)) return null
  if (typeof meanEnergy !== 'number' || typeof p90Energy !== 'number' || typeof meanCamera !== 'number')
    return null
  return {
    fps,
    energy,
    camera,
    cuts,
    meanEnergy,
    p90Energy,
    meanCamera,
    ...(typeof peakLuma === 'number' ? { peakLuma } : {}),
  }
}

/**
 * Below this, no pixel of any sampled frame is brighter than the black of a video: the clip shows nothing, as when
 * its frames are black or fully transparent (a WebM whose alpha channel is all 0 draws as black on the stage).
 */
export const BLANK_PEAK_LUMA = 16

/**
 * The brightest luma footage analysis saw in the clip: from the matching index, which samples 4 frames a second, else
 * from the fast blank check, which samples a few frames and runs first.
 */
function peakLumaOf(analysis: VisualAnalysis | undefined): number | undefined {
  if (analysis?.version !== VISION_ANALYSIS_VERSION) return undefined
  const { motion, blankCheck } = analysis.data
  if (isObject(motion) && typeof motion.peakLuma === 'number') return motion.peakLuma
  if (isObject(blankCheck) && typeof blankCheck.peakLuma === 'number') return blankCheck.peakLuma
  return undefined
}

/** Whether footage analysis found every sampled frame of the clip or image black or fully transparent. */
export function isBlankClip(analysis: VisualAnalysis | undefined): boolean {
  const peak = peakLumaOf(analysis)
  return peak !== undefined && peak < BLANK_PEAK_LUMA
}

/** Whether footage analysis has looked at the clip's frames enough to say whether it shows anything. */
export function hasBlankVerdict(analysis: VisualAnalysis | undefined): boolean {
  return peakLumaOf(analysis) !== undefined
}

/** Media footage analysis reads: clips and stills the user imported or generated (a clip once its size is known). */
export function analyzableMedia(asset: Asset): asset is Asset & { kind: 'video' | 'image' } {
  if (asset.origin.type !== 'import' && asset.origin.type !== 'generated') return false
  if (asset.kind === 'video') return !!(asset.duration && asset.width && asset.height)
  return asset.kind === 'image'
}

/**
 * Whether any of these clips and stills (default: all of them) has no blank verdict yet (`hasBlankVerdict`), leaving
 * out those known to show something (`showsSomething`, such as the app's built-in sample).
 */
export function hasUncheckedMedia(
  project: Project,
  assetIds?: readonly Id[],
  showsSomething?: (asset: Asset) => boolean,
): boolean {
  const wanted = assetIds && new Set(assetIds)
  return Object.values(project.assets).some(
    (a) =>
      (!wanted || wanted.has(a.id)) &&
      analyzableMedia(a) &&
      !showsSomething?.(a) &&
      !hasBlankVerdict(project.analysis.visual[a.id]),
  )
}

/** The clips and images in the project that show nothing (`isBlankClip`), in import order. */
export function blankAssets(project: Project): Asset[] {
  return Object.values(project.assets)
    .filter(
      (a) =>
        (a.kind === 'video' || a.kind === 'image') &&
        (a.origin.type === 'import' || a.origin.type === 'generated') &&
        isBlankClip(project.analysis.visual[a.id]),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
}

/** File names as notes quote them: “clip08.webm”, “a very long name…ar.mp4”. */
export const quotedFileNames = (names: readonly string[]) =>
  names.map((n) => `“${shortFileName(n)}”`).join(', ')

/** Says which clips were left out because they show nothing, or undefined when none were. */
export function blankClipsNote(names: readonly string[]): string | undefined {
  if (!names.length) return undefined
  if (names.length === 1)
    return `Left out ${quotedFileNames(names)} because every frame of it is black or see-through.`
  return `Left out ${names.length} clips because every frame of them is black or see-through: ${quotedFileNames(names)}.`
}

/** Says which chosen clips were used although they show nothing, or undefined when none were. */
export function blankClipsUsedNote(names: readonly string[]): string | undefined {
  if (!names.length) return undefined
  if (names.length === 1)
    return `Used ${quotedFileNames(names)} because you chose it, but every frame of it is black or see-through.`
  return `Used ${names.length} clips because you chose them, but every frame of them is black or see-through: ${quotedFileNames(names)}.`
}

/** Checked clips and images enough to draft or cut from without the unchecked ones: at least this many. */
const ENOUGH_CHECKED = 3

const mediaCount = (media: readonly { kind: 'video' | 'image' }[]) => {
  const clips = media.filter((m) => m.kind === 'video').length
  const images = media.length - clips
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  return [clips ? count(clips, 'clip') : '', images ? count(images, 'image') : '']
    .filter(Boolean)
    .join(' and ')
}

/**
 * Leaves out the clips and images the fast blank check didn't reach in time (`unchecked`, from
 * `FootageService.checkBlank`), which may show nothing, when the checked ones are enough to choose from: at least
 * `ENOUGH_CHECKED` of them and at least as many as the unchecked. Otherwise, or when the user chose them (`keep`),
 * they are used. Either way the note says so and how to redo the result once they are checked (`rerun`: "Draft
 * again"). Media checked since `unchecked` was reported counts as checked.
 */
export function withoutUnchecked<T extends { assetId: Id; kind: 'video' | 'image' }>(
  project: Project,
  pool: readonly T[],
  unchecked: readonly Id[],
  options: { rerun: string; keep?: boolean },
): { pool: T[]; note?: string } {
  const left = new Set(unchecked.filter((id) => !hasBlankVerdict(project.analysis.visual[id])))
  const risky = pool.filter((m) => left.has(m.assetId))
  if (!risky.length) return { pool: [...pool] }
  const one = risky.length === 1
  const checked = pool.length - risky.length
  if (!options.keep && checked >= Math.max(ENOUGH_CHECKED, risky.length))
    return {
      pool: pool.filter((m) => !left.has(m.assetId)),
      note: `Left out ${mediaCount(risky)} that ${one ? 'wasn’t' : 'weren’t'} checked yet, in case ${one ? 'it shows' : 'they show'} nothing. ${options.rerun} to use ${one ? 'it' : 'them'}.`,
    }
  return {
    pool: [...pool],
    note: `${mediaCount(risky)} ${one ? 'wasn’t' : 'weren’t'} checked yet, so ${one ? 'it' : 'one of them'} may show nothing. ${options.rerun} to check ${one ? 'it' : 'them'}.`,
  }
}
/**
 * Words describing a clip, from footage analysis: what's in it, its mood and motion ("crowd", "lights",
 * "energetic", "fast"), stored as `VisualAnalysis.data.tags`. Null until the clip is analyzed; an empty list when
 * nothing stands out.
 */
export function readClipTags(analysis: VisualAnalysis | undefined): string[] | null {
  if (analysis?.version !== VISION_ANALYSIS_VERSION) return null
  const { tags } = analysis.data
  return Array.isArray(tags) && tags.every((t) => typeof t === 'string') ? tags : null
}

/** A clip's analysis with its tags set, keeping everything else. */
export function withClipTags(analysis: VisualAnalysis, tags: readonly string[]): VisualAnalysis {
  return { ...analysis, data: { ...analysis.data, tags: [...tags] } }
}
const SOURCES = new Set<SubjectSample['source']>(['face', 'person', 'selection', 'none'])

export function readSubjectTrack(analysis: VisualAnalysis | undefined): SubjectTrack | null {
  if (analysis?.version !== VISION_ANALYSIS_VERSION) return null
  const { subjects, sourceSize } = analysis.data
  if (!isObject(subjects) || !Array.isArray(subjects.samples) || !isObject(sourceSize)) return null
  if (typeof sourceSize.width !== 'number' || typeof sourceSize.height !== 'number') return null
  const samples: SubjectSample[] = []
  for (const s of subjects.samples) {
    if (!isObject(s) || typeof s.t !== 'number' || typeof s.fx !== 'number' || typeof s.fy !== 'number')
      return null
    if (
      typeof s.c !== 'number' ||
      typeof s.src !== 'string' ||
      !SOURCES.has(s.src as SubjectSample['source'])
    )
      return null
    const box = isNumbers(s.box) && s.box.length === 4 ? s.box : null
    samples.push({
      t: s.t,
      focus: { x: s.fx, y: s.fy },
      box: box ? { x: box[0]!, y: box[1]!, width: box[2]!, height: box[3]! } : null,
      confidence: s.c,
      source: s.src as SubjectSample['source'],
    })
  }
  return {
    version: 1,
    mediaId: analysis.assetId,
    sourceSize: { width: sourceSize.width, height: sourceSize.height },
    samples,
  }
}

function readCuts(analysis: VisualAnalysis | undefined): number[] {
  if (analysis?.version !== VISION_ANALYSIS_VERSION) return []
  const { motion } = analysis.data
  return isObject(motion) && isNumbers(motion.cuts) ? motion.cuts : []
}

/**
 * Virtual camera path that reframes an asset to `aspect` from its stored subject track; sample it with `cropAt` at
 * the clip's source time. Shot changes found when the clip was indexed become hard cuts unless `options.cuts` is
 * given. Without usable subject data (not analysed yet, or from another version) the plan is a static centred crop,
 * and stretches where nobody was found hold the last framing, so callers need no fallback of their own.
 */
export function reframePlanFor(
  asset: Pick<Asset, 'id' | 'width' | 'height'>,
  analysis: VisualAnalysis | undefined,
  aspect: ReframeAspect,
  options: ReframeOptions = {},
): ReframePlan {
  const track: SubjectTrack = readSubjectTrack(analysis) ?? {
    version: 1,
    mediaId: asset.id,
    sourceSize: { width: asset.width ?? 16, height: asset.height ?? 9 },
    samples: [],
  }
  return planReframe(track, aspect, { ...options, cuts: options.cuts ?? readCuts(analysis) })
}
/** Matching indexes of every analysed asset in the project, for `FootageMatcher.rank`. */
export function projectLibrary(project: Pick<Project, 'analysis'>): ClipVisionIndex[] {
  return Object.values(project.analysis.visual)
    .map(readClipIndex)
    .filter((i): i is ClipVisionIndex => i !== null)
}
