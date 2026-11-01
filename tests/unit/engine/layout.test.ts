import { describe, expect, it } from 'vitest'
import {
  applyMat,
  fitSize,
  layerMatrix,
  layerUniforms,
  planEdges,
  planFrame,
} from '../../../src/engine/layout.ts'
import { anim, createProject, createSolidClip, createTrack } from '../../../src/model/factory.ts'
import type { Project, SolidClip, Track } from '../../../src/model/types.ts'

function setup(): { project: Project; top: Track; bottom: Track } {
  const project = createProject()
  const bottom = project.tracks.find((t) => t.kind === 'visual') as Track
  const top = createTrack('visual', 'Top')
  project.tracks.unshift(top)
  return { project, top, bottom }
}

function solid(
  project: Project,
  track: Track,
  start: number,
  duration: number,
  extra: Partial<SolidClip> = {},
) {
  const clip = { ...createSolidClip({ trackId: track.id, color: '#ffffff', start, duration }), ...extra }
  project.clips[clip.id] = clip
  return clip
}

const ids = (project: Project, time: number) =>
  planFrame(project, time).map((l) => (l.kind === 'transition' ? `${l.from?.id}>${l.to?.id}` : l.clip.id))

describe('planFrame', () => {
  it('draws lower tracks first and skips hidden tracks, disabled clips and clips not on screen', () => {
    const { project, top, bottom } = setup()
    const a = solid(project, bottom, 0, 4)
    const b = solid(project, top, 1, 2)
    solid(project, top, 5, 1)
    solid(project, bottom, 0, 4, { enabled: false })
    expect(ids(project, 1.5)).toEqual([a.id, b.id])
    expect(ids(project, 0.5)).toEqual([a.id])
    // A clip covers [start, start + duration).
    expect(ids(project, 3)).toEqual([a.id])
    top.hidden = true
    expect(ids(project, 1.5)).toEqual([a.id])
  })

  it('shows only soloed visual tracks when any track is soloed', () => {
    const { project, top, bottom } = setup()
    solid(project, bottom, 0, 4)
    const b = solid(project, top, 0, 4)
    top.solo = true
    expect(ids(project, 1)).toEqual([b.id])
  })

  it('pairs a transition-in with the clip that ends where it starts on the same track', () => {
    const { project, bottom } = setup()
    const a = solid(project, bottom, 0, 2)
    const b = solid(project, bottom, 2, 2, { transitionIn: { kind: 'fade', duration: 1, easing: 'linear' } })
    const [layer] = planFrame(project, 2.25)
    expect(layer).toMatchObject({ kind: 'transition', from: { id: a.id }, to: { id: b.id } })
    expect(layer?.kind === 'transition' && layer.progress).toBeCloseTo(0.25)
    expect(ids(project, 3.5)).toEqual([b.id])
  })

  it('fades from and to the layers below when no clip is adjacent', () => {
    const { project, bottom } = setup()
    const a = solid(project, bottom, 1, 3, {
      transitionIn: { kind: 'fade', duration: 0.5, easing: 'linear' },
      transitionOut: { kind: 'fade', duration: 1, easing: 'linear' },
    })
    expect(planFrame(project, 1.25)[0]).toMatchObject({
      kind: 'transition',
      from: null,
      to: { id: a.id },
      progress: 0.5,
    })
    const out = planFrame(project, 3.75)[0]
    expect(out).toMatchObject({ kind: 'transition', from: { id: a.id }, to: null })
    expect(out?.kind === 'transition' && out.progress).toBeCloseTo(0.75)
  })

  it('turns adjustment clips into adjustment layers in track order', () => {
    const { project, top, bottom } = setup()
    const a = solid(project, bottom, 0, 4)
    const base = createSolidClip({ trackId: top.id, color: '#000000', start: 0, duration: 4 })
    const { color: _color, ...rest } = base
    const adjustment = { ...rest, type: 'adjustment' as const }
    project.clips[adjustment.id] = adjustment
    expect(planFrame(project, 1).map((l) => l.kind)).toEqual(['clip', 'adjustment'])
    expect(ids(project, 1)).toEqual([a.id, adjustment.id])
  })
})

describe('planEdges', () => {
  it('gives every time between two of its edges the layers of the rest of that stretch', () => {
    const { project, top, bottom } = setup()
    const a = solid(project, bottom, 0, 4.3)
    const b = solid(project, bottom, 4.3, 3.1, {
      transitionIn: { kind: 'crossfade', duration: 0.7, easing: 'linear' },
      transitionOut: { kind: 'crossfade', duration: 0.45, easing: 'linear' },
    })
    solid(project, top, 1.15, 2.2, { transitionIn: { kind: 'zoom-blur', duration: 0.5, easing: 'linear' } })
    const { color: _color, ...rest } = createSolidClip({
      trackId: top.id,
      color: '#000000',
      start: 5.05,
      duration: 1.3,
    })
    const adjustment = { ...rest, type: 'adjustment' as const }
    project.clips[adjustment.id] = adjustment
    solid(project, top, 2, 6, { enabled: false })
    expect(ids(project, 4.6)).toEqual([`${a.id}>${b.id}`])
    const edges = planEdges(project)
    const shape = (time: number) =>
      planFrame(project, time).map((l) =>
        l.kind === 'transition' ? `${l.transition.kind}:${l.from?.id}>${l.to?.id}` : `${l.kind}:${l.clip.id}`,
      )
    const stretches = new Map<number, string>()
    let checked = 0
    for (let i = 0; i < 9 * 120; i++) {
      const time = i / 120
      if (edges.some((e) => Math.abs(e - time) < 1e-6)) continue
      const stretch = edges.filter((e) => e <= time).length
      const layers = shape(time).join(' ')
      expect(layers, `at ${time} s`).toBe(stretches.get(stretch) ?? layers)
      stretches.set(stretch, layers)
      checked++
    }
    expect(checked).toBeGreaterThan(1000)
    // Every stretch was seen, and they draw 8 different sets of layers.
    expect(stretches.size).toBe(edges.length)
    expect(new Set(stretches.values()).size).toBe(8)
  })
})
describe('fitSize', () => {
  it('fits, covers or stretches a source into the canvas', () => {
    expect(fitSize('contain', 640, 360, 1080, 1920)).toEqual([1080, 607.5])
    const [cw, ch] = fitSize('cover', 640, 360, 1080, 1920)
    expect(cw).toBeCloseTo(3413.33, 1)
    expect(ch).toBe(1920)
    expect(fitSize('stretch', 640, 360, 1080, 1920)).toEqual([1080, 1920])
  })
})

