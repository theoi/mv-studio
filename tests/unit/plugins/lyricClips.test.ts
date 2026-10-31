import { describe, expect, it } from 'vitest'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createAudioClip, createProject, createTextClip, createTrack } from '../../../src/model/factory.ts'
import type { LyricsDoc, Project, TextClip } from '../../../src/model/types.ts'
import { lyricClipCommands } from '../../../src/plugins/lyricClips.ts'
import { TEXT_STYLES } from '../../../src/plugins/typography/styles.ts'

const karaoke = TEXT_STYLES.find((s) => s.id === 'karaoke')!

/** A project whose song clip starts at 2 s on the timeline, 1 s into the song, with a Lyrics and a Titles track. */
function setup() {
  const p = createProject({ name: 'lyrics' })
  const lyrics = createTrack('visual', 'Lyrics')
  const titles = createTrack('visual', 'Titles')
  const audio = createTrack('audio', 'Song')
  p.tracks = [lyrics, titles, audio]
  const song = createAudioClip({ trackId: audio.id, assetId: 'song', start: 2, duration: 30, sourceStart: 1 })
  p.clips[song.id] = song
  p.songAssetId = 'song'
  return { editor: new ProjectEditor(p), lyrics, titles }
}

const doc = (lines: [id: string, text: string, start?: number, end?: number][]): LyricsDoc => ({
  source: 'transcribed',
  audioAssetId: 'song',
  lines: lines.map(([id, text, start, end]) => ({
    id,
    text,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    words: [],
  })),
})

const textOn = (p: Project, trackId: string) =>
  (Object.values(p.clips).filter((c) => c.trackId === trackId && c.type === 'text') as TextClip[]).sort(
    (a, b) => a.start - b.start,
  )

describe('lyricClipCommands', () => {
  it('places timed lines through the song clip, in the text style when there are no clips to follow', () => {
    const { editor, lyrics } = setup()
    const first = doc([
      ['a', 'Under the neon', 1, 2.5],
      ['b', 'not timed yet'],
      ['c', 'we run', 3, 4],
    ])
    editor.dispatch(
      lyricClipCommands(editor.getProject(), first, { trackId: lyrics.id, textStyleId: 'karaoke' }),
    )
    const clips = textOn(editor.getProject(), lyrics.id)
    expect(clips.map((c) => [c.text, c.lyricLineId, c.start, c.duration])).toEqual([
      ['Under the neon', 'a', 2, 1.5],
      ['we run', 'c', 4, 1],
    ])
    expect(clips.every((c) => c.style.fontFamily === karaoke.style.fontFamily)).toBe(true)
    expect(clips.every((c) => c.animation?.presetId === karaoke.animation?.presetId)).toBe(true)
  })

  it('rebuilds the busiest lyric track for re-timed lines, keeping each line’s look and other text', () => {
    const { editor, lyrics, titles } = setup()
    editor.dispatch(
      lyricClipCommands(
        editor.getProject(),
        doc([
          ['a', 'Under the neon', 1, 2.5],
          ['b', 'we run', 3, 4],
        ]),
        { trackId: lyrics.id, textStyleId: 'karaoke' },
      ),
    )
    // The user restyles the second line, adds their own caption on the Lyrics track, and a lyric clip elsewhere.
    const second = textOn(editor.getProject(), lyrics.id)[1]!
    const caption = createTextClip({ trackId: lyrics.id, text: 'Live at the Roxy', start: 10, duration: 2 })
    const elsewhere = createTextClip({ trackId: titles.id, text: 'we run', start: 4, duration: 1 })
    elsewhere.lyricLineId = 'b'
    editor.dispatch([
      { type: 'clip.set', clipId: second.id, path: ['style', 'color'], value: '#ff3355' },
      { type: 'clip.set', clipId: second.id, path: ['transform', 'y'], value: { value: 0.8 } },
      {
        type: 'clip.set',
        clipId: second.id,
        path: ['karaoke'],
        value: { highlightColor: '#00ffaa', mode: 'line' },
      },
      { type: 'clip.add', clip: caption },
      { type: 'clip.add', clip: elsewhere },
    ])
    const before = editor.getProject()

    // Re-timing gives every line a new id and slightly different times.
    const retimed = doc([
      ['a2', 'Under the neon', 1.1, 2.6],
      ['b2', 'we run', 2.9, 4.2],
    ])
    editor.dispatch(lyricClipCommands(editor.getProject(), retimed))
    const p = editor.getProject()
    const clips = textOn(p, lyrics.id)
    expect(clips.map((c) => [c.text, c.lyricLineId ?? null])).toEqual([
      ['Under the neon', 'a2'],
      ['we run', 'b2'],
      ['Live at the Roxy', null],
    ])
    expect(clips[0]!.start).toBeCloseTo(2.1)
    expect(clips[1]!.duration).toBeCloseTo(1.3)
    expect(clips[0]!.style.color).toBe(karaoke.style.color ?? '#ffffff')
    expect(clips[0]!.animation?.presetId).toBe(karaoke.animation?.presetId)
    expect([clips[1]!.style.color, clips[1]!.transform.y.value, clips[1]!.karaoke]).toEqual([
      '#ff3355',
      0.8,
      { highlightColor: '#00ffaa', mode: 'line' },
    ])
    expect(clips[2]).toEqual(caption)
    expect(p.clips[elsewhere.id]).toEqual(elsewhere)

    editor.undo()
    expect(editor.getProject()).toEqual(before)
  })

  it('follows the given clips, and leaves a locked track alone', () => {
    const { editor, lyrics } = setup()
    const model = createTextClip({
      trackId: lyrics.id,
      text: 'model',
      start: 0,
      duration: 1,
      style: { color: '#123456' },
    })
    const lines = doc([['a', 'Under the neon', 1, 2.5]])
    editor.dispatch(
      lyricClipCommands(editor.getProject(), lines, { trackId: lyrics.id, preserveStyleFrom: [model] }),
    )
    expect(textOn(editor.getProject(), lyrics.id).map((c) => [c.lyricLineId, c.style.color])).toEqual([
      ['a', '#123456'],
    ])

    editor.dispatch([{ type: 'track.update', trackId: lyrics.id, patch: { locked: true } }])
    expect(lyricClipCommands(editor.getProject(), doc([['b', 'we run', 3, 4]]))).toEqual([])
  })
})
