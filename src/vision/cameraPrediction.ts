import { prepareDepthForParallax, suggestFocus } from './depth/prepare.ts'
import { straightLines } from './render/bend.ts'
import {
  localContrast,
  safeAmounts,
  safeBend,
  type DepthField,
  type SafeAmounts,
  type SmearScene,
} from './render/smear.ts'
import { rgbaToGrayFast, toRgba } from './runtime/canvas.ts'
import type { CameraPreset, DepthMap, GrayImage } from './types.ts'

/**
 * What a camera move is predicted to do to its still. The depth is prepared, the scene (depth, contrast, straight
 * lines) is built and the smear and bend searches run here, in the camera worker (`workers/camera.worker.ts`): in the
 * browser they take 50 to 300 ms per still, too long for the page's thread.
 */

/**
 * The still to predict from: a fresh depth estimate with the still's luma at the estimate's size, or a stored depth
 * image and its still, decoded here and cached by `key` (the depth image's asset id) for the last few depth images.
 */
export type PredictionSource =
  { estimate: DepthMap; gray: GrayImage } | { key: string; depthImage: Blob; still: Blob }

export interface PredictionRequest {
  source: PredictionSource
  preset: CameraPreset
  /** The move's focus; left out, the one `suggestFocus` gives for the depth. */
  focus?: number
  /**
   * Presets the user could pick instead, checked when `preset` bends the still's straight lines at an amount under
   * `floor` (the lowest automatic amount).
   */
  alternatives?: { presets: readonly CameraPreset[]; floor: number }
}

export interface CameraPrediction {
  focus: number
  safe: SafeAmounts
  /** `preset` and every one of `alternatives` bend the still's straight lines at some amount up to `floor`. */
  alwaysBends: boolean
  /** For a fresh estimate: the estimate prepared for the parallax renderer, which the move renders and stores. */
  prepared?: DepthMap
}

export async function predictCameraMove(request: PredictionRequest): Promise<CameraPrediction> {
  const { source, preset, alternatives } = request
  let prepared: DepthMap | undefined
  let scene: SmearScene
  if ('key' in source) scene = await storedScene(source)
  else {
    prepared = prepareDepthForParallax(source.estimate)
    scene = sceneOf(prepared, source.gray)
  }
  const focus = request.focus ?? suggestFocus(scene.depth)
  const safe = safeAmounts(scene, preset, focus)
  const alwaysBends =
    !!alternatives &&
    safe.bend < alternatives.floor &&
    alternatives.presets.every(
      (p) => p === preset || safeBend(scene, p, focus, alternatives.floor) < alternatives.floor,
    )
  return { focus, safe, alwaysBends, ...(prepared ? { prepared } : {}) }
}

function sceneOf(depth: DepthField, gray: GrayImage): SmearScene {
  return { depth, contrast: localContrast(gray), lines: straightLines(gray) }
}

const scenes = new Map<string, Promise<SmearScene>>()
const SCENE_CACHE_SIZE = 4

function storedScene(source: { key: string; depthImage: Blob; still: Blob }): Promise<SmearScene> {
  let scene = scenes.get(source.key)
  if (!scene) {
    scene = loadScene(source.depthImage, source.still)
    scenes.set(source.key, scene)
    scene.catch(() => scenes.delete(source.key))
    if (scenes.size > SCENE_CACHE_SIZE) scenes.delete(scenes.keys().next().value!)
  }
  return scene
}

async function loadScene(depthFile: Blob, stillFile: Blob): Promise<SmearScene> {
  const [depthImage, image] = await Promise.all([createImageBitmap(depthFile), createImageBitmap(stillFile)])
  try {
    const size = { width: depthImage.width, height: depthImage.height }
    const rgba = toRgba(depthImage, size)
    const data = new Uint8Array(size.width * size.height)
    for (let i = 0; i < data.length; i++) data[i] = rgba.data[i * 4]!
    return sceneOf({ ...size, data }, rgbaToGrayFast(toRgba(image, size)))
  } finally {
    depthImage.close()
    image.close()
  }
}
