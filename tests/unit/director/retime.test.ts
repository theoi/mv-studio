import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  compilePlan,
  directorMeta,
  lyricTextCommands,
  planLocally,
  retimeDirectorLyricCommands,
} from '../../../src/director/index.ts'
import { rowWidth, textWidth } from '../../../src/director/typography.ts'
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

describe('lyricTextCommands', () => {
  const retype = (p: Project, lineId: string, text: string) => {
    const editor = new ProjectEditor(p)
    editor.dispatch([
      ...lyricTextCommands(p, lineId, text),
      { type: 'lyrics.updateLine', lineId, patch: { text } },
    ])
    return editor.getProject()
  }
  const lineClips = (p: Project, lineId: string) =>
    Object.values(p.clips).filter((c): c is TextClip => c.type === 'text' && c.lyricLineId === lineId)

  it('keeps an emphasized ending while the line still ends with it, and retypes the words before it', async () => {
    const p = await drafted()
    const [word] = director(p, 'emphasis', 'l3')
    const [head] = lineClips(p, 'l3')
    expect(head?.text).toBe('Hold on hold on')
    const after = retype(p, 'l3', 'Hold me close tonight')
    expect((after.clips[head!.id] as TextClip).text).toBe('Hold me close')
    expect(after.clips[word!.id]).toEqual(word)
    // Timing is the line's, not the text's.
    expect(after.clips[head!.id]).toMatchObject({ start: head!.start, duration: head!.duration })
  })

  it('removes an emphasized ending the line no longer has, and shows the whole line instead', async () => {
    const p = await drafted()
    const [word] = director(p, 'emphasis', 'l4')
    const [head] = lineClips(p, 'l4')
    expect(word?.text).toBe('bright')
    const after = retype(p, 'l4', 'We are burning slow')
    expect(after.clips[word!.id]).toBeUndefined()
    expect((after.clips[head!.id] as TextClip).text).toBe('We are burning slow')
  })

  it('retypes whole-line clips and next-line previews, keeping their rows, and leaves hand-edited and locked clips', async () => {
    const drafted_ = await drafted()
    const [preview] = director(drafted_, 'preview', 'f2')
    const [line] = lineClips(drafted_, 'f2')
    const [first] = lineClips(drafted_, 'f1')
    const editor = new ProjectEditor(drafted_)
    editor.dispatch([
      // The same words in two rows, as the director lays out long lines.
      { type: 'clip.set', clipId: line!.id, path: ['text'], value: 'Every light is\nflashing by so fast' },
      { type: 'clip.set', clipId: first!.id, path: ['text'], value: 'Running down the road' },
    ])
    const p = editor.getProject()
    const after = retype(p, 'f2', 'Every light is racing by so fast')
    expect((after.clips[line!.id] as TextClip).text).toBe('Every light is\nracing by so fast')
    const retyped = (after.clips[preview!.id] as TextClip).text
    expect(retyped.split(/\s+/).join(' ')).toBe('Every light is racing by so fast')
    expect(retyped.split('\n')).toHaveLength(preview!.text.split('\n').length)
    expect(retype(p, 'f1', 'Running down the open road tonight').clips[first!.id]).toEqual(p.clips[first!.id])

    const locked = new ProjectEditor(p)
    locked.dispatch({ type: 'track.update', trackId: preview!.trackId, patch: { locked: true } })
    const kept = retype(locked.getProject(), 'f2', 'Every light is racing by so fast')
    expect(kept.clips[preview!.id]).toEqual(p.clips[preview!.id])
  })

  it('fits a longer line in the rows the director laid it out in, in smaller type, and keeps the size for a shorter one', async () => {
    const p = await drafted()
    const [line] = lineClips(p, 'f2')
    const [preview] = director(p, 'preview', 'f2')
    const long = 'Every light is flashing by so fast and every sign burns out before the morning comes around'
    const after = retype(p, 'f2', long)
    for (const clip of [line!, preview!]) {
      const now = after.clips[clip.id] as TextClip
      expect(now.text.replace(/\s+/g, ' ')).toBe(long)
      expect(now.text.split('\n')).toHaveLength(clip.text.split('\n').length)
      expect(now.style.fontSize).toBeLessThan(clip.style.fontSize)
      const style = { ...now.style, uppercase: now.style.textTransform === 'uppercase' }
      for (const row of now.text.split('\n'))
        expect(textWidth(row, style, now.style.fontSize)).toBeLessThanOrEqual(rowWidth(style, '16:9'))
    }
    const short = retype(p, 'f2', 'Every light')
    expect((short.clips[line!.id] as TextClip).style.fontSize).toBe(line!.style.fontSize)
  })

  it('changes nothing for the same text or a line that is not in the lyrics', async () => {
    const p = await drafted()
    expect(lyricTextCommands(p, 'l3', p.lyrics!.lines.find((l) => l.id === 'l3')!.text)).toEqual([])
    expect(lyricTextCommands(p, 'nope', 'Anything')).toEqual([])
  })
})
