import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createImageClip,
  createProject,
  createTextClip,
  createTrack,
  createVideoClip,
  type Asset,
  type Project,
} from '../../../src/model/index.ts'
import { currentLook, ORIGINAL_LOOK } from '../../../src/plugins/looks.ts'
import {
  addEffect,
  addTransition,
  addVisual,
  chooseLook,
  chosenLookId,
  dropLibraryItem,
  effectItems,
  effectTarget,
  endLibraryDrag,
  libraryDropHint,
  matchesQuery,
  startLibraryDrag,
  transitionTarget,
  visualPlacement,
} from '../../../src/app/state/library.ts'
import { editor } from '../../../src/app/state/project.ts'
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

/** Lyrics on top; footage cut at 4 s and 8 s with a gap before 14 s; a locked track with a clip under 2 s. */
function scene() {
  const p: Project = createProject({ name: 'library' })
  const footage = p.tracks[0]!
  const lyrics = createTrack('visual', 'Lyrics')
  const locked = { ...createTrack('visual', 'Locked'), locked: true }
  p.tracks = [lyrics, locked, footage, ...p.tracks.slice(1)]
  p.assets = { v: asset('v', 'video'), i: asset('i', 'image') }
  const a = {
    ...createVideoClip({ trackId: footage.id, assetId: 'v', start: 0, duration: 4 }),
    name: 'Night city',
  }
  const b = createImageClip({ trackId: footage.id, assetId: 'i', start: 4, duration: 4 })
  const c = createVideoClip({ trackId: footage.id, assetId: 'v', start: 8, duration: 3 })
  const d = createVideoClip({ trackId: footage.id, assetId: 'v', start: 14, duration: 4 })
  const top = createImageClip({ trackId: locked.id, assetId: 'i', start: 0, duration: 3 })
  const line = {
    ...createTextClip({ trackId: lyrics.id, text: 'Hello', start: 0, duration: 4 }),
    lyricLineId: 'l1',
  }
  for (const clip of [a, b, c, d, top, line]) p.clips[clip.id] = clip
  return { p, a, b, c, d, top, line }
}

describe('library search', () => {
  it('matches every word against names, categories, descriptions and tags', () => {
    const item = { name: 'Neon night', description: 'Cool night tones.', tags: ['club', 'synth'] }
    expect(matchesQuery('', item)).toBe(true)
    expect(matchesQuery('NEON club', item)).toBe(true)
    expect(matchesQuery('tones synth', item)).toBe(true)
    expect(matchesQuery('neon warm', item)).toBe(false)
  })

  it('lists color and texture effects as filters and leaves out effects that need a depth map', () => {
    const filters = effectItems('filters').map((e) => e.id)
    const effects = effectItems('effects').map((e) => e.id)
    expect(filters).toEqual(expect.arrayContaining(['vignette', 'film-grain', 'color-grade']))
    expect(effects).toEqual(expect.arrayContaining(['glow', 'zoom-pulse', 'rgb-split']))
    expect(effects.filter((id) => filters.includes(id))).toEqual([])
    expect([...effects, ...filters]).not.toContain('camera-3d')
  })
})

describe('where a clicked item lands', () => {
  it('puts an effect on the selection, else on the top unlocked video or image under the playhead', () => {
    const s = scene()
    expect(effectTarget(s.p, { type: 'clip', id: s.b.id }, 1)?.id).toBe(s.b.id)
    expect(effectTarget(s.p, { type: 'lyric', id: 'l1' }, 1)?.id).toBe(s.line.id)
    // The locked image above the footage and the lyric line are skipped.
    expect(effectTarget(s.p, { type: 'none' }, 1)?.id).toBe(s.a.id)
    expect(effectTarget(s.p, { type: 'none' }, 12)).toBeUndefined()
  })

  it('puts a transition on the selected clip, else on the cut nearest the playhead', () => {
    const s = scene()
    expect(transitionTarget(s.p, { type: 'clip', id: s.d.id }, 0)).toEqual({ clip: s.d, cut: false })
    expect(transitionTarget(s.p, { type: 'none' }, 6.5)).toEqual({ clip: s.c, cut: true })
    // 14 s follows a gap, so the nearest cut to 13 s is the one at 8 s.
    expect(transitionTarget(s.p, { type: 'none' }, 13)).toEqual({ clip: s.c, cut: true })
    expect(transitionTarget(s.p, { type: 'none' }, 1)).toEqual({ clip: s.b, cut: true })
  })
})

