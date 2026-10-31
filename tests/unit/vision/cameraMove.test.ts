import { describe, expect, it } from 'vitest'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createImageClip, createProject } from '../../../src/model/factory.ts'
import type { Asset, ImageClip, Project } from '../../../src/model/types.ts'
import { cameraMoveCommands, cameraMoveEffect, findDepthAsset } from '../../../src/vision/cameraMove.ts'
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
