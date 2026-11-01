import { describe, expect, it, vi } from 'vitest'
import {
  createProject,
  createTextClip,
  createTrack,
  ProjectEditor,
  type LyricLine,
  type LyricsDoc,
  type Project,
  type TextClip,
} from '../../../src/model/index.ts'
import type { LyricsResult } from '../../../src/analysis/lyrics/client.ts'
import {
  lyricsCommands,
  lyricsCost,
  removeLyricLinesCommands,
  setLyricsServiceForTests,
  startLyrics,
} from '../../../src/app/state/lyrics.ts'
import { editor } from '../../../src/app/state/project.ts'
import type * as UiModule from '../../../src/app/state/ui.ts'
import { jobs } from '../../../src/shared/jobs.ts'

vi.mock('../../../src/app/state/ui.ts', async (original) => ({
  ...(await original<typeof UiModule>()),
  toast: vi.fn(),
}))

const doc: LyricsDoc = {
  source: 'pasted',
  lines: [
    { id: 'n1', text: 'Under the neon skyline', start: 2, end: 4, words: [] },
    { id: 'n2', text: 'We come alive tonight', start: 5, end: 7.5, words: [] },
  ],
}

function withLyricTrack(locked = false): { project: Project; trackId: string } {
  const project = createProject({ name: 'p' })
  const track = { ...createTrack('visual', 'Words'), locked }
  project.tracks.unshift(track)
  const old = {
    ...createTextClip({ trackId: track.id, text: 'Under the neon skyline', start: 1.8, duration: 2 }),
  }
  old.lyricLineId = 'old-1'
  old.style = { ...old.style, color: '#ff00aa' }
  project.clips[old.id] = old
  return { project, trackId: track.id }
}

const lyricClips = (p: Project) =>
  Object.values(p.clips).filter((c): c is TextClip => c.type === 'text' && !!c.lyricLineId)

it('re-timed lyrics replace the lyric clips on their track, keeping their look, in one undo step', () => {
  const { project, trackId } = withLyricTrack()
  const editor = new ProjectEditor(project)
  editor.dispatch(lyricsCommands(project, doc), { label: 'Time lyrics' })
  const clips = lyricClips(editor.getProject())
  expect(clips.map((c) => [c.lyricLineId, c.trackId, c.start, c.style.color])).toEqual([
    ['n1', trackId, 2, '#ff00aa'],
    ['n2', trackId, 5, '#ff00aa'],
  ])
  expect(editor.getProject().lyrics?.lines.map((l) => l.id)).toEqual(['n1', 'n2'])
  expect(editor.getProject().tracks).toHaveLength(project.tracks.length)
  editor.undo()
  expect(lyricClips(editor.getProject()).map((c) => c.lyricLineId)).toEqual(['old-1'])
})

it('lyrics without a lyric track get a new Lyrics track on top', () => {
  const project = createProject({ name: 'p' })
  const editor = new ProjectEditor(project)
  editor.dispatch(lyricsCommands(project, doc))
  const top = editor.getProject().tracks[0]
  expect(top?.name).toBe('Lyrics')
  expect(lyricClips(editor.getProject()).every((c) => c.trackId === top?.id)).toBe(true)
  expect(lyricClips(editor.getProject())).toHaveLength(2)
})

it("the director's emphasized word leaves with its line's old words, in the same undo step", () => {
  const { project } = withLyricTrack()
  project.lyrics = {
    source: 'pasted',
    lines: [{ id: 'n1', text: 'Under the neon lights', start: 2, end: 4, words: [] }],
  }
  const accents = createTrack('visual', 'Director · Accents')
  project.tracks.unshift(accents)
  const word = createTextClip({ trackId: accents.id, text: 'lights', start: 3.2, duration: 1 })
  word.meta = { director: { planId: 'plan', role: 'text', textRole: 'emphasis', lyricLineId: 'n1' } }
  project.clips[word.id] = word
  const editor = new ProjectEditor(project)
  editor.dispatch(lyricsCommands(project, doc), { label: 'Time lyrics' })
  expect(editor.getProject().clips[word.id]).toBeUndefined()
  editor.undo()
  const restored = editor.getProject().clips[word.id]
  expect(restored?.type === 'text' && restored.text).toBe('lights')
})

it('a locked lyric track is left alone and the new clips go on a new track', () => {
  const { project, trackId } = withLyricTrack(true)
  const editor = new ProjectEditor(project)
  editor.dispatch(lyricsCommands(project, doc))
  const clips = lyricClips(editor.getProject())
  expect(clips.filter((c) => c.trackId === trackId).map((c) => c.lyricLineId)).toEqual(['old-1'])
  expect(clips.filter((c) => c.trackId !== trackId)).toHaveLength(2)
})

