import type { EditCommand } from '../model/commands.ts'
import type { ProjectEditor } from '../model/editor.ts'
import { newId } from '../model/factory.ts'
import type { Asset, EffectInstance, Id, ImageClip, Project } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import { prepareDepthForParallax, suggestFocus } from './depth/prepare.ts'
import type { DepthService } from './depth/service.ts'
import { throwIfAborted, visionError } from './errors.ts'
import { CAMERA_EFFECT_ID, DEFAULT_CAMERA_PRESET } from './render/cameraEffect.ts'
import { fitSize } from './runtime/frames.ts'
import { VISION_MODELS } from './runtime/models.ts'
import { createProgress, type TaskOptions } from './runtime/tasks.ts'
import type { CameraPreset, DepthMap } from './types.ts'

const DEPTH_MODEL = VISION_MODELS.depthAnythingSmall.id
const DEFAULT_INTENSITY = 0.5

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
  /** 0..1, default 0.5. */
  intensity?: number
}

export interface CameraMovesResult {
  moves: { clipId: Id; effectInstanceId: Id; depthAssetId: Id }[]
  /** Undo label of the dispatch that added them. */
  label: string
}

/**
 * "Add 3D camera move" on an image clip: estimates the still's depth (cached), stores it as a derived image asset
 * (reused when the project already has one for this still) and adds the camera effect with its progress keyframed
 * from the start to the end of the clip. The project changes in a single dispatch, so it is one undo step. A camera
 * move already on the clip is replaced.
 */
export async function addCameraMove(
  deps: CameraMoveDeps,
  clipId: Id,
  options: CameraMoveOptions = {},
): Promise<{ effectInstanceId: Id; depthAssetId: Id }> {
  const { moves } = await addCameraMoves(deps, [clipId], options)
  return moves[0]!
}

/**
 * `addCameraMove` on several image clips at once, all in one dispatch (one undo step). Progress runs through the
 * clips in order; clips of the same still share its depth map.
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
    const stills = new Map<Id, { depthAsset: Asset; newAsset: Asset | null; focus: number }>()
    for (const [i, clipId] of ids.entries()) {
      const still = stillOf(deps.editor.getProject(), clipId).asset
      if (stills.has(still.id)) continue
      const step = (f: number, stage?: string) => progress((i + f) / ids.length, stage)
      step(0, 'loading')
      const prepared = prepareDepthForParallax(await estimateDepth(deps, still, signal, step))
      let newAsset: Asset | null = null
      let depthAsset = findDepthAsset(deps.editor.getProject(), still.id)
      if (!depthAsset) {
        newAsset = await storeDepth(deps, still, prepared, step)
        depthAsset = newAsset
      }
      stills.set(still.id, { depthAsset, newAsset, focus: suggestFocus(prepared) })
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
      const effect = cameraMoveEffect(clip, still.depthAsset.id, {
        focus: still.focus,
        preset: options.preset,
        intensity: options.intensity,
      })
      commands.push(...cameraMoveCommands(clip, effect, added.has(asset.id) ? null : still.newAsset))
      added.add(asset.id)
      moves.push({ clipId, effectInstanceId: effect.id, depthAssetId: still.depthAsset.id })
    }
    const label = moves.length === 1 ? 'Add 3D camera move' : `Add 3D camera moves to ${moves.length} images`
    deps.editor.dispatch(commands, { label })
    progress(1)
    return { moves, label }
  } catch (err) {
    throw visionError(err, 'internal')
  }
}

async function estimateDepth(
  deps: CameraMoveDeps,
  still: Asset,
  signal: AbortSignal | undefined,
  progress: (f: number, stage?: string) => void,
): Promise<DepthMap> {
  const image = await createImageBitmap(await deps.media.getFile(still))
  try {
    return await deps.depth.get(
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
    origin: { type: 'derived', parentAssetId: still.id, provider: DEPTH_MODEL },
  })
}

function stillOf(project: Project, clipId: Id): { clip: ImageClip; asset: Asset } {
  const clip = project.clips[clipId]
  if (clip?.type !== 'image') throw new JobError('invalid-input', '3D camera moves need an image clip.')
  const asset = project.assets[clip.assetId]
  if (!asset) throw new JobError('invalid-input', 'The image of this clip is missing.')
  return { clip, asset }
}

/** Depth image stored earlier for `stillId`, if the project still has it. */
export function findDepthAsset(project: Pick<Project, 'assets'>, stillId: Id): Asset | undefined {
  return Object.values(project.assets).find(
    (a) =>
      a.kind === 'image' &&
      a.origin.type === 'derived' &&
      a.origin.parentAssetId === stillId &&
      a.origin.provider === DEPTH_MODEL,
  )
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
