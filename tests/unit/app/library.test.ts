import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createImageClip,
  createProject,
  createTextClip,
  createTrack,
  createVideoClip,
  type Asset,
  type Project,
  type TextClip,
} from '../../../src/model/index.ts'
import { currentLook, ORIGINAL_LOOK } from '../../../src/plugins/looks.ts'
import {
  addEffect,
  addTransition,
  addVisual,
  applyLibraryTextStyle,
  applyTextAnimation,
  chooseLook,
  chosenLookId,
  clickVisual,
  dropLibraryItem,
  effectItems,
  effectTarget,
  endLibraryDrag,
  libraryDropHint,
  matchesQuery,
  mediaRemoval,
  removeMedia,
  startLibraryDrag,
  textTargetHint,
  textTargets,
  transitionTarget,
  visualPlacement,
  currentTextItems,
  currentVisuals,
  visualChangeItem,
  visualTargetHint,
} from '../../../src/app/state/library.ts'
import { pluginRegistry } from '../../../src/engine/registry.ts'
import { applyReaction, describeReaction } from '../../../src/plugins/reactions.ts'
import { createGeneratorClip } from '../../../src/plugins/library.ts'
import { editor } from '../../../src/app/state/project.ts'
import { get, selectedClipIds, set, type Selection } from '../../../src/app/state/ui.ts'

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

/** A param of a generator clip in the editor's project. */
const paramOf = (clipId: string, key: string) => {
  const clip = editor.getProject().clips[clipId]
  return clip?.type === 'generator' ? clip.params[key]?.value : undefined
}

