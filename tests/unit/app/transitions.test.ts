import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createImageClip,
  createProject,
  createVideoClip,
  type Asset,
  type Project,
} from '../../../src/model/index.ts'
import { editor } from '../../../src/app/state/project.ts'
import {
  addTransitionAtCut,
  bareCuts,
  changeTransitionKind,
  maxTransitionDuration,
  removeTransition,
  setTransitionDuration,
  transitionSpots,
} from '../../../src/app/state/transitions.ts'
import { get, set } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

const asset = (id: string, kind: Asset['kind']): Asset => ({
  id,
  kind,
  name: id,
  mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
  byteSize: 1,
  storageKey: id,
  origin: { type: 'import' },
  createdAt: new Date(0).toISOString(),
})

/** Footage cut at 4 s and 8 s, then a gap before 14 s; the clip after the 8 s cut is 0.6 s long. */
function scene() {
  const p: Project = createProject({ name: 'transitions' })
  const track = p.tracks[0]!
  p.assets = { v: asset('v', 'video'), i: asset('i', 'image') }
  const a = createVideoClip({ trackId: track.id, assetId: 'v', start: 0, duration: 4 })
  const b = createImageClip({ trackId: track.id, assetId: 'i', start: 4, duration: 4 })
  const c = createVideoClip({ trackId: track.id, assetId: 'v', start: 8, duration: 0.6 })
  const d = createVideoClip({ trackId: track.id, assetId: 'v', start: 14, duration: 4 })
  for (const clip of [a, b, c, d]) p.clips[clip.id] = clip
  editor.load(p)
  set({ selection: { type: 'none' } })
  return { track, a, b, c, d }
}

const transitionIn = (id: string) => {
  const clip = editor.getProject().clips[id]
  return clip && 'transitionIn' in clip ? clip.transitionIn : undefined
}

describe('transitions on the timeline', () => {
  it('finds cuts without a transition, not clips after a gap, and lists a transition at a cut with its clips', () => {
    const s = scene()
    expect(bareCuts(editor.getProject(), s.track.id)).toEqual([
      { clipId: s.b.id, time: 4 },
      { clipId: s.c.id, time: 8 },
    ])
    addTransitionAtCut(s.b.id)
    expect(bareCuts(editor.getProject(), s.track.id).map((c) => c.clipId)).toEqual([s.c.id])
    expect(transitionSpots(editor.getProject(), s.track.id)).toEqual([
      expect.objectContaining({ clipId: s.b.id, edge: 'in', start: 4, fromId: s.a.id }),
    ])
  })

  it('keeps a transition to half the clip, and never over 4 s', () => {
    const s = scene()
    expect(maxTransitionDuration(s.c)).toBeCloseTo(0.3)
    expect(maxTransitionDuration(s.b)).toBe(2)
    expect(maxTransitionDuration({ ...s.d, duration: 20 })).toBe(4)
  })
})

describe('editing a transition', () => {
  it('adds a fade at a cut, sized to the clip and selected, as one undo step', () => {
    const s = scene()
    addTransitionAtCut(s.c.id)
    expect(transitionIn(s.c.id)).toMatchObject({ kind: 'fade', duration: maxTransitionDuration(s.c) })
    expect(get().selection).toEqual({ type: 'transition', id: s.c.id, edge: 'in' })
    editor.undo()
    expect(transitionIn(s.c.id)).toBeUndefined()
  })

  it('keeps the duration and easing when the type changes', () => {
    const s = scene()
    addTransitionAtCut(s.b.id)
    setTransitionDuration(s.b.id, 'in', 1.2)
    editor.endGesture()
    changeTransitionKind(s.b.id, 'in', 'wipe')
    expect(transitionIn(s.b.id)).toMatchObject({ kind: 'wipe', duration: 1.2, easing: 'ease-in-out' })
  })

  it('makes one undo step of a slider drag and stops at the longest the clip allows', () => {
    const s = scene()
    addTransitionAtCut(s.b.id)
    const before = transitionIn(s.b.id)!.duration
    setTransitionDuration(s.b.id, 'in', 1)
    setTransitionDuration(s.b.id, 'in', 9)
    editor.endGesture()
    expect(transitionIn(s.b.id)?.duration).toBe(2)
    editor.undo()
    expect(transitionIn(s.b.id)?.duration).toBe(before)
  })

  it('removing the selected transition selects its clip, and undo brings the transition back', () => {
    const s = scene()
    addTransitionAtCut(s.b.id)
    removeTransition(s.b.id, 'in')
    expect(transitionIn(s.b.id)).toBeUndefined()
    expect(get().selection).toEqual({ type: 'clip', id: s.b.id })
    editor.undo()
    expect(transitionIn(s.b.id)).toMatchObject({ kind: 'fade' })
  })
})