describe('adding from the library', () => {
  beforeEach(() => set({ selection: { type: 'none' }, playhead: 1, toasts: [] }))

  it('applies a look as one undo step, does nothing for the chosen look and removes it for Original', () => {
    const s = scene()
    editor.load(s.p)
    expect(chosenLookId(editor.getProject())).toBe(ORIGINAL_LOOK.id)
    chooseLook('warm')
    expect(chosenLookId(editor.getProject())).toBe('warm')
    expect(editor.undoLabel()).toBe('Apply look: Golden hour')
    expect(get().toasts.at(-1)?.message).toBe('Look “Golden hour” applied to the whole video')
    const applied = editor.getProject()
    chooseLook('warm')
    expect(editor.getProject()).toBe(applied)
    chooseLook(ORIGINAL_LOOK.id)
    expect(currentLook(editor.getProject())).toBeNull()
    expect(editor.undoLabel()).toBe('Remove look')
    get().toasts.at(-1)?.action?.run()
    expect(chosenLookId(editor.getProject())).toBe('warm')
  })

  it('adds an effect with its default audio mappings and selects the clip it went on', () => {
    const s = scene()
    editor.load(s.p)
    addEffect('zoom-pulse')
    const clip = editor.getProject().clips[s.a.id]!
    if (clip.type === 'audio') throw new Error('expected a picture clip')
    expect(clip.effects.map((e) => e.effectId)).toEqual(['zoom-pulse'])
    const mapped = Object.values(clip.effects[0]!.params).filter((p) => p.modulation?.length)
    expect(mapped.length).toBeGreaterThan(0)
    expect(editor.undoLabel()).toBe('Add effect: Zoom pulse')
    expect(get().selection).toEqual({ type: 'clip', id: s.a.id })
    expect(get().toasts.at(-1)?.message).toBe('“Zoom pulse” added to Night city')
  })

  it('puts a new transition on a cut, at most half the clip, and keeps the timing of one already there', () => {
    const s = scene()
    s.c.transitionIn = { kind: 'fade', duration: 0.9, easing: 'linear' }
    editor.load(s.p)
    set({ playhead: 3.8 })
    addTransition('flash')
    expect(editor.getProject().clips[s.b.id]).toMatchObject({ transitionIn: { kind: 'flash' } })
    expect(get().toasts.at(-1)?.message).toBe('“Flash” added to the cut at 0:04.0')
    expect(editor.undoLabel()).toBe('Add transition: Flash')
    set({ playhead: 8.2 })
    addTransition('whip-pan')
    expect(editor.getProject().clips[s.c.id]).toMatchObject({
      transitionIn: { kind: 'whip-pan', duration: 0.9, easing: 'linear' },
    })
    set({ selection: { type: 'clip', id: s.d.id } })
    addTransition('iris')
    const iris = editor.getProject().clips[s.d.id]
    expect(iris?.type !== 'audio' && iris?.transitionIn?.duration).toBeLessThanOrEqual(2)
    expect(get().toasts.at(-1)?.message).toMatch(/^“Iris” added to the start of /)
  })

  it('says what to do when nothing is under the playhead', () => {
    editor.load(scene().p)
    set({ playhead: 12 })
    addEffect('glow')
    expect(get().toasts.at(-1)?.message).toBe('Select a clip to add “Glow” to it')
  })
})

