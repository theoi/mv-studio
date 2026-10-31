import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, createTextClip, createTrack, type TextClip } from '../../../src/model/index.ts'
import { BUNDLED_FONTS } from '../../../src/plugins/typography/fonts.ts'
import { editor } from '../../../src/app/state/project.ts'
import {
  applyStyleToAllLines,
  fontChoice,
  linePosition,
  NO_PRESET,
  presetParams,
  setFont,
  setLinePosition,
  setDecoration,
  setPreset,
  setPresetParam,
  setStyleValue,
  setWeight,
  weightChoice,
} from '../../../src/app/state/textStyle.ts'
import { get, set } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

/** Three lyric lines (the last on a locked track) and a title. */
function scene() {
  const p = createProject({ name: 'text' })
  const lyrics = createTrack('visual', 'Lyrics')
  const locked = { ...createTrack('visual', 'Locked'), locked: true }
  p.tracks = [lyrics, locked, ...p.tracks]
  const line = (id: string, text: string, start: number, trackId = lyrics.id): TextClip => ({
    ...createTextClip({
      trackId,
      text,
      start,
      duration: 2,
      style: { fontFamily: "'Inter Variable', Inter" },
    }),
    id,
    lyricLineId: `l-${id}`,
  })
  const a = line('a', 'Under the neon', 0)
  const b = line('b', 'We come alive', 2)
  const c = line('c', 'Tonight', 4, locked.id)
  const title = { ...createTextClip({ trackId: lyrics.id, text: 'NEON', start: 8, duration: 2 }), id: 't' }
  for (const clip of [a, b, c, title]) p.clips[clip.id] = clip
  editor.load(p)
  return { a, b, c, title }
}

const clip = (id: string) => editor.getProject().clips[id] as TextClip

beforeEach(() => set({ toasts: [] }))

describe('fonts', () => {
  it('lists every bundled font, and the text’s own font first when it is not bundled', () => {
    const own = fontChoice({ ...scene().a.style })
    expect(own.value).toBe('Inter Variable')
    expect(own.options.map((o) => o.value)).toEqual(['Inter Variable', ...BUNDLED_FONTS.map((f) => f.family)])
    const bundled = fontChoice({ ...scene().a.style, fontFamily: '"Bebas Neue", Impact, sans-serif' })
    expect(bundled.value).toBe('Bebas Neue')
    expect(bundled.options).toHaveLength(BUNDLED_FONTS.length)
  })

  it('sets a font with a fallback, keeping the weight and italics only where the font has them', () => {
    const { a } = scene()
    editor.dispatch({ type: 'clip.set', clipId: a.id, path: ['style', 'italic'], value: true })
    editor.dispatch({ type: 'clip.set', clipId: a.id, path: ['style', 'fontWeight'], value: 750 })
    setFont(clip(a.id), 'Bebas Neue')
    expect(clip(a.id).style).toMatchObject({
      fontFamily: '"Bebas Neue", Impact, sans-serif',
      fontWeight: 400,
      italic: false,
    })
    expect(editor.undoLabel()).toBe('Font: Bebas Neue')
    setFont(clip(a.id), 'Montserrat')
    // Montserrat has every weight from 100 to 900, so the clamped 400 stays.
    expect(clip(a.id).style).toMatchObject({
      fontWeight: 400,
      fontFamily: 'Montserrat, system-ui, sans-serif',
    })
  })
})

describe('kinetic presets', () => {
  it('switches presets with their defaults, keeping the exit, and removes the preset with None', () => {
    const { a } = scene()
    setPreset(clip(a.id), 'pop')
    setPresetParam(clip(a.id), presetParams(clip(a.id)).find((p) => p.spec.key === 'exit')!.spec, 'fade')
    setPresetParam(clip(a.id), presetParams(clip(a.id)).find((p) => p.spec.key === 'stagger')!.spec, 0.3)
    setPreset(clip(a.id), 'rise')
    expect(clip(a.id).animation).toEqual({ presetId: 'rise', params: { exit: 'fade' } })
    expect(editor.undoLabel()).toBe('Text animation: Rise')
    setPreset(clip(a.id), NO_PRESET)
    expect(clip(a.id).animation).toBeUndefined()
    expect(editor.undoLabel()).toBe('No text animation')
  })

  it('shows the preset’s basic settings at their values, and a slider drag is one undo step', () => {
    const { a } = scene()
    setPreset(clip(a.id), 'pop')
    const params = presetParams(clip(a.id))
    expect(params.map((p) => p.spec.key)).toEqual(['stagger', 'duration', 'exit'])
    expect(params.find((p) => p.spec.key === 'duration')?.value).toBe(0.35)
    const duration = params.find((p) => p.spec.key === 'duration')!.spec
    setPresetParam(clip(a.id), duration, 0.5, true)
    setPresetParam(clip(a.id), duration, 0.8, true)
    editor.endGesture()
    expect(clip(a.id).animation?.params.duration).toBe(0.8)
    editor.undo()
    expect(clip(a.id).animation?.params.duration).toBeUndefined()
    expect(editor.undoLabel()).toBe('Text animation: Pop')
  })
})

