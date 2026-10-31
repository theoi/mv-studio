import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  compilePlan,
  directorMeta,
  planLocally,
  retimeDirectorLyricCommands,
} from '../../../src/director/index.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { LyricLine, LyricsDoc, Project, TextClip } from '../../../src/model/types.ts'
import { LYRICS, makeProject } from './fixtures.ts'

/** A line sung fast: a word every `step` seconds. */
function fastLine(id: string, text: string, start: number, step = 0.2): LyricLine {
  const words = text
    .split(' ')
    .map((w, i) => ({ text: w, start: start + i * step, end: start + i * step + step * 0.85 }))
  return { id, text, start, end: words[words.length - 1]!.end, words }
}

/** The verse sung fast (two-line passage with previews), then the fixture's chorus (emphasized words). */
const SONG: LyricLine[] = [
  fastLine('f1', 'Running down the empty road tonight', 9),
  fastLine('f2', 'Every light is flashing by so fast', 10.3),
  fastLine('f3', 'Holding on to every word you say', 11.8),
  fastLine('f4', 'Never looking back again tonight', 13.3),
  ...LYRICS.slice(2),
]

const shift = (line: LyricLine, by: number): LyricLine => ({
  ...line,
  start: line.start! + by,
  end: line.end! + by,
  words: line.words.map((w) => ({ ...w, start: w.start + by, end: w.end + by })),
})

async function drafted(): Promise<Project> {
  const project = makeProject({ lyrics: SONG })
  const plan = await planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 1 }))
  const editor = new ProjectEditor(project)
  editor.dispatch(compilePlan(plan, project).commands)
  return editor.getProject()
}

const director = (p: Project, role: string, line: string) =>
  Object.values(p.clips).filter(
    (c): c is TextClip =>
      c.type === 'text' && directorMeta(c)?.textRole === role && directorMeta(c)?.lyricLineId === line,
  )

describe('retimeDirectorLyricCommands', () => {
  it('tags emphasized words and next-line previews with their line', async () => {
    const p = await drafted()
    const [word] = director(p, 'emphasis', 'l3')
    expect(word?.text).toBe('tonight')
    expect(word?.lyricLineId).toBeUndefined()
    expect(director(p, 'preview', 'f2')).toHaveLength(1)
  })

  it('moves emphasized words and previews with their lines, and removes those of changed or deleted lines', async () => {
    const p = await drafted()
    const lines = p.lyrics!.lines
    const doc: LyricsDoc = {
      ...p.lyrics!,
      lines: lines
        .filter((l) => l.id !== 'f4')
        .map((l) =>
          l.id === 'f3'
            ? { ...shift(l, 0.5), text: 'Holding on to all the words you say' }
            : l.id === 'l4'
              ? { ...shift(l, 0.5), text: 'We are burning slow' }
              : shift(l, 0.5),
        )
        // The last word of the first chorus line now comes 0.3 s later than the rest.
        .map((l) =>
          l.id === 'l3'
            ? {
                ...l,
                words: l.words.map((w, i) =>
                  i === 4 ? { ...w, start: w.start + 0.3, end: w.end + 0.3 } : w,
                ),
              }
            : l,
        ),
    }
    const before = (id: string) => p.clips[id] as TextClip
    const commands = retimeDirectorLyricCommands(p, doc)
    const editor = new ProjectEditor(p)
    editor.dispatch(commands)
    const after = editor.getProject()

    const [word] = director(p, 'emphasis', 'l3')
    const moved = after.clips[word!.id] as TextClip
    expect(moved.start).toBeCloseTo(before(word!.id).start + 0.8, 3)
    // It still leaves as long after its line as before.
    // It still leaves as long after its line as before.
    expect(moved.start + moved.duration).toBeCloseTo(
      before(word!.id).start + before(word!.id).duration + 0.5,
      3,
    )
    expect(moved.style).toEqual(before(word!.id).style)

    const [preview] = director(p, 'preview', 'f2')
    const shifted = after.clips[preview!.id] as TextClip
    expect(shifted.start).toBeCloseTo(before(preview!.id).start + 0.5, 3)
    expect(shifted.duration).toBeCloseTo(before(preview!.id).duration, 3)

    // f3's words changed and f4 is gone: their previews go. Line clips are left to lyricClipCommands.
    // So does the emphasized word of l4, whose line no longer ends with it.
    const gone = [
      ...director(p, 'preview', 'f3'),
      ...director(p, 'preview', 'f4'),
      ...director(p, 'emphasis', 'l4'),
    ]
    expect(gone.map((c) => c.text.split(/\s+/).pop())).toEqual(['say', 'tonight', 'bright'])
    for (const c of gone) expect(after.clips[c.id]).toBeUndefined()
    const linked = Object.values(p.clips).filter((c) => c.type === 'text' && c.lyricLineId)
    expect(linked.length).toBeGreaterThan(0)
    for (const c of linked) expect(after.clips[c.id]).toEqual(c)
  })

  it('changes nothing when the timing is the same', async () => {
    const p = await drafted()
    expect(retimeDirectorLyricCommands(p, p.lyrics!)).toEqual([])
  })
})
