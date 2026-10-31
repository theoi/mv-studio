import { describe, expect, it } from 'vitest'
import { createAudioSampler } from '../../../src/engine/audioFeatures.ts'
import { visibleLayers } from '../../../src/engine/compositor.ts'
import { planFrame } from '../../../src/engine/layout.ts'
import {
  anim,
  createImageClip,
  createProject,
  createSolidClip,
  createTextClip,
  createTrack,
  createVideoClip,
  newId,
  type Asset,
  type Project,
  type VisualClip,
} from '../../../src/model/index.ts'

const CANVAS = { width: 1920, height: 1080 }

function asset(kind: 'video' | 'image', mimeType: string, width = 1920, height = 1080): Asset {
  return {
    id: newId(),
    kind,
    name: 'media',
    mimeType,
    byteSize: 1,
    storageKey: 'media/x',
    duration: 10,
    width,
    height,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
}

/** A project with one clip per track; clips[0] is the top layer. */
function stack(clips: ((trackId: string, p: Project) => VisualClip)[]): { project: Project; ids: string[] } {
  const project = createProject()
  project.tracks = clips.map(() => createTrack('visual'))
  const ids = clips.map((make, i) => {
    const clip = make((project.tracks[i] as { id: string }).id, project)
    project.clips[clip.id] = clip
    return clip.id
  })
  return { project, ids }
}

function video(mime = 'video/mp4', setup: (c: VisualClip) => void = () => {}) {
  return (trackId: string, p: Project) => {
    const a = asset('video', mime)
    p.assets[a.id] = a
    const clip = createVideoClip({ trackId, assetId: a.id, start: 0, duration: 5 })
    setup(clip)
    return clip
  }
}

const solid =
  (color: string, setup: (c: VisualClip) => void = () => {}) =>
  (trackId: string) => {
    const clip = createSolidClip({ trackId, color, start: 0, duration: 5 })
    setup(clip)
    return clip
  }

const text = (trackId: string) => createTextClip({ trackId, text: 'Hi', start: 0, duration: 5 })

/** Ids of the clips drawn at t = 1, top layer first. */
function drawn(project: Project): string[] {
  const layers = visibleLayers(planFrame(project, 1), project, 1, CANVAS, createAudioSampler(project))
  return layers.flatMap((l) => (l.kind === 'transition' ? [] : [l.clip.id])).reverse()
}

describe('visibleLayers', () => {
  it('drops everything under a full-canvas opaque video, but keeps the layers above it', () => {
    const { project, ids } = stack([text, video(), solid('#ff0000'), video()])
    expect(drawn(project)).toEqual(ids.slice(0, 2))
  })

  it('drops layers under an opaque solid, and a cover video scaled up and rotated', () => {
    expect(drawn(stack([solid('#00ff00'), video()]).project)).toHaveLength(1)
    const tilted = video('video/mp4', (c) => {
      c.transform.rotation = anim(5)
      c.transform.scaleX = anim(1.3)
      c.transform.scaleY = anim(1.3)
    })
    expect(drawn(stack([tilted, video()]).project)).toHaveLength(1)
  })

  it('keeps layers that show through: rotation gaps, transparency, effects, blend modes, mattes, contain fit', () => {
    const cases: [string, (trackId: string, p: Project) => VisualClip][] = [
      ['rotated without enough scale', video('video/mp4', (c) => (c.transform.rotation = anim(5)))],
      ['scaled down', video('video/mp4', (c) => (c.transform.scaleX = anim(0.99)))],
      ['moved', video('video/mp4', (c) => (c.transform.x = anim(0.51)))],
      ['semi-transparent', video('video/mp4', (c) => (c.opacity = anim(0.99)))],
      ['WebM (may have alpha)', video('video/webm')],
      ['translucent solid', solid('#ff000080')],
      [
        'effect',
        video('video/mp4', (c) => c.effects.push({ id: 'e', effectId: 'blur', enabled: true, params: {} })),
      ],
      ['blend mode', video('video/mp4', (c) => (c.blendMode = 'screen'))],
      [
        'matte',
        video(
          'video/mp4',
          (c) => (c.matte = { maskAssetId: 'm', sourceAssetId: 's', mode: 'inside', feather: 0 }),
        ),
      ],
      [
        '4:3 video with contain fit',
        (trackId, p) => {
          const a = asset('video', 'video/mp4', 1440, 1080)
          p.assets[a.id] = a
          const clip = createVideoClip({ trackId, assetId: a.id, start: 0, duration: 5 })
          clip.fit = 'contain'
          return clip
        },
      ],
      [
        'PNG image',
        (trackId, p) => {
          const a = asset('image', 'image/png')
          p.assets[a.id] = a
          return createImageClip({ trackId, assetId: a.id, start: 0, duration: 5 })
        },
      ],
    ]
    for (const [name, top] of cases) expect(drawn(stack([top, video()]).project), name).toHaveLength(2)
  })

  it('drops plain layers entirely outside the canvas or fully transparent, keeping ones with effects', () => {
    const outside = (c: VisualClip) => (c.transform.x = anim(1.6))
    const { project, ids } = stack([
      solid('#ff0000', outside),
      solid('#00ff00', (c) => (c.opacity = anim(0))),
      solid('#0000ff', (c) => {
        outside(c)
        c.effects.push({ id: 'e', effectId: 'glow', enabled: true, params: {} })
      }),
      solid('#ffffff', (c) => (c.transform.x = anim(1.4))),
    ])
    expect(drawn(project)).toEqual([ids[2], ids[3]])
  })
})