const defaultOf = (generatorId: string, key: string) =>
  pluginRegistry.get(generatorId)?.params.find((p) => p.key === key)?.default
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

  it('puts a visual above a scene or background visual, which covers the frame like footage unless see-through', () => {
    const p: Project = createProject({ name: 'visualizer video' })
    const spectrum = createTrack('visual', 'Visualizer')
    const background = createTrack('visual', 'Background')
    p.tracks = [spectrum, background, ...p.tracks.filter((t) => t.kind === 'audio')]
    for (const [track, generatorId] of [
      [spectrum, 'visualizer.spectrum'],
      [background, 'generator.synthwave'],
    ] as const) {
      const clip = createGeneratorClip({ trackId: track.id, generatorId, start: 0, duration: 60 })
      p.clips[clip.id] = clip
    }
    expect(visualPlacement(p, 1)).toEqual({ start: 1, duration: 8, newTrackIndex: 1 })
    const scene = Object.values(p.clips).find((c) => c.trackId === background.id)
    if (scene?.type === 'generator') scene.params.background = { value: '#00000000' }
    expect(visualPlacement(p, 1)).toEqual({ start: 1, duration: 8, newTrackIndex: 2 })
  })

  it('changes the selected visual to the clicked one, keeping its place, its colors and the rest, as one undo step', () => {
    const s = scene()
    editor.load(s.p)
    chooseLook('warm')
    addVisual('visualizer.spectrum')
    const before = Object.values(editor.getProject().clips).find((c) => c.type === 'generator')!
    editor.dispatch({
      type: 'clip.set',
      clipId: before.id,
      path: ['params', 'color', 'value'],
      value: '#123456',
    })
    const spectrum = editor.getProject().clips[before.id]!
    expect(visualTargetHint(editor.getProject(), get().selection)).toBe(
      'Click a visualizer to change “Spectrum bars” to it. To add a visual instead, right-click or drag it, or click a shader visual.',
    )

    clickVisual('visualizer.circle')
    const after = editor.getProject().clips[before.id]
    expect(after).toMatchObject({
      type: 'generator',
      generatorId: 'visualizer.circle',
      name: 'Circle spectrum',
      trackId: spectrum.trackId,
      start: spectrum.start,
      duration: spectrum.duration,
    })
    // Its own color carries over; the circle's height is its own default, not the bars' 60%.
    expect(after?.type === 'generator' && after.params.color?.value).toBe('#123456')
    expect(after?.type === 'generator' && after.params.height?.value).toBe(0.16)
    expect(after?.type === 'generator' && Object.keys(after.params)).toContain('radius')
    expect(Object.values(editor.getProject().clips).filter((c) => c.type === 'generator')).toHaveLength(1)
    expect(get().selection).toEqual({ type: 'clip', id: before.id })
    expect(editor.undoLabel()).toBe('Change visual to Circle spectrum')
    expect(get().toasts.at(-1)?.message).toBe('Changed “Spectrum bars” to “Circle spectrum”')
    get().toasts.at(-1)?.action?.run()
    expect(editor.getProject().clips[before.id]).toEqual(spectrum)

    clickVisual('visualizer.spectrum')
    expect(get().toasts.at(-1)?.message).toBe('It’s already “Spectrum bars”')
    expect(editor.getProject().clips[before.id]).toEqual(spectrum)
  })

  it('adds the clicked visual when no visual is selected, and says why when the selected one is locked', () => {
    const s = scene()
    editor.load(s.p)
    set({ selection: { type: 'clip', id: s.a.id } })
    expect(visualTargetHint(editor.getProject(), get().selection)).toBe(
      'Click a visual to add it at the playhead, or drag it onto a track.',
    )
    clickVisual('visualizer.orb')
    const orb = Object.values(editor.getProject().clips).find((c) => c.type === 'generator')!
    expect(orb).toMatchObject({ generatorId: 'visualizer.orb' })
    expect(editor.undoLabel()).toBe('Add visual: Orb')

    editor.dispatch({ type: 'track.update', trackId: orb.trackId, patch: { locked: true } })
    expect(visualTargetHint(editor.getProject(), get().selection)).toBe(
      'That track is locked. Unlock it to change this visual.',
    )
    clickVisual('visualizer.circle')
    expect(get().toasts.at(-1)?.message).toBe('That track is locked. Unlock it to change this visual.')
    expect(editor.getProject().clips[orb.id]).toMatchObject({ generatorId: 'visualizer.orb' })
  })

  it('gives the changed visual the new one’s own settings where the old one’s were untouched', () => {
    const s = scene()
    editor.load(s.p)
    addVisual('visualizer.orb')
    const id = Object.values(editor.getProject().clips).find((c) => c.type === 'generator')!.id
    clickVisual('visualizer.spectrum')
    // No look: the orb's untouched purple gives way to the bars' own color.
    expect(paramOf(id, 'color')).toBe(defaultOf('visualizer.spectrum', 'color'))
    expect(paramOf(id, 'color')).not.toBe(defaultOf('visualizer.orb', 'color'))

    chooseLook('warm')
    set({ selection: { type: 'none' }, playhead: 20 })
    addVisual('generator.tunnel')
    const tunnel = selectedClipIds(get().selection)[0]!
    clickVisual('generator.synthwave')
    // A look colors `color`, not a scene's sky: the tunnel's untouched background gives way to the grid's.
    expect(paramOf(tunnel, 'background')).toBe(defaultOf('generator.synthwave', 'background'))
    expect(paramOf(tunnel, 'background')).not.toBe(defaultOf('generator.tunnel', 'background'))
  })

  it('changes a visual only to one of its group, so a click on the other group adds that visual', () => {
    editor.load(scene().p)
    addVisual('visualizer.spectrum')
    const id = Object.values(editor.getProject().clips).find((c) => c.type === 'generator')!.id
    const p = () => editor.getProject()
    expect(currentVisuals(p(), get().selection)).toEqual(new Set(['visualizer.spectrum']))
    expect(visualChangeItem(p(), get().selection, 'visualizer.orb')).toEqual({
      label: 'Change “Spectrum bars” to Orb',
    })
    expect(visualChangeItem(p(), get().selection, 'visualizer.spectrum')).toMatchObject({
      why: 'It’s already “Spectrum bars”',
    })
    expect(visualChangeItem(p(), get().selection, 'generator.synthwave')).toEqual({
      label: 'Change the selected visual to Retro grid',
      why: 'Visualizers change only to visualizers',
    })
    expect(visualChangeItem(p(), { type: 'none' }, 'generator.synthwave')).toMatchObject({
      why: 'Select a shader visual on the timeline first',
    })

    clickVisual('generator.synthwave')
    expect(p().clips[id]).toMatchObject({ generatorId: 'visualizer.spectrum' })
    expect(editor.undoLabel()).toBe('Add visual: Retro grid')
    expect(currentVisuals(p(), get().selection)).toEqual(new Set(['generator.synthwave']))
  })

  it('counts only the visuals it changed, and leaves those of the other group as they are', () => {
    editor.load(scene().p)
    const added = (generatorId: string, playhead: number) => {
      set({ playhead })
      addVisual(generatorId)
      return selectedClipIds(get().selection)[0]!
    }
    const ids = [
      added('visualizer.spectrum', 1),
      added('visualizer.circle', 10),
      added('generator.tunnel', 20),
    ] as const
    set({ selection: { type: 'clip', id: ids[2], ids: [...ids] } })
    expect(visualTargetHint(editor.getProject(), get().selection)).toBe(
      'Click a visual to change the selected visuals of its kind to it. Right-click or drag one to add it instead.',
    )
    clickVisual('visualizer.circle')
    expect(ids.map((id) => editor.getProject().clips[id])).toMatchObject([
      { generatorId: 'visualizer.circle' },
      { generatorId: 'visualizer.circle' },
      { generatorId: 'generator.tunnel' },
    ])
    expect(get().toasts.at(-1)?.message).toBe(
      'Changed “Spectrum bars” to “Circle spectrum” · 1 shader visual was left as is',
    )
  })

  it('keeps music reactions on settings the new visual has, as strong, and says which it removed', () => {
    editor.load(scene().p)
    addVisual('visualizer.spectrum')
    const id = Object.values(editor.getProject().clips).find((c) => c.type === 'generator')!.id
    applyReaction(editor, [{ clipId: id, param: 'height' }], 'beat', { amount: 0.4 })
    clickVisual('visualizer.circle')
    // The circle's bar height has a narrower range than the bars' height: the reaction moves it as far through it.
    const height = describeReaction(editor.getProject(), { clipId: id, param: 'height' })
    expect(height).toMatchObject({ kind: 'reaction', reaction: { id: 'beat' } })
    expect(height?.kind === 'reaction' && height.amount).toBeCloseTo(0.4, 3)
    expect(get().toasts.at(-1)?.message).toBe('Changed “Spectrum bars” to “Circle spectrum”')

    applyReaction(editor, [{ clipId: id, param: 'radius' }], 'beat', { amount: 0.5 })
    clickVisual('visualizer.orb')
    expect(get().toasts.at(-1)?.message).toBe(
      'Changed “Circle spectrum” to “Orb” · Its music reactions on Radius and Bar height were removed',
    )
  })
  it('drops a visual on a free stretch of a track, up to the next clip there, and nowhere else', () => {
    const s = scene()
    editor.load(s.p)
    const footage = s.a.trackId
    startLibraryDrag({ dataTransfer: null }, { kind: 'visual', id: 'visualizer.spectrum' })
    // The gap from 11 s ends where the next clip starts, at 14 s.
    expect(libraryDropHint(footage, 11.5)).toEqual({ trackId: footage, start: 11.5, end: 14 })
    expect(libraryDropHint(footage, 5)).toBeNull()
    expect(libraryDropHint(s.line.trackId, 6)).toBeNull()
    expect(libraryDropHint(s.top.trackId, 6)).toEqual({ trackId: s.top.trackId, locked: true, at: 6 })
    endLibraryDrag()

    dropLibraryItem({ kind: 'visual', id: 'visualizer.spectrum' }, { trackId: footage, time: 11.5 })
    const clip = Object.values(editor.getProject().clips).find((c) => c.type === 'generator')
    expect(clip).toMatchObject({ trackId: footage, start: 11.5, duration: 2.5, name: 'Spectrum bars' })
    expect(get().selection).toEqual({ type: 'clip', id: clip!.id })
    expect(editor.undoLabel()).toBe('Add visual: Spectrum bars')

    dropLibraryItem({ kind: 'visual', id: 'visualizer.spectrum' }, { trackId: footage, time: 5 })
    expect(Object.values(editor.getProject().clips).filter((c) => c.type === 'generator')).toHaveLength(1)
    expect(get().toasts.at(-1)?.message).toBe('Drop “Spectrum bars” on an empty part of a track')
  })
})

