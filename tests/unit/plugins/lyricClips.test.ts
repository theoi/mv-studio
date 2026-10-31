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
  it('keeps each re-timed line’s lead-in and hold around its new sung times, shrinking them where lines would now overlap', () => {
    const { editor, lyrics } = setup()
    const first = doc([
      ['a', 'Under the neon', 1, 2.5],
      ['b', 'we run', 4, 5],
      ['c', 'into the night', 5.5, 6.5],
    ])
    editor.dispatch([
      { type: 'lyrics.set', lyrics: first },
      ...lyricClipCommands(editor.getProject(), first, { trackId: lyrics.id }),
    ])
    // As the director shows them: from a little before each line is sung until a while after (timeline = song + 1 s).
    const [a, b, c] = textOn(editor.getProject(), lyrics.id)
    editor.dispatch([
      { type: 'clip.trim', clipId: a!.id, start: 1.7, duration: 2.8 },
      { type: 'clip.trim', clipId: b!.id, start: 4.7, duration: 1.6 },
      { type: 'clip.trim', clipId: c!.id, start: 6.3, duration: 2.2 },
    ])

    // Re-timed with new ids: the lines come earlier and closer together.
    const retimed = doc([
      ['a2', 'Under the neon', 1.2, 2.6],
      ['b2', 'we run', 3.4, 4.6],
      ['c2', 'into the night', 4.8, 6],
    ])
    editor.dispatch(lyricClipCommands(editor.getProject(), retimed))
    const spans = textOn(editor.getProject(), lyrics.id).map((x) => [
      x.lyricLineId,
      +x.start.toFixed(3),
      +(x.start + x.duration).toFixed(3),
    ])
    // Leads 0.3, 0.3, 0.2 and holds 1, 0.3, 1; a2's and b2's holds end where the next line now enters.
    expect(spans).toEqual([
      ['a2', 1.9, 4.1],
      ['b2', 4.1, 5.6],
      ['c2', 5.6, 8],
    ])
  })

  it('keeps a couplet shown together, and can place lines exactly as sung', () => {
    const { editor, lyrics } = setup()
    const first = doc([
      ['a', 'Hold me', 1, 2],
      ['b', 'closer', 2.2, 3],
    ])
    editor.dispatch([
      { type: 'lyrics.set', lyrics: first },
      ...lyricClipCommands(editor.getProject(), first, { trackId: lyrics.id }),
    ])
    // Both lines of the couplet stay on screen until the second is sung.
    const [a, b] = textOn(editor.getProject(), lyrics.id)
    editor.dispatch([
      { type: 'clip.trim', clipId: a!.id, start: 1.8, duration: 2.2 },
      { type: 'clip.trim', clipId: b!.id, start: 1.8, duration: 2.2 },
    ])
    const retimed = doc([
      ['a', 'Hold me', 1.5, 2.4],
      ['b', 'closer', 2.5, 3.2],
    ])
    const spans = (keepLeadAndHold: boolean) => {
      const p = new ProjectEditor(editor.getProject())
      p.dispatch(lyricClipCommands(p.getProject(), retimed, { keepLeadAndHold }))
      return textOn(p.getProject(), lyrics.id).map((x) => [
        +x.start.toFixed(3),
        +(x.start + x.duration).toFixed(3),
      ])
    }
    // Each line keeps its own lead and hold (b's long lead is its wait as the second line), so they still overlap.
    expect(spans(true)).toEqual([
      [2.1, 4.2],
      [2.3, 4.4],
    ])
    expect(spans(false)).toEqual([
      [2.5, 3.4],
      [3.5, 4.2],
    ])
  })
})
