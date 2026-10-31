import { describe, expect, it } from 'vitest'
import { applyMat, fitSize, layerMatrix, planFrame } from '../../../src/engine/layout.ts'
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