describe('removing a file from the library', () => {
  it('counts the clips that go with it, and refuses while one of them is on a locked track', () => {
    const s = scene()
    expect(mediaRemoval(s.p, 'v')).toEqual({ clips: 3 })
    expect(mediaRemoval(s.p, 'i')).toEqual({ why: 'Some of its clips are on a locked track' })
  })

  it('removes the file and its clips as one undo step, and drops a selection of one of them', () => {
    const s = scene()
    editor.load(s.p)
    set({ selection: { type: 'clip', id: s.a.id } })
    removeMedia('v')
    const after = editor.getProject()
    expect(after.assets.v).toBeUndefined()
    expect([s.a.id, s.c.id, s.d.id].filter((id) => after.clips[id])).toEqual([])
    expect(after.clips[s.b.id]).toBeDefined()
    expect(get().selection).toEqual({ type: 'none' })
    editor.undo()
    expect(editor.getProject().assets.v).toBeDefined()
    expect([s.a.id, s.c.id, s.d.id].every((id) => editor.getProject().clips[id])).toBe(true)
  })

  it('leaves a file with a clip on a locked track, and the song, in the project', () => {
    const s = scene()
    editor.load({ ...s.p, songAssetId: 'v' })
    removeMedia('v')
    removeMedia('i')
    expect(Object.keys(editor.getProject().assets).sort()).toEqual(['i', 'v'])
  })
})

