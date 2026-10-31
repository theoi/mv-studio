import { describe, expect, it } from 'vitest'
import {
  createProject,
  createTextClip,
  createTrack,
  ProjectEditor,
  type LyricsDoc,
  type Project,
  type TextClip,
} from '../../../src/model/index.ts'
import { lyricsCommands, lyricsCost, removeLyricLinesCommands } from '../../../src/app/state/lyrics.ts'

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
  function withLines(locked = false) {
    const project = createProject({ name: 'p' })
    const track = { ...createTrack('visual', 'Lyrics'), locked }
    const words = createTrack('visual', 'Words')
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
    expect(editor.getProject().lyrics?.lines.map((l) => l.id)).toEqual(['n1', 'n2'])
    expect(Object.keys(editor.getProject().clips)).toHaveLength(4)
  })

  it('changes nothing for lines that are not in the lyrics, and a locked track refuses the edit', () => {
    const { project } = withLines()
    expect(removeLyricLinesCommands(project, ['gone'])).toEqual([])
    const locked = withLines(true).project
    const editor = new ProjectEditor(locked)
    expect(() => editor.dispatch(removeLyricLinesCommands(locked, ['n1']))).toThrow('Track is locked')
    expect(editor.getProject().lyrics?.lines).toHaveLength(2)
  })
})