describe('dropping library items on the timeline', () => {
  beforeEach(() => set({ selection: { type: 'none' }, playhead: 1, toasts: [] }))

  it('puts a dropped effect on the clip under the drop and selects it, and says when nothing is there', () => {
    const s = scene()
    editor.load(s.p)
    dropLibraryItem({ kind: 'effect', id: 'glow' }, { trackId: s.b.trackId, time: 5 })
    const clip = editor.getProject().clips[s.b.id]
    expect(clip?.type !== 'audio' && clip?.effects.map((e) => e.effectId)).toEqual(['glow'])
    expect(get().selection).toEqual({ type: 'clip', id: s.b.id })
    expect(editor.undoLabel()).toBe('Add effect: Glow')
    dropLibraryItem({ kind: 'effect', id: 'glow' }, { trackId: s.b.trackId, time: 12 })
    expect(get().toasts.at(-1)?.message).toBe('Drop “Glow” on a clip')
  })

  it('puts a dropped transition on the nearer cut of the clip under the drop, else on that clip’s start', () => {
    const s = scene()
    editor.load(s.p)
    dropLibraryItem({ kind: 'transition', id: 'flash' }, { trackId: s.b.trackId, time: 7.4 })
    expect(editor.getProject().clips[s.c.id]).toMatchObject({ transitionIn: { kind: 'flash' } })
    expect(get().toasts.at(-1)?.message).toBe('“Flash” added to the cut at 0:08.0')
    // The clip after the gap has no cut of its own: it gets the transition, not the cut at 8 s.
    dropLibraryItem({ kind: 'transition', id: 'iris' }, { trackId: s.d.trackId, time: 15 })
    expect(editor.getProject().clips[s.d.id]).toMatchObject({ transitionIn: { kind: 'iris' } })
    expect(editor.getProject().clips[s.c.id]).toMatchObject({ transitionIn: { kind: 'flash' } })
    // The lyrics track has no cuts: the line under the drop gets it.
    dropLibraryItem({ kind: 'transition', id: 'iris' }, { trackId: s.line.trackId, time: 2 })
    expect(editor.getProject().clips[s.line.id]).toMatchObject({ transitionIn: { kind: 'iris' } })
    dropLibraryItem({ kind: 'transition', id: 'flash' }, { trackId: s.b.trackId, time: 12 })
    expect(get().toasts.at(-1)?.message).toBe('Drop “Flash” on a cut between two clips')
  })

  it('lands nothing on a locked track and says so', () => {
    const s = scene()
    editor.load(s.p)
    startLibraryDrag({ dataTransfer: null }, { kind: 'effect', id: 'glow' })
    expect(libraryDropHint(s.top.trackId, 1.6)).toEqual({ trackId: s.top.trackId, locked: true, at: 1 })
    endLibraryDrag()
    const before = editor.getProject()
    dropLibraryItem({ kind: 'effect', id: 'glow' }, { trackId: s.top.trackId, time: 1 })
    expect(editor.getProject()).toBe(before)
    expect(get().toasts.at(-1)?.message).toBe('Track is locked')
  })

  it('highlights the clip or cut the dragged item would land on', () => {
    const s = scene()
    editor.load(s.p)
    startLibraryDrag({ dataTransfer: null }, { kind: 'effect', id: 'glow' })
    expect(libraryDropHint(s.b.trackId, 5)).toEqual({ trackId: s.b.trackId, start: 4, end: 8 })
    expect(libraryDropHint(s.b.trackId, 12)).toBeNull()
    startLibraryDrag({ dataTransfer: null }, { kind: 'transition', id: 'flash' })
    expect(libraryDropHint(s.b.trackId, 5)).toEqual({ trackId: s.b.trackId, start: 4, end: 4 })
    expect(libraryDropHint(s.b.trackId, 7)).toEqual({ trackId: s.b.trackId, start: 8, end: 8 })
    expect(libraryDropHint(s.b.trackId, 12)).toBeNull()
    endLibraryDrag()
    expect(libraryDropHint(s.b.trackId, 5)).toBeNull()
  })
})

describe('adding visuals', () => {
  beforeEach(() => set({ selection: { type: 'none' }, playhead: 1, toasts: [] }))

  it('puts a visual on a new Visuals track right above the footage when no track there is free', () => {
    const s = scene()
    editor.load(s.p)
    chooseLook('warm')
    addVisual('visualizer.spectrum')
    const p = editor.getProject()
    // The locked track's image is the top footage.
    expect(p.tracks.map((t) => t.name)).toEqual(['Lyrics', 'Look', 'Visuals', 'Locked', 'Video 1', 'Song'])
    const clip = Object.values(p.clips).find((c) => c.type === 'generator')
    // No song sections: it lasts 8 s from the playhead, in the look's visualizer colors.
    expect(clip).toMatchObject({ trackId: p.tracks[2]!.id, start: 1, duration: 8, name: 'Spectrum bars' })
    expect(clip?.type === 'generator' && clip.params.color?.value).toBe('#fde68a')
    expect(editor.undoLabel()).toBe('Add visual: Spectrum bars')
    expect(get().selection).toEqual({ type: 'clip', id: clip!.id })
    expect(get().toasts.at(-1)?.message).toBe('“Spectrum bars” added from 0:01 to 0:09')
    editor.undo()
    expect(editor.getProject().tracks.map((t) => t.name)).toEqual([
      'Lyrics',
      'Look',
      'Locked',
      'Video 1',
      'Song',
    ])
  })

  it('uses a free unlocked track above the footage', () => {
    const s = scene()
    const overlay = createTrack('visual', 'Overlay')
    s.p.tracks.splice(1, 0, overlay)
    expect(visualPlacement(s.p, 1)).toEqual({ start: 1, duration: 8, trackId: overlay.id })
    // Busy where the visual would go: a new track instead.
    const title = createTextClip({ trackId: overlay.id, text: 'Title', start: 6, duration: 2 })
    s.p.clips[title.id] = title
    expect(visualPlacement(s.p, 1)).toEqual({ start: 1, duration: 8, newTrackIndex: 2 })
  })
})
