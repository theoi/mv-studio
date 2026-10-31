import { describe, expect, it } from 'vitest'
import { createProject, ProjectEditor, type LyricLine, type LyricsDoc } from '../../../src/model/index.ts'

const words = (text: string, confidence = 0.4) =>
  text.split(' ').map((w, i) => ({ text: w, start: i, end: i + 0.8, confidence }))

function withLines(check: LyricLine['check']): ProjectEditor {
  const lines: LyricLine[] = [
    {
      id: 'a',
      text: 'neon lights are calling',
      start: 0,
      end: 4,
      words: words('neon lights are calling'),
      check,
    },
    {
      id: 'b',
      text: 'we run until the morning',
      start: 5,
      end: 9,
      words: words('we run until the morning'),
      check,
    },
  ]
  const doc: LyricsDoc = { source: check === 'words' ? 'transcribed' : 'pasted', lines }
  const editor = new ProjectEditor(createProject({ name: 'p' }))
  editor.dispatch({ type: 'lyrics.set', lyrics: doc }, { label: 'Lyrics' })
  return editor
}

const line = (editor: ProjectEditor, id: string) =>
  editor.getProject().lyrics!.lines.find((l) => l.id === id)!
const shifted = (l: LyricLine) => l.words.map((w) => ({ ...w, start: w.start + 0.1, end: w.end + 0.1 }))

describe('a lyric line to check', () => {
  it('is checked when its text is retyped, in that undo step', () => {
    const editor = withLines('words')
    editor.dispatch({ type: 'lyrics.updateLine', lineId: 'a', patch: { text: 'neon lights keep calling' } })
    expect('check' in line(editor, 'a')).toBe(false)
    expect(line(editor, 'b').check).toBe('words')
    editor.undo()
    expect(line(editor, 'a').check).toBe('words')
  })

  it('drafted: stays to check when re-timed, and is checked when a word’s text changes', () => {
    const editor = withLines('words')
    editor.dispatch({
      type: 'lyrics.updateLine',
      lineId: 'a',
      patch: { words: shifted(line(editor, 'a')), start: 0.1 },
    })
    editor.dispatch({ type: 'lyrics.updateLine', lineId: 'a', patch: { text: 'neon lights are calling' } })
    expect(line(editor, 'a').check).toBe('words')
    const fixed = line(editor, 'a').words.map((w, i) => (i === 1 ? { ...w, text: 'nights' } : w))
    editor.dispatch({ type: 'lyrics.updateLine', lineId: 'a', patch: { words: fixed } })
    expect(line(editor, 'a').check).toBeUndefined()
  })

  it.each(['timing', 'unlisted'] as const)(
    '%s: stays to check when only its text is retyped, which says nothing about where the words fall',
    (check) => {
      const editor = withLines(check)
      editor.dispatch({ type: 'lyrics.updateLine', lineId: 'a', patch: { text: 'neon lights keep calling' } })
      expect(line(editor, 'a').check).toBe(check)
    },
  )

  it.each(['timing', 'unlisted'] as const)(
    '%s: is checked when the line or its words are re-timed',
    (check) => {
      const editor = withLines(check)
      editor.dispatch({ type: 'lyrics.updateLine', lineId: 'a', patch: { start: 0.2 } })
      expect(line(editor, 'a').check).toBeUndefined()
      editor.dispatch({
        type: 'lyrics.updateLine',
        lineId: 'b',
        patch: { words: shifted(line(editor, 'b')) },
      })
      expect(line(editor, 'b').check).toBeUndefined()
    },
  )

  it('is marked as checked by a patch that sets check to undefined, and undo brings it back', () => {
    const editor = withLines('words')
    editor.dispatch(
      [
        { type: 'lyrics.updateLine', lineId: 'a', patch: { check: undefined } },
        { type: 'lyrics.updateLine', lineId: 'b', patch: { check: undefined } },
      ],
      { label: 'Mark all lines as checked' },
    )
    expect(editor.getProject().lyrics!.lines.some((l) => 'check' in l)).toBe(false)
    expect(editor.undoLabel()).toBe('Mark all lines as checked')
    editor.undo()
    expect(editor.getProject().lyrics!.lines.every((l) => l.check === 'words')).toBe(true)
  })
})
