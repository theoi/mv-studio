import type { EditCommand } from '../model/commands.ts'
import type { ProjectEditor } from '../model/editor.ts'
import { newId } from '../model/factory.ts'
import type { Asset, AssetOrigin, EffectInstance, Id, ImageClip, Project } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import { prepareDepthForParallax, suggestFocus } from './depth/prepare.ts'
import type { DepthService } from './depth/service.ts'
import { throwIfAborted, visionError } from './errors.ts'
import { CAMERA_PRESETS } from './render/camera.ts'
import { CAMERA_EFFECT_ID, DEFAULT_CAMERA_PRESET } from './render/cameraEffect.ts'
import { straightLines } from './render/bend.ts'
import { localContrast, safeAmounts, type SafeAmounts, type SmearScene } from './render/smear.ts'
import { rgbaToGrayFast, toRgba } from './runtime/canvas.ts'
import { fitSize } from './runtime/frames.ts'
import { VISION_MODELS } from './runtime/models.ts'
import { createProgress, type TaskOptions } from './runtime/tasks.ts'
import type { CameraPreset, DepthMap, GrayImage } from './types.ts'

const DEPTH_MODEL = VISION_MODELS.depthAnythingSmall.id
/**
 * Bumped whenever `prepareDepthForParallax` makes something different of the same estimate. A depth image records
 * its preparation in its provider (`depthOrigin`), so one stored by an older preparation is prepared again the next
 * time a camera move is added to its still.
 */
export const DEPTH_PREPARATION_VERSION = 2
const PREPARED_PROVIDER = `${DEPTH_MODEL}/parallax-`
const DEFAULT_INTENSITY = 0.5
/** An automatic move goes no lower than this: below it the depth motion is hard to see. */
const MIN_AUTO_INTENSITY = 0.25

export interface CameraMoveDeps {
  editor: Pick<ProjectEditor, 'dispatch' | 'getProject'>
  /** `mediaStore` from src/media. */
  media: {
    getFile(asset: Asset): Promise<Blob>
    storeBlob(blob: Blob, info: Pick<Asset, 'kind' | 'name' | 'origin'>): Promise<Asset>
  }
  depth: DepthService
}

export interface CameraMoveOptions extends TaskOptions {
  preset?: CameraPreset
  /**
   * 0..1. A value set here is used as given, because the user chose it. Left out, each still gets 0.5, or less where
   * 0.5 is predicted to smear the background or bend straight lines (`safeAmounts` in render/smear.ts), but not
   * below 0.25.
   */
  intensity?: number
}

export interface CameraMoveResult {
  clipId: Id
  effectInstanceId: Id
  depthAssetId: Id
  /** The amount the move was added with. */
  intensity: number
  /** Largest amount predicted neither to smear nor to bend this still with this preset (0 to 1 in steps of 0.05). */
  safeIntensity: number
  /** The largest amounts predicted not to smear and not to bend, each on its own; `safeIntensity` is the smaller. */
  safe: SafeAmounts
  /** At `intensity`, the background next to foreground objects may smear. */
  smearRisk: boolean
  /** At `intensity`, straight lines (a tower's edges, window rows) may bend. */
  bendRisk: boolean
}

export interface CameraMovesResult {
  moves: CameraMoveResult[]
  /** Undo label of the dispatch that added them. */
  label: string
}

/**
 * "Add 3D camera move" on an image clip: estimates the still's depth (cached), stores it as a derived image asset
 * and adds the camera effect with its progress keyframed from the start to the end of the clip. When the project
 * already has a depth image for this still from the current preparation it is reused, and the focus and the smear
 * prediction come from it, since that is what the move renders. One from an older preparation is prepared again from
 * the cached estimate (or a new one), and older depth images of the still are removed once no effect uses them. The
 * project changes in a single dispatch, so it is one undo step. A camera move already on the clip is replaced.
 */
export async function addCameraMove(
  deps: CameraMoveDeps,
  clipId: Id,
  options: CameraMoveOptions = {},
): Promise<CameraMoveResult> {
  const { moves } = await addCameraMoves(deps, [clipId], options)
  return moves[0]!
}

/**
 * `addCameraMove` on several image clips at once, all in one dispatch (one undo step). Progress runs through the
 * clips in order; clips of the same still share its depth map and its smear prediction.
 */