describe('kinetic presets and text styles', () => {
  beforeEach(() => set({ selection: { type: 'none' }, playhead: 1, toasts: [] }))

  /**
   * The scene plus a second lyric line, a lyric line and a text on the locked track, and a title on its own track.
   */
  function textScene() {
    const s = scene()
    const [lyrics, locked] = s.p.tracks
    const titles = createTrack('visual', 'Titles')
    s.p.tracks.splice(1, 0, titles)
    const line2 = {
      ...createTextClip({ trackId: lyrics!.id, text: 'World', start: 4, duration: 4 }),
      lyricLineId: 'l2',
    }
    const hidden = {
      ...createTextClip({ trackId: locked!.id, text: 'Locked', start: 8, duration: 2 }),
      lyricLineId: 'l3',
    }
    const title = {
      ...createTextClip({ trackId: titles.id, text: 'Lumen Drive', start: 0, duration: 3 }),
      name: 'Title',
    }
    const lockedText = createTextClip({ trackId: locked!.id, text: 'Credits', start: 10, duration: 2 })
    for (const clip of [line2, hidden, title, lockedText]) s.p.clips[clip.id] = clip
    return { ...s, line2, hidden, title, lockedText }
  }

  it('goes on the selected text or lyric line, or on every unlocked lyric line when nothing is selected', () => {
    const s = textScene()
    expect(textTargets(s.p, { type: 'clip', id: s.title.id })).toEqual({
      clipIds: [s.title.id],
      what: '“Title”',
      scope: 'text',
    })
    expect(textTargets(s.p, { type: 'lyric', id: 'l2' })).toEqual({
      clipIds: [s.line2.id],
      what: 'this lyric line',
      scope: 'line',
    })
    expect(textTargets(s.p, { type: 'none' })).toEqual({
      clipIds: [s.line.id, s.line2.id],
      what: '2 lyric lines',
      scope: 'lyrics',
    })
  })

  it('changes nothing and says why when the selection is not text it can change', () => {
    const s = textScene()
    expect(textTargets(s.p, { type: 'clip', id: s.a.id })).toEqual({
      why: 'Select a text or lyric line first',
    })
    expect(textTargets(s.p, { type: 'lyric', id: 'l3' })).toEqual({
      why: 'That track is locked. Unlock it to restyle this text.',
    })
    s.p.tracks[0] = { ...s.p.tracks[0]!, locked: true }
    expect(textTargets(s.p, { type: 'none' })).toEqual({
      why: 'The Lyrics track is locked. Unlock it to restyle the lyrics.',
    })
  })

  it('says where a click goes before the click', () => {
    const s = textScene()
    expect(textTargetHint(s.p, { type: 'none' })).toBe('Click a style to use it on every lyric line.')
    expect(textTargetHint(s.p, { type: 'clip', id: s.title.id })).toBe('Click a style to use it on “Title”.')
    expect(textTargetHint(s.p, { type: 'lyric', id: 'l2' })).toBe(
      'Click a style to use it on this lyric line.',
    )
    expect(textTargetHint(s.p, { type: 'clip', id: s.a.id })).toBe(
      'Select a text or lyric line to restyle it.',
    )
    expect(textTargetHint(createProject({ name: 'empty' }), { type: 'none' })).toBe(
      'Select a text or lyric line, or add text first.',
    )
  })

  it('goes on the texts among several selected clips, skipping locked ones', () => {
    const s = textScene()
    const several = (...ids: string[]): Selection => ({ type: 'clip', id: ids[ids.length - 1]!, ids })
    expect(textTargets(s.p, several(s.line2.id, s.title.id))).toEqual({
      clipIds: [s.line2.id, s.title.id],
      what: '2 texts',
      scope: 'several',
    })
    expect(textTargets(s.p, several(s.line.id, s.line2.id, s.hidden.id))).toEqual({
      clipIds: [s.line.id, s.line2.id],
      what: '2 lyric lines',
      scope: 'several',
      skipped: { count: 1, noun: 'lyric line', tracks: 1 },
    })
    // A video in the selection is left out; one text left is named as when it is selected alone.
    expect(textTargets(s.p, several(s.a.id, s.title.id))).toMatchObject({
      clipIds: [s.title.id],
      what: '“Title”',
    })
    expect(textTargetHint(s.p, several(s.line2.id, s.title.id))).toBe('Click a style to use it on 2 texts.')
    expect(textTargets(s.p, several(s.a.id, s.b.id))).toEqual({ why: 'Select a text or lyric line first' })
    s.p.tracks[0] = { ...s.p.tracks[0]!, locked: true }
    // Both on the Lyrics track, or on two locked tracks.
    expect(textTargets(s.p, several(s.line.id, s.line2.id))).toEqual({
      why: 'Their track is locked. Unlock it to restyle these texts.',
    })
    expect(textTargets(s.p, several(s.line.id, s.hidden.id))).toEqual({
      why: 'Their tracks are locked. Unlock them to restyle these texts.',
    })
  })

  it('says which selected texts it leaves out because their tracks are locked', () => {
    const s = textScene()
    const several = (...ids: string[]): Selection => ({ type: 'clip', id: ids[ids.length - 1]!, ids })
    expect(textTargets(s.p, several(s.a.id, s.lockedText.id, s.title.id))).toEqual({
      clipIds: [s.title.id],
      what: '“Title”',
      scope: 'text',
      skipped: { count: 1, noun: 'text', tracks: 1 },
    })
    expect(textTargetHint(s.p, several(s.a.id, s.lockedText.id, s.title.id))).toBe(
      'Click a style to use it on “Title”. 1 text is on a locked track.',
    )
    expect(textTargetHint(s.p, several(s.line2.id, s.title.id, s.lockedText.id, s.hidden.id))).toBe(
      'Click a style to use it on 2 texts. 2 texts are on a locked track.',
    )
    s.p.tracks[0] = { ...s.p.tracks[0]!, locked: true }
    expect(textTargetHint(s.p, several(s.line.id, s.hidden.id, s.title.id))).toBe(
      'Click a style to use it on “Title”. 2 lyric lines are on locked tracks.',
    )
  })

  it('names the texts it left out in the toast', () => {
    const s = textScene()
    editor.load(s.p)
    set({ selection: { type: 'clip', id: s.title.id, ids: [s.lockedText.id, s.title.id] } })
    applyLibraryTextStyle('neon')
    expect(get().toasts.at(-1)?.message).toBe(
      '“Neon sign” on “Title” · 1 text on a locked track was left as is',
    )
    expect((editor.getProject().clips[s.lockedText.id] as TextClip).style).toEqual(s.lockedText.style)
    set({
      selection: { type: 'clip', id: s.title.id, ids: [s.line.id, s.lockedText.id, s.hidden.id, s.title.id] },
    })
    applyTextAnimation('wave')
    expect(get().toasts.at(-1)?.message).toBe('“Wave” on 2 texts · 2 texts on a locked track were left as is')
  })

  it('marks the kinetic preset and text style the text a click would restyle has now', () => {
    const s = textScene()
    editor.load(s.p)
    const title: Selection = { type: 'clip', id: s.title.id }
    set({ selection: title })
    applyLibraryTextStyle('neon')
    expect(currentTextItems(editor.getProject(), title)).toEqual(new Set(['neon', 'flicker']))
    applyTextAnimation('wave')
    expect(currentTextItems(editor.getProject(), title)).toEqual(new Set(['wave']))
    applyLibraryTextStyle('neon')
    editor.dispatch({ type: 'clip.set', clipId: s.title.id, path: ['style', 'color'], value: '#00ff00' })
    // Its color is no longer the style's: only the kinetic preset is still on it.
    expect(currentTextItems(editor.getProject(), title)).toEqual(new Set(['flicker']))
    // Nothing to restyle, nothing marked.
    expect(currentTextItems(editor.getProject(), { type: 'clip', id: s.a.id })).toEqual(new Set())
  })

  it('restyles several selected texts as one undo step', () => {
    const s = textScene()
    const original = (s.p.clips[s.title.id] as TextClip).style
    editor.load(s.p)
    set({ selection: { type: 'clip', id: s.title.id, ids: [s.line2.id, s.title.id] } })
    applyLibraryTextStyle('neon')
    const styled = (id: string) => (editor.getProject().clips[id] as TextClip).style
    expect(styled(s.title.id)).toEqual(styled(s.line2.id))
    expect(styled(s.title.id)).not.toEqual(original)
    expect(get().toasts.at(-1)?.message).toBe('“Neon sign” on 2 texts')
    editor.undo()
    expect(styled(s.title.id)).toEqual(original)
  })
  it('says to time the words when a word karaoke style lands on lines without word timings', () => {
    const s = textScene()
    editor.load(s.p)
    applyLibraryTextStyle('karaoke')
    expect(get().toasts.at(-1)?.message).toBe('“Karaoke” on 2 lyric lines · Time the words to see it')
    const word = (text: string, start: number) => ({ text, start, end: start + 0.5 })
    editor.load({
      ...s.p,
      lyrics: {
        source: 'pasted',
        lines: [
          { id: 'l1', text: 'Hello', start: 0, end: 1, words: [word('Hello', 0)] },
          { id: 'l2', text: 'World', start: 4, end: 5, words: [word('World', 4)] },
        ],
      },
    })
    applyLibraryTextStyle('karaoke')
    expect(get().toasts.at(-1)?.message).toBe('“Karaoke” on 2 lyric lines')
  })

  it('gives every lyric line a kinetic preset as one undo step', () => {
    const s = textScene()
    editor.load(s.p)
    applyTextAnimation('wave')
    const p = editor.getProject()
    expect(
      [s.line, s.line2, s.hidden, s.title].map((c) => (p.clips[c.id] as TextClip).animation?.presetId),
    ).toEqual(['wave', 'wave', undefined, undefined])
    expect(editor.undoLabel()).toBe('Text animation: Wave')
    expect(get().toasts.at(-1)?.message).toBe('“Wave” on 2 lyric lines')
    editor.undo()
    expect((editor.getProject().clips[s.line.id] as TextClip).animation).toBeUndefined()
  })

  it('gives the selected text a style with its kinetic preset and karaoke, keeping its words and place', () => {
    const s = textScene()
    s.title.transform.x.value = 0.3
    editor.load(s.p)
    set({ selection: { type: 'clip', id: s.title.id } })
    applyLibraryTextStyle('karaoke')
    const title = editor.getProject().clips[s.title.id] as TextClip
    expect(title).toMatchObject({
      text: 'Lumen Drive',
      transform: { x: { value: 0.3 } },
      style: { fontWeight: 800, stroke: { color: '#000000', width: 5 } },
      karaoke: { highlightColor: '#facc15', mode: 'word' },
      animation: { presetId: 'sweep' },
    })
    expect((editor.getProject().clips[s.line.id] as TextClip).karaoke).toBeUndefined()
    expect(editor.undoLabel()).toBe('Text style: Karaoke')
    expect(get().toasts.at(-1)?.message).toBe('“Karaoke” on “Title”')
  })

  it('says what to do when there is no text to change', () => {
    const p = createProject({ name: 'empty' })
    editor.load(p)
    const before = editor.getProject()
    applyTextAnimation('wave')
    expect(editor.getProject()).toBe(before)
    expect(editor.canUndo()).toBe(false)
    expect(get().toasts.at(-1)?.message).toBe('Select a text or lyric line, or add text first')
  })
})
