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
import { VISION_MODELS } from '../../../src/vision/runtime/models.ts'

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
  it('adds every move in one undo step and estimates each still’s depth once', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 64, height: 36, close: () => undefined }))
    const { project, clipId } = setup()
    const track = project.tracks.find((t) => t.kind === 'visual')!
    project.assets.other = asset('other', { type: 'import' })
    project.assets.depth = depthAsset
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
    const media = {
      getFile: async () => new Blob(),
      storeBlob: async (): Promise<Asset> => {
        throw new Error('depth images already stored')
      },
    }

    const result = await addCameraMoves({ editor, media, depth }, [clipId, again.id, second.id], {
      preset: 'pan-left',
      intensity: 0.3,
    })

    expect(estimated).toEqual(['still', 'other'])
    expect(result.label).toBe('Add 3D camera moves to 3 images')
    expect(result.moves.map((m) => m.depthAssetId)).toEqual(['depth', 'depth', 'otherDepth'])
    const after = editor.getProject()
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
