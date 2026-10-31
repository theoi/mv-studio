import { expect, it } from 'vitest'
import {
  createProject,
  createTextClip,
  createTrack,
  ProjectEditor,
  type LyricsDoc,
  type Project,
  type TextClip,
} from '../../../src/model/index.ts'
import { lyricsCommands } from '../../../src/app/state/lyrics.ts'

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
