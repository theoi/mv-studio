import { describe, expect, it } from 'vitest'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createImageClip } from '../../../src/model/factory.ts'
import type { Asset, Clip, GeneratorClip, Project, TextClip } from '../../../src/model/types.ts'
import { currentLook, lookRegistry } from '../../../src/plugins/looks.ts'
import { sampleAnalysis } from '../../../src/plugins/preview.ts'
import { describeReaction } from '../../../src/plugins/reactions.ts'
import {
  STARTER_TEMPLATES,
  TEMPLATE_HINTS,
  VISUALIZER_STYLES,
  createFromTemplate,
  dismissTemplateHint,
  templateCommands,
  templateHint,
  templateState,
} from '../../../src/plugins/templates.ts'
import { TEXT_STYLES } from '../../../src/plugins/typography/styles.ts'

const asset = (id: string, kind: Asset['kind'], name: string, duration?: number): Asset => ({
  id,
  kind,
  name,
  mimeType: kind === 'audio' ? 'audio/wav' : kind === 'video' ? 'video/mp4' : 'image/png',
  byteSize: 1,
  storageKey: id,
  ...(duration ? { duration } : {}),
  origin: { type: 'import' },
  createdAt: '2026-01-01T00:00:00.000Z',
})

const song = asset('song', 'audio', 'neon-skyline.wav', 8)
const analysis = sampleAnalysis('song', 8)
const withSong = { song, analysis }

const trackNames = (p: Project) => p.tracks.map((t) => t.name)
const clipsOnTrack = (p: Project, name: string): Clip[] => {
  const track = p.tracks.find((t) => t.name === name)
  return Object.values(p.clips).filter((c) => c.trackId === track?.id)
}
const span = (c: Clip | undefined) => (c ? [c.start, c.start + c.duration] : undefined)

describe('starting without a song', () => {
  it.each(STARTER_TEMPLATES.map((t) => [t.kind, t] as const))(
    '%s: creates the tracks and the look, places nothing time-based and asks for the song',
    (kind, template) => {
      const p = createFromTemplate(kind)
      expect(trackNames(p)).toEqual(template.tracks)
      expect(currentLook(p)?.lookId).toBe(template.lookId)
      expect(Object.values(p.clips).filter((c) => c.type !== 'adjustment')).toEqual([])
      expect(templateHint(p)).toEqual(TEMPLATE_HINTS.addSong)
      expect(p.name).toBe(template.name)
    },
  )
})

describe('adding the song', () => {
  it('adds only the song-dependent parts, as one undo step, and nothing on a second call', () => {
    const editor = new ProjectEditor(createFromTemplate('visualizer'))
    const before = editor.getProject()
    editor.dispatch(templateCommands(before, withSong))
    const p = editor.getProject()
    expect(p.songAssetId).toBe('song')
    expect(p.analysis.audio.song).toEqual(analysis)
    expect(span(clipsOnTrack(p, 'Song')[0])).toEqual([0, 8])
    expect(clipsOnTrack(p, 'Visualizer').map((c) => [(c as GeneratorClip).generatorId, ...span(c)!])).toEqual(
      [['visualizer.spectrum', 0, 8]],
    )
    expect(clipsOnTrack(p, 'Background').map((c) => [(c as GeneratorClip).generatorId, ...span(c)!])).toEqual(
      [['generator.synthwave', 0, 8]],
    )
    // The look layer was a 10 s placeholder; it now covers the song.
    expect(span(p.clips[currentLook(p)!.clipId])).toEqual([0, 8])
    expect(trackNames(p)).toEqual(['Visualizer', 'Look', 'Background', 'Song'])
    expect(templateCommands(p, withSong)).toEqual([])
    editor.undo()
    expect(editor.getProject()).toEqual(before)
  })

  it('recreates template tracks the user deleted, and leaves projects not made from a template alone', () => {
    const editor = new ProjectEditor(createFromTemplate('lyric'))
    const background = editor.getProject().tracks.find((t) => t.name === 'Background')!
    editor.dispatch({ type: 'track.remove', trackId: background.id })
    editor.dispatch(templateCommands(editor.getProject(), withSong))
    const p = editor.getProject()
    expect(trackNames(p)).toEqual(['Lyrics', 'Look', 'Background', 'Song'])
    expect(clipsOnTrack(p, 'Background').map((c) => (c as GeneratorClip).generatorId)).toEqual([
      'generator.aurora',
    ])
    const plain = { ...p, extensions: {} }
    expect(templateCommands(plain, withSong)).toEqual([])
  })
})

