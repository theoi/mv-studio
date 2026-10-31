import { describe, expect, it, vi } from 'vitest'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createImageClip, createProject } from '../../../src/model/factory.ts'
import type { Asset, ImageClip, Project } from '../../../src/model/types.ts'
import {
  addCameraMoves,
  cameraMoveCommands,
  cameraMoveEffect,
  findDepthAsset,
} from '../../../src/vision/cameraMove.ts'
import { CAMERA_EFFECT_ID } from '../../../src/vision/render/cameraEffect.ts'
import type * as Canvas from '../../../src/vision/runtime/canvas.ts'
import { VISION_MODELS } from '../../../src/vision/runtime/models.ts'

// No canvas in unit tests. A stored depth image reads as `pictures.depth` (gray level by column, on a 96-column
// scale); a still reads as a fine checkerboard, a detailed background everywhere.
const pictures = vi.hoisted(() => {
  const p: { depth: (x: number) => number } = { depth: () => 100 }
  return p
})
vi.mock('../../../src/vision/runtime/canvas.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Canvas>()),
  toRgba: (source: { kind?: string }, size: { width: number; height: number }) => {
    const data = new Uint8ClampedArray(size.width * size.height * 4)
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++)
        data.fill(
          source.kind === 'depth'
            ? pictures.depth(Math.floor((x * 96) / size.width))
            : ((x >> 1) + (y >> 1)) % 2
              ? 200
              : 60,
          (y * size.width + x) * 4,
          (y * size.width + x) * 4 + 4,
        )
    return { ...size, data }
  },
}))

const DEPTH_TYPE = 'image/x-test-depth'

/** Bitmaps that know whether they came from a depth image, and a canvas that encodes nothing. */
function stubCanvas() {
  vi.stubGlobal('createImageBitmap', async (blob: Blob) =>
    blob.type === DEPTH_TYPE
      ? { kind: 'depth', width: 192, height: 108, close: () => undefined }
      : { kind: 'still', width: 960, height: 540, close: () => undefined },
  )
  vi.stubGlobal('ImageData', class {})
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { putImageData: () => undefined, drawImage: () => undefined }
      }
      async convertToBlob() {
        return new Blob([], { type: DEPTH_TYPE })
      }
    },
  )
}

const fileOf = async (a: Asset) =>
  new Blob([], { type: a.id.toLowerCase().includes('depth') ? DEPTH_TYPE : 'image/png' })
const DEPTH_MODEL = VISION_MODELS.depthAnythingSmall.id

