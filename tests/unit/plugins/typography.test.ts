import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS } from '../../../src/engine/plugins/index.ts'
import { exitPose } from '../../../src/engine/plugins/textAnimations.ts'
import { createPluginRegistry } from '../../../src/engine/registry.ts'
import type { TextAnimationFrame, TextLayout } from '../../../src/engine/types.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createProject, createTextClip, createTrack } from '../../../src/model/factory.ts'
import type { TextClip } from '../../../src/model/types.ts'
import { PLUGINS } from '../../../src/plugins/index.ts'
import { BUNDLED_FONTS, bundledFont, fontStack } from '../../../src/plugins/typography/fonts.ts'
import { applyTextStyle, TEXT_STYLES, textStyleCommands } from '../../../src/plugins/typography/styles.ts'

const registry = createPluginRegistry()

describe('plugin ids', () => {
  it('are unique across kinds, so no plugin silently replaces another', () => {
    const ids = [...BUILTIN_PLUGINS, ...PLUGINS].map((p) => p.id)
    expect(ids.length).toBeGreaterThan(50)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })
})

describe('bundled fonts', () => {
  it('builds fallback stacks and finds the bundled family a stack starts with', () => {
    expect(fontStack('Bebas Neue')).toBe('"Bebas Neue", Impact, sans-serif')
    expect(fontStack('Caveat')).toBe('Caveat, cursive')
    expect(bundledFont('"Playfair Display", Georgia, serif')?.family).toBe('Playfair Display')
    expect(bundledFont('Inter, system-ui, sans-serif')?.category).toBe('sans')
    expect(bundledFont('Comic Sans MS')).toBeUndefined()
  })

  it('ship latin files and a commercial-use license for every family', () => {
    for (const font of BUNDLED_FONTS) {
      expect(
        font.files.some((f) => f.range.startsWith('U+0000-00FF')),
        font.family,
      ).toBe(true)
      expect(['OFL-1.1', 'Apache-2.0']).toContain(font.license)
      expect(font.weights[0]).toBeLessThanOrEqual(font.weights[1])
    }
  })
})

describe('text styles', () => {
  it('use bundled fonts and registered kinetic presets', () => {
    expect(TEXT_STYLES.map((s) => s.id)).toEqual(
      expect.arrayContaining(['title', 'subtitle', 'caption', 'outline']),
    )
    for (const s of TEXT_STYLES) {
      const font = bundledFont(s.style.fontFamily ?? '')
      expect(font, s.id).toBeDefined()
      const weight = s.style.fontWeight ?? 400
      expect(weight, s.id).toBeGreaterThanOrEqual(font!.weights[0])
      expect(weight, s.id).toBeLessThanOrEqual(font!.weights[1])
      if (s.style.italic) expect(font!.italic, s.id).toBe(true)
      if (s.animation) expect(registry.get(s.animation.presetId)?.kind, s.id).toBe('text-animation')
    }
  })

  it('restyle text clips in one undo step, keeping text, alignment and wrap width', () => {
    const p = createProject()
    const locked = { ...createTrack('visual', 'Locked'), locked: true }
    p.tracks.push(locked)
    const lyric = createTextClip({ trackId: p.tracks[0]!.id, text: 'Hello', start: 0, duration: 4 })
    lyric.style = { ...lyric.style, align: 'left', maxWidth: 0.5, stroke: { color: '#000000', width: 4 } }
    const frozen = createTextClip({ trackId: locked.id, text: 'Locked', start: 0, duration: 4 })
    p.clips[lyric.id] = lyric
    p.clips[frozen.id] = frozen
    const editor = new ProjectEditor(p)

    applyTextStyle(editor, [lyric.id, frozen.id], 'caption')
    const caption = editor.getProject().clips[lyric.id] as TextClip
    expect(caption.text).toBe('Hello')
    expect(caption.style).toMatchObject({ align: 'left', maxWidth: 0.5, fontSize: 52 })
    expect(caption.style.fontFamily).toMatch(/^Inter,/)
    expect(caption.style.background).toBeDefined()
    expect(caption.style.stroke).toBeUndefined()
    expect(caption.animation?.presetId).toBe('fade-up')
    expect(editor.getProject().clips[frozen.id]).toEqual(frozen)
    expect(editor.undoLabel()).toBe('Text style: Caption')

    applyTextStyle(editor, [lyric.id], 'karaoke')
    expect((editor.getProject().clips[lyric.id] as TextClip).karaoke).toEqual({
      highlightColor: '#facc15',
      mode: 'word',
    })
    editor.undo()
    editor.undo()
    expect(editor.getProject()).toEqual(p)
    expect(textStyleCommands(p, [lyric.id], 'title', { animation: false }).map((c) => c.type)).toEqual([
      'clip.set',
    ])
    expect(() => textStyleCommands(p, [lyric.id], 'nope')).toThrow(/Unknown text style/)
  })

  it('replace an imported font with their own', () => {
    const p = createProject()
    const clip = createTextClip({ trackId: p.tracks[0]!.id, text: 'Hello', start: 0, duration: 4 })
    clip.style = {
      ...clip.style,
      fontAssetId: 'font-1',
      fontFamily: '"Arcade", Inter, system-ui, sans-serif',
    }
    p.clips[clip.id] = clip
    const editor = new ProjectEditor(p)
    applyTextStyle(editor, [clip.id], 'caption')
    const style = (editor.getProject().clips[clip.id] as TextClip).style
    expect(style.fontAssetId).toBeUndefined()
    expect(style.fontFamily).toMatch(/^Inter,/)
    editor.undo()
    expect((editor.getProject().clips[clip.id] as TextClip).style).toEqual(clip.style)
  })
})

describe('kinetic exits', () => {
  const layout = {
    fontPx: 100,
    words: [0, 1, 2].map((index) => ({ text: 'w', x: 0, y: 0, width: 10, line: 0, index })),
  } as unknown as TextLayout
  const frame = (localTime: number, exit: string): TextAnimationFrame =>
    ({
      localTime,
      time: localTime,
      duration: 4,
      params: { exit, exitDuration: 0.5 },
    }) as unknown as TextAnimationFrame

  it('take words off in reading order, finishing at the clip end', () => {
    const [first, , last] = layout.words
    expect(exitPose(first!, layout, frame(2, 'fade')).alpha).toBe(1)
    expect(exitPose(first!, layout, frame(3.75, 'fade')).alpha).toBeLessThan(
      exitPose(last!, layout, frame(3.75, 'fade')).alpha,
    )
    for (const word of layout.words) expect(exitPose(word, layout, frame(4, 'fade')).alpha).toBeCloseTo(0)
    expect(exitPose(last!, layout, frame(4, 'rise')).dy).toBeCloseTo(-60)
    expect(exitPose(last!, layout, frame(4, 'shrink')).scale).toBeCloseTo(0.3)
    expect(exitPose(last!, layout, frame(4, 'none'))).toEqual({ alpha: 1, dx: 0, dy: 0, scale: 1 })
  })
})