describe('visualizer styles', () => {
  it.each(VISUALIZER_STYLES.map((s) => [s.id, s] as const))(
    '%s: sets up its visualizer, background, look colors and reactions',
    (id, style) => {
      const p = createFromTemplate('visualizer', { ...withSong, visualizerStyle: id })
      expect(templateState(p)?.visualizerStyle).toBe(id)
      const visualizer = clipsOnTrack(p, 'Visualizer')[0] as GeneratorClip
      expect(visualizer.generatorId).toBe(style.visualizerId)
      expect(clipsOnTrack(p, 'Background').map((c) => (c as GeneratorClip).generatorId)).toEqual(
        style.backgroundId ? [style.backgroundId] : [],
      )
      expect(currentLook(p)?.lookId).toBe(style.lookId)
      const palette = lookRegistry.get(style.lookId!)!.palette
      expect(visualizer.params.color?.value).toBe(palette.primary)
      for (const r of style.reactions ?? []) {
        const target = r.param
          ? { clipId: visualizer.id, param: r.param }
          : { clipId: visualizer.id, property: r.property! }
        expect(describeReaction(p, target)).toMatchObject({ kind: 'reaction', reaction: { id: r.reaction } })
      }
      expect(templateHint(p)).toEqual(TEMPLATE_HINTS.tryStyle)
    },
  )
})

describe('lyric video', () => {
  it('places pasted lyrics as untimed lines, then makes clips in the karaoke style once lines are timed', () => {
    const editor = new ProjectEditor(
      createFromTemplate('lyric', { ...withSong, lyrics: 'Under the neon\n\n  skyline  \nwe run' }),
    )
    let p = editor.getProject()
    expect(p.lyrics?.lines.map((l) => [l.text, l.start, l.words.length])).toEqual([
      ['Under the neon', undefined, 0],
      ['skyline', undefined, 0],
      ['we run', undefined, 0],
    ])
    expect(clipsOnTrack(p, 'Lyrics')).toEqual([])
    expect(templateHint(p)).toEqual(TEMPLATE_HINTS.timeLyrics)

    const [first, second] = p.lyrics!.lines
    editor.dispatch([
      {
        type: 'lyrics.updateLine',
        lineId: first!.id,
        patch: { start: 1, end: 2.5, words: [{ text: 'Under', start: 1, end: 1.4 }] },
      },
      { type: 'lyrics.updateLine', lineId: second!.id, patch: { start: 3, end: 4, words: [] } },
    ])
    editor.dispatch(templateCommands(editor.getProject()))
    p = editor.getProject()
    const lines = clipsOnTrack(p, 'Lyrics') as TextClip[]
    const karaoke = TEXT_STYLES.find((s) => s.id === 'karaoke')!
    expect(lines.map((c) => [c.text, c.lyricLineId, ...span(c)!])).toEqual([
      ['Under the neon', first!.id, 1, 2.5],
      ['skyline', second!.id, 3, 4],
    ])
    expect(lines.every((c) => c.style.fontFamily === karaoke.style.fontFamily)).toBe(true)
    expect(lines.every((c) => c.animation?.presetId === karaoke.animation?.presetId)).toBe(true)
    expect(templateHint(p)).toBeNull()
    expect(templateCommands(p)).toEqual([])
  })
})

describe('next-step hints', () => {
  it('footage: asks for clips, then for auto-cut, and is done once clips are on the timeline', () => {
    const editor = new ProjectEditor(createFromTemplate('footage', withSong))
    expect(templateHint(editor.getProject())).toEqual(TEMPLATE_HINTS.addClips)
    const title = clipsOnTrack(editor.getProject(), 'Titles')[0] as TextClip
    expect([title.text, title.animation?.presetId]).toEqual(['neon skyline', 'stamp'])

    const clip = asset('clip', 'video', 'dance.mp4', 5)
    editor.dispatch(templateCommands(editor.getProject(), { footage: [clip] }))
    expect(templateHint(editor.getProject())).toEqual(TEMPLATE_HINTS.cutToBeat)
    const video = editor.getProject().tracks.find((t) => t.name === 'Video')!
    editor.dispatch({
      type: 'clip.add',
      clip: createImageClip({ trackId: video.id, assetId: 'clip', start: 0, duration: 2 }),
    })
    expect(templateHint(editor.getProject())).toBeNull()
  })

  it('ai: keeps the idea and is done once a director draft is on the timeline', () => {
    const editor = new ProjectEditor(
      createFromTemplate('ai', { ...withSong, idea: 'a night drive through a neon city' }),
    )
    expect(templateState(editor.getProject())?.idea).toBe('a night drive through a neon city')
    expect(templateHint(editor.getProject())).toEqual(TEMPLATE_HINTS.draftVideo)
    editor.dispatch(templateCommands(editor.getProject(), { footage: [asset('shot', 'image', 'shot.png')] }))
    const video = editor.getProject().tracks.find((t) => t.name === 'Video')!
    const shot = createImageClip({ trackId: video.id, assetId: 'shot', start: 0, duration: 2 })
    shot.meta = { director: { planId: 'plan-1', role: 'shots' } }
    editor.dispatch({ type: 'clip.add', clip: shot })
    expect(templateHint(editor.getProject())).toBeNull()
  })

  it('dismissing hides only the current step, without an undo step', () => {
    const editor = new ProjectEditor(createFromTemplate('footage'))
    dismissTemplateHint(editor)
    expect(templateHint(editor.getProject())).toBeNull()
    expect(editor.canUndo()).toBe(false)
    editor.dispatch(templateCommands(editor.getProject(), withSong))
    expect(templateHint(editor.getProject())).toEqual(TEMPLATE_HINTS.addClips)
  })
})