it('rounds the time of timing that separates the vocals up, like the stems estimate it includes', () => {
  const cost = lyricsCost({ separatesStems: true, downloads: [], downloadBytes: 0, seconds: 389 })
  expect(cost.text).toBe('Separates the vocals first · about 7 min on this device')
})

describe('removeLyricLinesCommands', () => {
  /** Lines n1 and n2 with their clips on a Lyrics track, and a director's emphasized word for each line. */
  function withLines(locked = false, wordsLocked = false) {
    const project = createProject({ name: 'p' })
    const track = { ...createTrack('visual', 'Lyrics'), locked }
    const words = { ...createTrack('visual', 'Words'), locked: wordsLocked }
    project.tracks.unshift(track, words)
    project.lyrics = doc
    const lineClip = (lineId: string, text: string, start: number) => ({
      ...createTextClip({ trackId: track.id, text, start, duration: 2 }),
      lyricLineId: lineId,
    })
    const emphasis = (lineId: string, text: string, start: number) => ({
      ...createTextClip({ trackId: words.id, text, start, duration: 1 }),
      meta: { director: { planId: 'plan', role: 'text', textRole: 'emphasis', lyricLineId: lineId } },
    })
    const clips = {
      n1: lineClip('n1', 'Under the neon skyline', 2),
      n2: lineClip('n2', 'We come alive tonight', 5),
      e1: emphasis('n1', 'skyline', 3.4),
      e2: emphasis('n2', 'tonight', 7),
    }
    for (const c of Object.values(clips)) project.clips[c.id] = c
    return { project, clips }
  }

  it('takes the lines out of the lyrics with their clips and emphasized words, in one undo step', () => {
    const { project, clips } = withLines()
    const editor = new ProjectEditor(project)
    editor.dispatch(removeLyricLinesCommands(project, ['n1']), { label: 'Delete 1 lyric line' })
    const after = editor.getProject()
    expect(after.lyrics?.lines.map((l) => l.id)).toEqual(['n2'])
    expect(Object.keys(after.clips).sort()).toEqual([clips.n2.id, clips.e2.id].sort())
    // The other line's clip is the same clip, where it was.
    expect(after.clips[clips.n2.id]).toEqual(clips.n2)
    editor.undo()
    expect(editor.getProject().lyrics).toEqual(project.lyrics)
    expect(editor.getProject().clips).toEqual(project.clips)
  })

  it('changes nothing for lines that are not in the lyrics, and a locked track refuses the edit', () => {
    const { project } = withLines()
    expect(removeLyricLinesCommands(project, ['gone'])).toEqual([])
    const locked = withLines(true).project
    const editor = new ProjectEditor(locked)
    expect(() => editor.dispatch(removeLyricLinesCommands(locked, ['n1']))).toThrow('Track is locked')
    expect(editor.getProject().lyrics?.lines).toHaveLength(2)
  })

  it('is refused as a whole when a deleted line’s emphasized word is on a locked track', () => {
    const { project } = withLines(false, true)
    const editor = new ProjectEditor(project)
    expect(() => editor.dispatch(removeLyricLinesCommands(project, ['n1']))).toThrow('Track is locked')
    expect(editor.getProject()).toEqual(project)
  })
})

