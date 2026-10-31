import { describe, expect, it } from 'vitest'
import { createPluginRegistry } from '../../../src/engine/registry.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import {
  createImageClip,
  createProject,
  createSolidClip,
  createTextClip,
  createTrack,
  createVideoClip,
} from '../../../src/model/factory.ts'
import type { AdjustmentClip, Asset, GeneratorClip, Project, TextClip } from '../../../src/model/types.ts'
import { createGeneratorClip, createTransition } from '../../../src/plugins/library.ts'
import {
  applyLook,
  applyLookCommands,
  BUILTIN_LOOKS,
  createLookRegistry,
  currentLook,
  lookRegistry,
  removeLookCommands,
} from '../../../src/plugins/looks.ts'

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

/** Text track on top, then footage with a transition, a visualizer, and a locked track with a title. */
function scene() {
  const p = createProject({ name: 'looks' })
  const footage = p.tracks[0]!
  const textTrack = createTrack('visual', 'Lyrics')
  const lockedTrack = { ...createTrack('visual', 'Locked'), locked: true }
  p.tracks = [textTrack, footage, lockedTrack, ...p.tracks.slice(1)]
  p.assets = { v: asset('v', 'video'), i: asset('i', 'image') }
  const a = createVideoClip({ trackId: footage.id, assetId: 'v', start: 0, duration: 4 })
  const b = createImageClip({ trackId: footage.id, assetId: 'i', start: 4, duration: 4 })
  b.transitionIn = { ...createTransition('wipe-left'), duration: 0.75, easing: 'linear' }
  const lyric = createTextClip({ trackId: textTrack.id, text: 'Hello night', start: 0, duration: 4 })
  lyric.karaoke = { highlightColor: '#ff0000', mode: 'word' }
  lyric.style = { ...lyric.style, fontSize: 120, align: 'left' }
  const viz = createGeneratorClip({
    trackId: footage.id,
    generatorId: 'visualizer.spectrum',
    start: 8,
    duration: 4,
  })
  const title = createTextClip({ trackId: lockedTrack.id, text: 'Locked', start: 0, duration: 4 })
  for (const c of [a, b, lyric, viz, title]) p.clips[c.id] = c
  return { p, a, b, lyric, viz, title, textTrack, footage, lockedTrack }
}

describe('look registry', () => {
  it('ships the shared looks the director and VJ mode use', () => {
    expect(lookRegistry.list().map((l) => l.id)).toEqual([
      'clean',
      'neon',
      'warm',
      'vintage',
      'moody',
      'dreamy',
      'mono',
      'vivid',
      'cinematic',
      'vhs',
      'ice',
      'ember',
    ])
  })

  it('only references registered plugins and params, with valid colors and adjustment ranges', () => {
    const plugins = createPluginRegistry()
    const hex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i
    for (const look of BUILTIN_LOOKS) {
      for (const effect of look.effects) {
        const def = plugins.get(effect.effectId)
        expect(def?.kind, `${look.id}: ${effect.effectId}`).toBe('effect')
        for (const key of Object.keys(effect.params ?? {}))
          expect(
            def?.params.map((p) => p.key),
            `${look.id}: ${effect.effectId}.${key}`,
          ).toContain(key)
      }
      if (look.text?.animation) expect(plugins.get(look.text.animation.presetId)?.kind).toBe('text-animation')
      if (look.transition) expect(plugins.get(look.transition.kind)?.kind).toBe('transition')
      for (const color of [look.textColor, look.accentColor, look.palette.primary, look.palette.secondary])
        expect(color, look.id).toMatch(hex)
      for (const v of Object.values(look.adjustments)) expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(look.promptStyle.length).toBeGreaterThan(10)
    }
  })

  it('validates ids, replaces looks by id and notifies subscribers', () => {
    const registry = createLookRegistry([])
    let calls = 0
    registry.subscribe(() => calls++)
    const look = { ...BUILTIN_LOOKS[0]!, id: 'my-look' }
    registry.register(look)
    registry.register({ ...look, name: 'Renamed' })
    expect(registry.list().map((l) => l.name)).toEqual(['Renamed'])
    expect(calls).toBe(2)
    expect(() => registry.register({ ...look, id: 'Bad Id' })).toThrow(/Invalid look id/)
  })
})