describe('layerMatrix', () => {
  const clip = (p: Project, t: Track) => solid(p, t, 0, 1)

  it('centers the base size on the canvas with the default transform', () => {
    const { project, bottom } = setup()
    const m = layerMatrix(clip(project, bottom), 0, 0, 100, 50, 400, 200)
    expect(applyMat(m, 0, 0)).toEqual([150, 75])
    expect(applyMat(m, 1, 1)).toEqual([250, 125])
  })

  it('rotates clockwise around the anchor and scales', () => {
    const { project, bottom } = setup()
    const c = clip(project, bottom)
    c.transform.rotation = anim(90)
    const [x, y] = applyMat(layerMatrix(c, 0, 0, 100, 50, 400, 200), 0, 0)
    // The top-left corner swings to the top-right of the anchor.
    expect(x).toBeCloseTo(225)
    expect(y).toBeCloseTo(50)
    c.transform.rotation = anim(0)
    c.transform.scaleX = anim(2)
    c.transform.anchorX = 0
    c.transform.anchorY = 0
    c.transform.x = {
      value: 0,
      keyframes: [
        { time: 0, value: 0, easing: 'linear' },
        { time: 1, value: 0.5, easing: 'linear' },
      ],
    }
    const m = layerMatrix(c, 0.5, 0.5, 100, 50, 400, 200)
    expect(applyMat(m, 0, 0)).toEqual([100, 100])
    expect(applyMat(m, 1, 1)).toEqual([300, 150])
  })
})

describe('layerUniforms', () => {
  const apply = (m: Float32Array, u: number, v: number): [number, number] => [
    m[0]! * u + m[3]! * v + m[6]!,
    m[1]! * u + m[4]! * v + m[7]!,
  ]

  it('maps layer uv (top-left) to effect uv (bottom-left) and back, through scale, position and rotation', () => {
    const { project, bottom } = setup()
    const c = solid(project, bottom, 0, 1)
    c.transform.x = anim(0.25)
    c.transform.y = anim(0.25)
    c.transform.scaleX = anim(0.5)
    c.transform.scaleY = anim(0.5)
    const { layerToCanvas, canvasToLayer } = layerUniforms(layerMatrix(c, 0, 0, 400, 200, 400, 200), 400, 200)
    // The layer centre sits at a quarter of the canvas from the top-left, i.e. y = 0.75 from the bottom.
    expect(apply(layerToCanvas, 0.5, 0.5)).toEqual([0.25, 0.75])
    // The 200 x 100 px layer centred at (100, 50) px starts at the canvas's top-left corner.
    expect(apply(layerToCanvas, 0, 0)).toEqual([0, 1])
    c.transform.rotation = anim(30)
    const rotated = layerUniforms(layerMatrix(c, 0, 0, 400, 200, 400, 200), 400, 200)
    for (const [u, v] of [
      [0, 0],
      [1, 0.3],
      [0.7, 1],
    ] as const) {
      const [x, y] = apply(rotated.layerToCanvas, u, v)
      const back = apply(rotated.canvasToLayer, x, y)
      expect(back[0]).toBeCloseTo(u, 5)
      expect(back[1]).toBeCloseTo(v, 5)
    }
    expect(apply(canvasToLayer, 0.25, 0.75)).toEqual([0.5, 0.5])
  })

  it('does not depend on the render resolution', () => {
    const { project, bottom } = setup()
    const c = solid(project, bottom, 0, 1)
    c.transform.x = anim(0.3)
    c.transform.rotation = anim(-20)
    c.transform.scaleY = anim(1.4)
    const full = layerUniforms(layerMatrix(c, 0, 0, 640, 360, 1920, 1080), 1920, 1080)
    const third = layerUniforms(layerMatrix(c, 0, 0, 640 / 3, 120, 640, 360), 640, 360)
    for (let i = 0; i < 9; i++) {
      expect(third.layerToCanvas[i]).toBeCloseTo(full.layerToCanvas[i]!, 5)
      expect(third.canvasToLayer[i]).toBeCloseTo(full.canvasToLayer[i]!, 5)
    }
  })

  it('treats the canvas as the layer without one, and sends everything outside a layer with no area', () => {
    const canvas = layerUniforms(null, 400, 200)
    expect(apply(canvas.canvasToLayer, 0, 1)).toEqual([0, 0])
    expect(apply(canvas.canvasToLayer, 1, 0)).toEqual([1, 1])
    const { project, bottom } = setup()
    const c = solid(project, bottom, 0, 1)
    c.transform.scaleX = anim(0)
    const flat = layerUniforms(layerMatrix(c, 0, 0, 400, 200, 400, 200), 400, 200)
    expect(apply(flat.canvasToLayer, 0.5, 0.5)).toEqual([-1, -1])
  })
})