describe('startLyrics', () => {
  /** The stand-in's answers to the next runs, in order. */
  const answers: LyricsResult[] = []
  setLyricsServiceForTests({
    estimate: async () => ({ separatesStems: false, downloads: [], downloadBytes: 0, seconds: 1 }),
    run: () => jobs.run({ kind: 'analysis.lyrics', title: 'Lyrics', run: async () => answers.shift()! }),
    prepareRealign: () =>
      jobs.run({ kind: 'analysis.realign', title: 'Listening', run: async () => undefined }),
    canRealign: () => false,
    realignFrom: () => undefined,
    realignLine: () => undefined,
  })

  /** A song whose detected choruses are at 20, 60 and 100 s. */
  function load() {
    const project = createProject({ name: 'p' })
    project.assets.song = {
      id: 'song',
      kind: 'audio',
      name: 'song.mp3',
      mimeType: 'audio/mpeg',
      byteSize: 1,
      storageKey: 'media/song',
      duration: 120,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
    }
    project.songAssetId = 'song'
    const section = (id: string, start: number, label: string, repeatGroup: number) => ({
      id,
      start,
      end: start + 20,
      label,
      repeatGroup,
      ...(label === 'chorus' ? { confidence: 0.4 } : {}),
    })
    project.analysis.audio.song = {
      assetId: 'song',
      version: 'test',
      sections: ['verse', 'chorus', 'verse', 'chorus', 'verse', 'chorus'].map((label, i) =>
        section(`s${i}`, i * 20, label, label === 'chorus' ? 1 : 0),
      ),
    }
    editor.load(project)
  }

  /**
   * Lyrics that write the chorus out once, then only "Chorus" (one word in each later chorus); their only repeat is
   * the line that opens each verse.
   */
  function once(source: LyricsDoc['source'] = 'pasted'): LyricsDoc {
    const texts: [string, number][] = [
      ['Here we go again my friend', 2],
      ['Woke up late on a Sunday morning', 6],
      ['Chorus we sing all night long', 20.5],
      ['Here we go again my friend', 42],
      ['Streets are empty and the shops are closed', 46],
      ['Chorus', 60.5],
      ['Here we go again my friend', 82],
      ['Every window shows a different face', 86],
      ['Chorus', 100.5],
    ]
    const lines: LyricLine[] = texts.map(([text, start], i) => {
      const words = text
        .split(' ')
        .map((w, k) => ({ text: w, start: start + k / 2, end: start + (k + 1) / 2 }))
      return { id: `l${i}`, text, start, end: words.at(-1)!.end, words }
    })
    return { audioAssetId: 'song', source, lines }
  }

  const choruses = () =>
    (editor.getProject().analysis.audio.song?.sections ?? [])
      .filter((s) => s.label === 'chorus')
      .map((s) => [s.start, s.end])

  it('keeps the long unlisted singing with the timed lyrics and finds the chorus with it, both in their undo step', async () => {
    load()
    answers.push({
      doc: once(),
      unlisted: [
        { start: 5.5, end: 6 },
        { start: 61.004, end: 79.996 },
        { start: 101, end: 120 },
      ],
    })
    await startLyrics({ kind: 'time', text: 'lyrics' })
    const first = structuredClone(editor.getProject().lyrics)
    expect(first?.unlisted).toEqual([
      { start: 61, end: 80 },
      { start: 101, end: 120 },
    ])
    // The later choruses hold one word each: as detected, because their singing is unlisted.
    expect(choruses()).toEqual([
      [20, 40],
      [60, 80],
      [100, 120],
    ])

    answers.push({ doc: once(), unlisted: [] })
    await startLyrics({ kind: 'time', text: 'lyrics' })
    expect(editor.getProject().lyrics).not.toHaveProperty('unlisted')
    expect(choruses()).toEqual([[20, 40]])
    expect(editor.undoLabel()).toBe('Time lyrics')
    editor.undo()
    expect(editor.getProject().lyrics).toEqual(first)
    expect(choruses()).toEqual([
      [20, 40],
      [60, 80],
      [100, 120],
    ])
    editor.redo()
    expect(editor.getProject().lyrics).not.toHaveProperty('unlisted')
    expect(choruses()).toEqual([[20, 40]])
  })

  it('keeps a section the user renamed after timing through undo and redo of the timing', async () => {
    load()
    answers.push({ doc: once(), unlisted: [{ start: 61, end: 80 }] }, { doc: once(), unlisted: [] })
    await startLyrics({ kind: 'time', text: 'lyrics' })
    await startLyrics({ kind: 'time', text: 'lyrics' })
    const last = editor.getProject().analysis.audio.song!.sections!.at(-1)!
    editor.dispatch(
      { type: 'analysis.updateSection', assetId: 'song', sectionId: last.id, patch: { label: 'Outro' } },
      { label: 'Rename section' },
    )
    const renamed = structuredClone(editor.getProject().analysis.audio.song?.sections)
    editor.undo()
    editor.undo()
    expect(choruses()).toEqual([
      [20, 40],
      [60, 80],
    ])
    editor.redo()
    editor.redo()
    expect(editor.getProject().analysis.audio.song?.sections).toEqual(renamed)
    expect(editor.getProject().analysis.audio.song?.sections?.at(-1)?.label).toBe('Outro')
  })

  it('keeps no unlisted singing with a draft', async () => {
    load()
    answers.push({ doc: once('transcribed'), language: 'en', unlisted: [{ start: 61, end: 80 }] })
    await startLyrics({ kind: 'draft' })
    expect(editor.getProject().lyrics?.source).toBe('transcribed')
    expect(editor.getProject().lyrics).not.toHaveProperty('unlisted')
  })
})