describe('applying looks', () => {
  it('adds a look layer below the lyrics and restyles text, karaoke, visualizers and transitions in one undo step', () => {
    const s = scene()
    const editor = new ProjectEditor(s.p)
    applyLook(editor, 'neon')
    const p = editor.getProject()
    const look = lookRegistry.get('neon')!

    const layer = currentLook(p)
    expect(layer?.lookId).toBe('neon')
    const clip = p.clips[layer!.clipId] as AdjustmentClip
    expect(clip.type).toBe('adjustment')
    expect(clip.adjustments).toEqual({
      contrast: { value: 0.15 },
      saturation: { value: 0.2 },
      temperature: { value: -0.08 },
    })
    expect(
      clip.effects.map((e) => [
        e.effectId,
        e.params.look?.value,
        e.params.amount?.value,
        e.params.intensity?.value,
      ]),
    ).toEqual([
      ['color-grade', 'neon', 0.55, undefined],
      ['glow', undefined, undefined, 0.95],
    ])
    expect([clip.start, clip.duration]).toEqual([0, 12])
    // The new Look track sits right under the lyrics track, above the footage.
    expect(p.tracks.map((t) => t.name)).toEqual(['Lyrics', 'Look', 'Video 1', 'Locked', 'Song'])
    expect(p.tracks[1]!.id).toBe(clip.trackId)

    const lyric = p.clips[s.lyric.id] as TextClip
    expect(lyric.style).toMatchObject({
      ...look.text?.style,
      color: look.textColor,
      fontSize: 120,
      align: 'left',
    })
    expect(lyric.karaoke?.highlightColor).toBe(look.accentColor)
    expect(lyric.animation?.presetId).toBe(look.text?.animation?.presetId)
    const viz = p.clips[s.viz.id] as GeneratorClip
    expect([viz.params.color, viz.params.color2]).toEqual([{ value: '#22d3ee' }, { value: '#f472b6' }])
    expect(p.clips[s.b.id]).toMatchObject({
      transitionIn: { kind: 'flash', duration: 0.75, easing: 'linear' },
    })
    // Locked tracks are left alone.
    expect(p.clips[s.title.id]).toEqual(s.title)

    expect(editor.undoLabel()).toBe('Apply look: Neon night')
    editor.undo()
    expect(editor.getProject()).toEqual(s.p)
  })

  it('replaces the previous look in place and keeps a user-trimmed look layer span', () => {
    const s = scene()
    const editor = new ProjectEditor(s.p)
    applyLook(editor, 'mono')
    const first = currentLook(editor.getProject())!
    editor.dispatch({ type: 'clip.trim', clipId: first.clipId, start: 2, duration: 5 })
    applyLook(editor, 'ember')
    const p = editor.getProject()
    const looks = Object.values(p.clips).filter((c) => c.meta?.role === 'look')
    expect(looks).toHaveLength(1)
    expect(looks[0]).toMatchObject({ start: 2, duration: 5, meta: { lookId: 'ember' } })
    expect(p.tracks.filter((t) => t.name === 'Look')).toHaveLength(1)
  })

  it("switching looks replaces the previous look's typography instead of layering on it", () => {
    const s = scene()
    const editor = new ProjectEditor(s.p)
    applyLook(editor, 'vivid')
    applyLook(editor, 'dreamy')
    const dreamy = editor.getProject().clips[s.lyric.id] as TextClip
    expect(dreamy.style).toMatchObject({
      italic: true,
      fontFamily: expect.stringContaining('Playfair Display'),
    })
    expect(dreamy.style.stroke).toBeUndefined()
    applyLook(editor, 'neon')
    const neon = editor.getProject().clips[s.lyric.id] as TextClip
    expect(neon.style).toMatchObject({ italic: false, fontFamily: expect.stringContaining('Montserrat') })
    expect(neon.style.shadow).toBeDefined()
    applyLook(editor, 'clean')
    const clean = editor.getProject().clips[s.lyric.id] as TextClip
    expect(clean.style.shadow).toBeUndefined()
    expect(clean.style.fontSize).toBe(120)
  })

  it('replaces the look layer of a director draft instead of stacking a second grade', () => {
    const s = scene()
    const lookTrack = createTrack('visual', 'Director · Look')
    s.p.tracks.splice(1, 0, lookTrack)
    const { color: _color, ...base } = createSolidClip({
      trackId: lookTrack.id,
      start: 0,
      duration: 12,
      color: '#000',
    })
    const draft: AdjustmentClip = {
      ...base,
      type: 'adjustment',
      adjustments: { saturation: { value: 0.3 } },
      meta: { director: { planId: 'plan-1', role: 'look' } },
    }
    s.p.clips[draft.id] = draft
    expect(currentLook(s.p)).toEqual({ clipId: draft.id, lookId: undefined })

    const editor = new ProjectEditor(s.p)
    applyLook(editor, 'moody')
    const p = editor.getProject()
    expect(p.clips[draft.id]).toBeUndefined()
    const adjustmentClips = Object.values(p.clips).filter((c) => c.type === 'adjustment')
    expect(adjustmentClips).toHaveLength(1)
    expect(adjustmentClips[0]).toMatchObject({
      trackId: lookTrack.id,
      start: 0,
      duration: 12,
      meta: { lookId: 'moody' },
    })
  })

  it('can leave text, transitions and visualizers untouched', () => {
    const s = scene()
    const commands = applyLookCommands(s.p, 'vivid', { text: false, transitions: false, visualizers: false })
    expect(commands.map((c) => c.type)).toEqual(['track.add', 'clip.add'])
  })

  it('removes the look layer, and its track when nothing else is on it', () => {
    const s = scene()
    const editor = new ProjectEditor(s.p)
    applyLook(editor, 'dreamy')
    editor.dispatch(removeLookCommands(editor.getProject()))
    expect(currentLook(editor.getProject())).toBeNull()
    expect(editor.getProject().tracks.map((t) => t.name)).toEqual(['Lyrics', 'Video 1', 'Locked', 'Song'])
    expect(removeLookCommands(editor.getProject())).toEqual([])
  })

  it('applies to an empty project and rejects unknown looks', () => {
    const p: Project = createProject()
    const editor = new ProjectEditor(p)
    applyLook(editor, 'clean')
    expect(editor.getProject().tracks[0]!.name).toBe('Look')
    expect(() => applyLookCommands(p, 'nope')).toThrow(/Unknown look/)
  })
})