export async function addCameraMoves(
  deps: CameraMoveDeps,
  clipIds: readonly Id[],
  options: CameraMoveOptions = {},
): Promise<CameraMovesResult> {
  const { signal } = options
  const progress = createProgress(options.onProgress)
  const ids = [...new Set(clipIds)]
  try {
    if (!ids.length) throw new JobError('invalid-input', 'Select an image clip for the 3D camera move.')
    const preset = options.preset ?? DEFAULT_CAMERA_PRESET
    const stills = new Map<
      Id,
      { depthAsset: Asset; newAsset: Asset | null; focus: number; safe: SafeAmounts }
    >()
    for (const [i, clipId] of ids.entries()) {
      const still = stillOf(deps.editor.getProject(), clipId).asset
      if (stills.has(still.id)) continue
      const step = (f: number, stage?: string) => progress((i + f) / ids.length, stage)
      step(0, 'loading')
      const stored = findDepthAsset(deps.editor.getProject(), still.id)
      let depthAsset: Asset
      let newAsset: Asset | null = null
      let scene: SmearScene
      if (stored && (depthPreparation(stored) ?? 0) >= DEPTH_PREPARATION_VERSION) {
        // The move renders the stored image, so predict from it.
        depthAsset = stored
        scene = await storedScene(deps.media, still, depthAsset)
      } else {
        const { depth, gray } = await estimateDepth(deps, still, signal, step)
        const prepared = prepareDepthForParallax(depth)
        scene = { depth: prepared, contrast: localContrast(gray), lines: straightLines(gray) }
        newAsset = await storeDepth(deps, still, prepared, step)
        depthAsset = newAsset
      }
      const focus = suggestFocus(scene.depth)
      stills.set(still.id, {
        depthAsset,
        newAsset,
        focus,
        safe: safeAmounts(scene, preset, focus),
      })
      throwIfAborted(signal)
    }
    const project = deps.editor.getProject()
    const commands: EditCommand[] = []
    const moves: CameraMovesResult['moves'] = []
    const added = new Set<Id>()
    for (const clipId of ids) {
      const { clip, asset } = stillOf(project, clipId)
      const still = stills.get(asset.id)
      if (!still) continue
      const safeIntensity = Math.min(still.safe.smear, still.safe.bend)
      const intensity =
        options.intensity ?? Math.max(MIN_AUTO_INTENSITY, Math.min(DEFAULT_INTENSITY, safeIntensity))
      const effect = cameraMoveEffect(clip, still.depthAsset.id, { focus: still.focus, preset, intensity })
      commands.push(...cameraMoveCommands(clip, effect, added.has(asset.id) ? null : still.newAsset))
      added.add(asset.id)
      moves.push({
        clipId,
        effectInstanceId: effect.id,
        depthAssetId: still.depthAsset.id,
        intensity,
        safeIntensity,
        safe: still.safe,
        smearRisk: intensity > still.safe.smear,
        bendRisk: intensity > still.safe.bend,
      })
    }
    // Depth images of these stills from older preparations go once no effect uses them.
    for (const [stillId, { depthAsset }] of stills)
      for (const a of Object.values(project.assets))
        if (
          a.id !== depthAsset.id &&
          a.origin.parentAssetId === stillId &&
          depthPreparation(a) !== null &&
          !usedElsewhere(project, a.id, ids)
        )
          commands.push({ type: 'asset.remove', assetId: a.id })
    const label = moves.length === 1 ? 'Add 3D camera move' : `Add 3D camera moves to ${moves.length} images`
    deps.editor.dispatch(commands, { label })
    progress(1)
    return { moves, label }
  } catch (err) {
    throw visionError(err, 'internal')
  }
}

/** The still's depth, and its luma at the depth map's size for the smear prediction. */
async function estimateDepth(
  deps: CameraMoveDeps,
  still: Asset,
  signal: AbortSignal | undefined,
  progress: (f: number, stage?: string) => void,
): Promise<{ depth: DepthMap; gray: GrayImage }> {
  const image = await createImageBitmap(await deps.media.getFile(still))
  try {
    const depth = await deps.depth.get(
      {
        mediaId: still.id,
        quality: 'full',
        sourceSize: { width: image.width, height: image.height },
        frame: (maxSide) => {
          const size = fitSize({ width: image.width, height: image.height }, maxSide)
          return createImageBitmap(image, {
            resizeWidth: size.width,
            resizeHeight: size.height,
            resizeQuality: 'high',
          })
        },
      },
      { signal, onProgress: (p) => progress(0.05 + 0.85 * (p.fraction ?? 0), p.stage) },
    )
    return { depth, gray: rgbaToGrayFast(toRgba(image, { width: depth.width, height: depth.height })) }
  } finally {
    image.close()
  }
}