describe('position', () => {
  it('reads and sets top, center and lower', () => {
    const { a } = scene()
    expect(linePosition(clip(a.id))).toBe('center')
    setLinePosition(clip(a.id), 'lower')
    expect(clip(a.id).transform.y.value).toBe(0.75)
    expect(linePosition(clip(a.id))).toBe('lower')
    expect(editor.undoLabel()).toBe('Position: Lower')
  })
})

describe('apply style to all lines', () => {
  it('gives the other unlocked lyric lines the line’s look, keeping their words, as one undo step', () => {
    const { a, b, c, title } = scene()
    setFont(clip(a.id), 'Anton')
    setPreset(clip(a.id), 'stamp')
    setLinePosition(clip(a.id), 'top')
    editor.dispatch({
      type: 'clip.set',
      clipId: a.id,
      path: ['karaoke'],
      value: { highlightColor: '#ff00aa', mode: 'word' },
    })
    applyStyleToAllLines(clip(a.id))
    expect(clip(b.id)).toMatchObject({
      text: 'We come alive',
      style: clip(a.id).style,
      animation: { presetId: 'stamp' },
      karaoke: { highlightColor: '#ff00aa' },
      transform: { y: { value: 0.22 }, x: { value: 0.5 } },
    })
    expect(clip(c.id).animation).toBeUndefined()
    expect(clip(title.id).animation).toBeUndefined()
    expect(editor.undoLabel()).toBe('Apply style to all lines')
    expect(get().toasts.at(-1)?.message).toBe('Style applied to all 2 lyric lines')
    get().toasts.at(-1)?.action?.run()
    expect(clip(b.id).animation).toBeUndefined()
  })
})

describe('weight, values, outline, shadow and background', () => {
  it('offers the weights the font has, plus the text’s own', () => {
    const { a } = scene()
    const space = weightChoice({ ...a.style, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 650 })
    expect(space.value).toBe('650')
    expect(space.options.map((o) => o.label)).toEqual([
      'Light',
      'Regular',
      'Medium',
      'Semibold',
      '650',
      'Bold',
    ])
    expect(space.options.find((o) => o.value === '650')?.description).toBe('Custom')
    // A font that isn't bundled gets every weight.
    expect(weightChoice({ ...a.style }).options).toHaveLength(9)
    setWeight(clip(a.id), 300)
    expect(clip(a.id).style.fontWeight).toBe(300)
    expect(editor.undoLabel()).toBe('Weight: Light')
  })

  it('turns an outline on from its starting values and off again, one undo step each', () => {
    const { a } = scene()
    setDecoration(clip(a.id), 'stroke', true)
    expect(clip(a.id).style.stroke).toEqual({ color: '#000000', width: 4 })
    expect(editor.undoLabel()).toBe('Outline on')
    setDecoration(clip(a.id), 'stroke', false)
    expect(clip(a.id).style.stroke).toBeUndefined()
    editor.undo()
    expect(clip(a.id).style.stroke).toEqual({ color: '#000000', width: 4 })
  })

  it('a slider drag on a style value is one undo step', () => {
    const { a } = scene()
    setDecoration(clip(a.id), 'shadow', true)
    for (const blur of [20, 24, 30]) setStyleValue(clip(a.id), ['shadow', 'blur'], blur, { gesture: true })
    editor.endGesture()
    expect(clip(a.id).style.shadow?.blur).toBe(30)
    editor.undo()
    expect(clip(a.id).style.shadow?.blur).toBe(16)
  })
})