function asset(id: string, origin: Asset['origin'], kind: Asset['kind'] = 'image'): Asset {
  return {
    id,
    kind,
    name: `${id}.png`,
    mimeType: 'image/png',
    byteSize: 10,
    storageKey: id,
    origin,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function setup(): { project: Project; clipId: string } {
  const project = createProject({ name: 'stills' })
  project.assets.still = asset('still', { type: 'import' })
  const track = project.tracks.find((t) => t.kind === 'visual')!
  const clip = createImageClip({ trackId: track.id, assetId: 'still', start: 2, duration: 5 })
  clip.fit = 'contain'
  clip.effects = [{ id: 'vignette', effectId: 'vignette', enabled: true, params: {} }]
  project.clips[clip.id] = clip
  return { project, clipId: clip.id }
}

function imageClip(project: Project, id: string): ImageClip {
  const clip = project.clips[id]
  if (clip?.type !== 'image') throw new Error('image clip expected')
  return clip
}

const depthAsset = asset('depth', { type: 'derived', parentAssetId: 'still', provider: DEPTH_MODEL })

describe('3D camera move', () => {
  it('keyframes progress over the whole clip', () => {
    const { project, clipId } = setup()
    const effect = cameraMoveEffect(imageClip(project, clipId), 'depth', {
      focus: 1.37,
      preset: 'orbit-left',
    })
    expect(effect.effectId).toBe(CAMERA_EFFECT_ID)
    expect(effect.params.progress!.keyframes).toEqual([
      { time: 0, value: 0, easing: 'linear' },
      { time: 5, value: 1, easing: 'linear' },
    ])
    expect(effect.params.depth!.value).toBe('depth')
    expect(effect.params.preset!.value).toBe('orbit-left')
    expect(effect.params.focus!.value).toBe(1)
  })

  it('adds the depth asset and the effect as one undo step, before the clip’s other effects', () => {
    const { project, clipId } = setup()
    const editor = new ProjectEditor(project)
    const clip = imageClip(editor.getProject(), clipId)
    const effect = cameraMoveEffect(clip, depthAsset.id, { focus: 0.7 })
    editor.dispatch(cameraMoveCommands(clip, effect, depthAsset))

    const after = editor.getProject()
    expect(after.assets.depth).toEqual(depthAsset)
    expect(imageClip(after, clipId).effects.map((e) => e.effectId)).toEqual([CAMERA_EFFECT_ID, 'vignette'])
    expect(editor.undo()).toBe(true)
    expect(editor.getProject().assets.depth).toBeUndefined()
    expect(imageClip(editor.getProject(), clipId).effects.map((e) => e.id)).toEqual(['vignette'])
    expect(editor.canUndo()).toBe(false)
  })

  it('replaces a camera move already on the clip and reuses a stored depth asset', () => {
    const { project, clipId } = setup()
    const editor = new ProjectEditor(project)
    const first = imageClip(editor.getProject(), clipId)
    editor.dispatch(cameraMoveCommands(first, cameraMoveEffect(first, 'depth', { focus: 0.5 }), depthAsset))
    const second = imageClip(editor.getProject(), clipId)
    const replacement = cameraMoveEffect(second, 'depth', { focus: 0.5, preset: 'pan-left' })
    editor.dispatch(cameraMoveCommands(second, replacement, null))
    const effects = imageClip(editor.getProject(), clipId).effects
    expect(effects.filter((e) => e.effectId === CAMERA_EFFECT_ID).map((e) => e.id)).toEqual([replacement.id])
    expect(Object.keys(editor.getProject().assets).sort()).toEqual(['depth', 'still'])
  })

  it('finds only depth images derived from the same still', () => {
    const assets = {
      still: asset('still', { type: 'import' }),
      mask: asset('mask', { type: 'derived', parentAssetId: 'still' }, 'video'),
      other: asset('other', { type: 'derived', parentAssetId: 'another', provider: DEPTH_MODEL }),
      depth: depthAsset,
    }
    expect(findDepthAsset({ assets }, 'still')?.id).toBe('depth')
    expect(findDepthAsset({ assets: { still: assets.still, mask: assets.mask } }, 'still')).toBeUndefined()
  })
})

describe('3D camera moves on several stills', () => {
  it('adds every move in one undo step, estimates a still’s depth once and reuses a stored depth image', async () => {
    stubCanvas()
    const { project, clipId } = setup()
    const track = project.tracks.find((t) => t.kind === 'visual')!
    project.assets.other = asset('other', { type: 'import' })
    project.assets.otherDepth = asset('otherDepth', {
      type: 'derived',
      parentAssetId: 'other',
      provider: DEPTH_MODEL,
    })
    const again = createImageClip({ trackId: track.id, assetId: 'still', start: 10, duration: 3 })
    const second = createImageClip({ trackId: track.id, assetId: 'other', start: 20, duration: 4 })
    project.clips[again.id] = again
    project.clips[second.id] = second
    const editor = new ProjectEditor(project)
    const estimated: string[] = []
    const depth = {
      async get(req: { mediaId: string; sourceSize: { width: number; height: number } }) {
        estimated.push(req.mediaId)
        const data = new Uint8Array(16 * 9).map((_, i) => (i % 16) * 16)
        return {
          version: 1 as const,
          width: 16,
          height: 9,
          data,
          sourceSize: req.sourceSize,
          model: DEPTH_MODEL,
          quality: 'full' as const,
        }
      },
      peek: async () => null,
    }
    const stored: string[] = []
    const media = {
      getFile: fileOf,
      storeBlob: async (_blob: Blob, info: { origin: Asset['origin'] }): Promise<Asset> => {
        stored.push(info.origin.type === 'derived' ? (info.origin.parentAssetId ?? '') : '')
        return depthAsset
      },
    }

    const result = await addCameraMoves({ editor, media, depth }, [clipId, again.id, second.id], {
      preset: 'pan-left',
      intensity: 0.3,
    })

    expect(estimated).toEqual(['still'])
    expect(stored).toEqual(['still'])
    expect(result.label).toBe('Add 3D camera moves to 3 images')
    expect(result.moves.map((m) => m.depthAssetId)).toEqual(['depth', 'depth', 'otherDepth'])
    const after = editor.getProject()
    expect(result.moves.map((m) => m.intensity)).toEqual([0.3, 0.3, 0.3])
    expect(result.moves.every((m) => m.smearRisk === m.intensity > m.safeIntensity)).toBe(true)
    for (const id of [clipId, again.id, second.id]) {
      const camera = imageClip(after, id).effects[0]!
      expect(camera.effectId).toBe(CAMERA_EFFECT_ID)
      expect(camera.params.preset!.value).toBe('pan-left')
      expect(camera.params.intensity!.value).toBe(0.3)
    }
    expect(editor.undoLabel()).toBe(result.label)
    expect(editor.undo()).toBe(true)
    expect(editor.canUndo()).toBe(false)
    for (const id of [clipId, again.id, second.id])
      expect(imageClip(editor.getProject(), id).effects.some((e) => e.effectId === CAMERA_EFFECT_ID)).toBe(
        false,
      )
    vi.unstubAllGlobals()
  })
})

describe('the amount of an automatic move', () => {
  let runs = 0
  const run = async (storedDepth: (x: number) => number, intensity?: number) => {
    stubCanvas()
    pictures.depth = storedDepth
    const { project, clipId } = setup()
    // A new id each time, as for a real depth image: predictions are cached per depth image.
    const id = `depth-${runs++}`
    project.assets[id] = asset(id, { type: 'derived', parentAssetId: 'still', provider: DEPTH_MODEL })
    const editor = new ProjectEditor(project)
    const depth = {
      get: async (): Promise<never> => {
        throw new Error('a still with a stored depth image is not estimated again')
      },
      peek: async () => null,
    }
    const media = {
      getFile: fileOf,
      storeBlob: async (): Promise<Asset> => {
        throw new Error('the depth image is already stored')
      },
    }
    const result = await addCameraMoves({ editor, media, depth }, [clipId], {
      preset: 'orbit-left',
      ...(intensity === undefined ? {} : { intensity }),
    })
    vi.unstubAllGlobals()
    const move = result.moves[0]!
    const effect = imageClip(editor.getProject(), clipId).effects[0]!
    return { move, stored: effect.params.intensity!.value }
  }
  // Thin near posts over a far, detailed background (the still reads as a fine checkerboard).
  const fence = (x: number) => (x % 12 < 2 ? 240 : 20)

  it('is 0.5 when nothing is predicted to smear', async () => {
    const { move, stored } = await run(() => 100)
    expect(move).toMatchObject({ intensity: 0.5, safeIntensity: 1, smearRisk: false })
    expect(stored).toBe(0.5)
  })

  it('drops to the safe amount predicted from the stored depth image, but not below 0.25', async () => {
    const { move, stored } = await run(fence)
    expect(move.safeIntensity).toBeLessThan(0.5)
    expect(move.intensity).toBe(Math.max(0.25, move.safeIntensity))
    expect(stored).toBe(move.intensity)
    expect(move.smearRisk).toBe(move.intensity > move.safeIntensity)
  })

  it('keeps an amount the user chose and flags the risk', async () => {
    const { move, stored } = await run(fence, 0.8)
    expect(stored).toBe(0.8)
    expect(move).toMatchObject({ intensity: 0.8, smearRisk: true })
    expect(move.safeIntensity).toBeLessThan(0.8)
  })
})