async function storeDepth(
  deps: CameraMoveDeps,
  still: Asset,
  depth: DepthMap,
  progress: (f: number, stage?: string) => void,
): Promise<Asset> {
  progress(0.92, 'saving')
  return deps.media.storeBlob(await encodeDepthImage(depth), {
    kind: 'image',
    name: `${still.name.replace(/\.[^.]+$/, '')} (depth).png`,
    origin: depthOrigin(still.id),
  })
}

/**
 * Whether anything in the project refers to `assetId` (a clip's media, an effect or generator param such as a
 * visualizer's artwork, another asset's parent), apart from the camera moves being replaced on `replacing` clips.
 */
function usedElsewhere(project: Project, assetId: Id, replacing: readonly Id[]): boolean {
  const refers = (value: unknown): boolean =>
    value === assetId || (typeof value === 'object' && value !== null && Object.values(value).some(refers))
  return Object.entries(project).some(([key, value]) => {
    if (key === 'assets') return Object.values(project.assets).some((a) => a.id !== assetId && refers(a))
    if (key !== 'clips') return refers(value)
    return Object.values(project.clips).some((clip) =>
      refers(
        replacing.includes(clip.id) && 'effects' in clip
          ? { ...clip, effects: clip.effects.filter((e) => e.effectId !== CAMERA_EFFECT_ID) }
          : clip,
      ),
    )
  })
}

function stillOf(project: Project, clipId: Id): { clip: ImageClip; asset: Asset } {
  const clip = project.clips[clipId]
  if (clip?.type !== 'image') throw new JobError('invalid-input', '3D camera moves need an image clip.')
  const asset = project.assets[clip.assetId]
  if (!asset) throw new JobError('invalid-input', 'The image of this clip is missing.')
  return { clip, asset }
}

const scenes = new Map<Id, Promise<SmearScene>>()
const SCENE_CACHE_SIZE = 4

/**
 * Largest amount predicted neither to smear nor to bend a clip's still with `preset` (default: the clip's current
 * move), from its stored depth image; null when the clip has no 3D camera move. Same scale and steps as
 * `CameraMoveResult.safeIntensity`.
 */
export async function safeCameraIntensity(
  media: Pick<CameraMoveDeps['media'], 'getFile'>,
  project: Pick<Project, 'assets' | 'clips'>,
  clipId: Id,
  preset?: CameraPreset,
): Promise<number | null> {
  const safe = await safeCameraAmounts(media, project, clipId, preset)
  return safe && Math.min(safe.smear, safe.bend)
}

/**
 * The largest amounts at which a clip's still neither smears nor bends with `preset` (default: the clip's current
 * move), from its stored depth image; null when the clip has no 3D camera move. For a hint when the user sets a
 * stronger move than these, which can say what the move may do.
 */
export async function safeCameraAmounts(
  media: Pick<CameraMoveDeps['media'], 'getFile'>,
  project: Pick<Project, 'assets' | 'clips'>,
  clipId: Id,
  preset?: CameraPreset,
): Promise<SafeAmounts | null> {
  const clip = project.clips[clipId]
  if (clip?.type !== 'image') return null
  const effect = clip.effects.find((e) => e.effectId === CAMERA_EFFECT_ID)
  const depthId = effect?.params.depth?.value
  const still = project.assets[clip.assetId]
  const depthAsset = typeof depthId === 'string' ? project.assets[depthId] : undefined
  if (!effect || !still || !depthAsset) return null
  const focus = effect.params.focus?.value
  const current = effect.params.preset?.value
  const move = preset ?? CAMERA_PRESETS.find((p) => p === current) ?? DEFAULT_CAMERA_PRESET
  return safeAmounts(
    await storedScene(media, still, depthAsset),
    move,
    typeof focus === 'number' ? focus : 0.5,
  )
}

/** The smear scene of a stored depth image and its still, cached for the last few depth images. */
function storedScene(
  media: Pick<CameraMoveDeps['media'], 'getFile'>,
  still: Asset,
  depthAsset: Asset,
): Promise<SmearScene> {
  let scene = scenes.get(depthAsset.id)
  if (!scene) {
    scene = loadScene(media, still, depthAsset)
    scenes.set(depthAsset.id, scene)
    scene.catch(() => scenes.delete(depthAsset.id))
    if (scenes.size > SCENE_CACHE_SIZE) scenes.delete(scenes.keys().next().value!)
  }
  return scene
}

async function loadScene(
  media: Pick<CameraMoveDeps['media'], 'getFile'>,
  still: Asset,
  depthAsset: Asset,
): Promise<SmearScene> {
  const [depthImage, image] = await Promise.all([
    createImageBitmap(await media.getFile(depthAsset)),
    createImageBitmap(await media.getFile(still)),
  ])
  try {
    const size = { width: depthImage.width, height: depthImage.height }
    const rgba = toRgba(depthImage, size)
    const data = new Uint8Array(size.width * size.height)
    for (let i = 0; i < data.length; i++) data[i] = rgba.data[i * 4]!
    const gray = rgbaToGrayFast(toRgba(image, size))
    return { depth: { ...size, data }, contrast: localContrast(gray), lines: straightLines(gray) }
  } finally {
    depthImage.close()
    image.close()
  }
}

/** Origin of a depth image of `stillId` made by the current preparation. */
export function depthOrigin(stillId: Id): AssetOrigin {
  return {
    type: 'derived',
    parentAssetId: stillId,
    provider: `${PREPARED_PROVIDER}${DEPTH_PREPARATION_VERSION}`,
  }
}

/**
 * The preparation a stored depth image was made with: 1 for one stored before preparations were recorded (its
 * provider is the bare model id), null for an asset that is not a depth image.
 */
export function depthPreparation(asset: Asset): number | null {
  if (asset.kind !== 'image' || asset.origin.type !== 'derived') return null
  const { provider } = asset.origin
  if (provider === DEPTH_MODEL) return 1
  if (!provider?.startsWith(PREPARED_PROVIDER)) return null
  const version = Number(provider.slice(PREPARED_PROVIDER.length))
  return Number.isInteger(version) && version > 0 ? version : null
}

/** Depth image stored earlier for `stillId`, if the project still has one: the one from the latest preparation. */
export function findDepthAsset(project: Pick<Project, 'assets'>, stillId: Id): Asset | undefined {
  let found: Asset | undefined
  let latest = 0
  for (const a of Object.values(project.assets)) {
    const version = a.origin.parentAssetId === stillId ? depthPreparation(a) : null
    if (version !== null && version > latest) {
      found = a
      latest = version
    }
  }
  return found
}

/** Effect instance for a camera move across the whole clip (progress keyframed 0 -> 1; the move eases itself). */
export function cameraMoveEffect(
  clip: Pick<ImageClip, 'duration'>,
  depthAssetId: Id,
  options: { focus: number; preset?: CameraPreset | undefined; intensity?: number | undefined },
): EffectInstance {
  return {
    id: newId(),
    effectId: CAMERA_EFFECT_ID,
    enabled: true,
    params: {
      depth: { value: depthAssetId },
      preset: { value: options.preset ?? DEFAULT_CAMERA_PRESET },
      intensity: { value: options.intensity ?? DEFAULT_INTENSITY },
      focus: { value: Math.round(Math.min(1, Math.max(0, options.focus)) * 1000) / 1000 },
      progress: {
        value: 0,
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: clip.duration, value: 1, easing: 'linear' },
        ],
      },
    },
  }
}

/**
 * Commands that put `effect` first on the clip (so later effects such as grain or a vignette stay still), replacing
 * any camera move already there, and add the depth asset when it is new. Dispatch them together.
 */
export function cameraMoveCommands(
  clip: Pick<ImageClip, 'id' | 'effects'>,
  effect: EffectInstance,
  newAsset: Asset | null,
): EditCommand[] {
  return [
    ...(newAsset ? [{ type: 'asset.add' as const, asset: newAsset }] : []),
    ...clip.effects
      .filter((e) => e.effectId === CAMERA_EFFECT_ID)
      .map((e) => ({ type: 'effect.remove' as const, clipId: clip.id, effectInstanceId: e.id })),
    { type: 'effect.add', clipId: clip.id, effect, index: 0 },
  ]
}

/**
 * Grayscale PNG of a depth map (white = near), resampled to the source's aspect ratio: the model's input size is
 * rounded to its patch size, and the camera effect derives the image aspect from the depth image.
 */
export async function encodeDepthImage(depth: DepthMap): Promise<Blob> {
  const rgba = new Uint8ClampedArray(depth.width * depth.height * 4)
  for (let i = 0; i < depth.data.length; i++) {
    const v = depth.data[i]!
    rgba[i * 4] = v
    rgba[i * 4 + 1] = v
    rgba[i * 4 + 2] = v
    rgba[i * 4 + 3] = 255
  }
  const raw = new OffscreenCanvas(depth.width, depth.height)
  raw.getContext('2d')!.putImageData(new ImageData(rgba, depth.width, depth.height), 0, 0)
  const { width: sw, height: sh } = depth.sourceSize
  const width = Math.max(1, Math.round((depth.height * sw) / sh))
  if (width === depth.width) return raw.convertToBlob({ type: 'image/png' })
  const out = new OffscreenCanvas(width, depth.height)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(raw, 0, 0, width, depth.height)
  return out.convertToBlob({ type: 'image/png' })
}
