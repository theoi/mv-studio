import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  compilePlan,
  directorMeta,
  lyricTextCommands,
  planLocally,
  retimeDirectorLyricCommands,
} from '../../../src/director/index.ts'
import { frameWidth, layoutLine, rowWidth, textWidth, TITLE_SAFE } from '../../../src/director/typography.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createTextClip, createTrack, settingsForAspect } from '../../../src/model/factory.ts'
import { parseProject } from '../../../src/model/migrations.ts'
import type { AspectPreset, LyricLine, LyricsDoc, Project, TextClip } from '../../../src/model/types.ts'
import { LYRICS, makeProject, timedLine } from './fixtures.ts'

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

async function drafted(aspect: AspectPreset = '16:9', lyrics = SONG): Promise<Project> {
  const fixture = makeProject({ lyrics })
  const project = { ...fixture, settings: { ...fixture.settings, ...settingsForAspect(aspect) } }
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

  it('retypes whole-line clips and next-line previews, and leaves hand-edited and locked clips', async () => {
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

  const LONG =
    'Every light is flashing by so fast and every sign burns out before the morning comes around again tonight while we keep driving on'
  const styleOf = (clip: TextClip, fontSize = clip.style.fontSize) => ({
    ...clip.style,
    fontSize,
    uppercase: clip.style.textTransform === 'uppercase',
  })
  const settled = (a: { value: number; keyframes?: { value: number }[] }) =>
    a.keyframes?.at(-1)?.value ?? a.value
  /** Where a clip's rows are once it has rolled into place, as fractions of the frame height. */
  const box = (clip: TextClip) => {
    const half =
      (clip.text.split('\n').length *
        (clip.style.lineHeight ?? 1.15) *
        clip.style.fontSize *
        settled(clip.transform.scaleY)) /
      1080 /
      2
    return { top: settled(clip.transform.y) - half, bottom: settled(clip.transform.y) + half }
  }
  const expectClearOfTexts = (p: Project, clip: TextClip) => {
    const b = box(clip)
    for (const other of Object.values(p.clips)) {
      if (other.type !== 'text' || other.id === clip.id) continue
      if (other.start >= clip.start + clip.duration || clip.start >= other.start + other.duration) continue
      const o = box(other)
      expect(o.bottom <= b.top || b.bottom <= o.top).toBe(true)
    }
  }
  /** A text of the user's on a track of its own, shown with `clip`, with its top or bottom edge at `edge`. */
  const withUserText = (p: Project, clip: TextClip, edge: { top: number } | { bottom: number }) => {
    const track = createTrack('visual', 'Text')
    const text = createTextClip({
      trackId: track.id,
      text: 'Not the lyrics',
      start: clip.start,
      duration: clip.duration,
      style: { fontSize: 40 },
    })
    const half = (box(text).bottom - box(text).top) / 2
    const y = 'top' in edge ? edge.top + half : edge.bottom - half
    const editor = new ProjectEditor(p)
    editor.dispatch([
      { type: 'track.add', track },
      { type: 'clip.add', clip: { ...text, transform: { ...text.transform, y: { value: y } } } },
    ])
    return editor.getProject()
  }

  it('lays a retyped line out again as a draft would: in more rows when much longer, back at its size when shorter', async () => {
    const p = await drafted()
    const [line] = lineClips(p, 'f2')
    const [preview] = director(p, 'preview', 'f2')
    const after = retype(p, 'f2', LONG)
    for (const clip of [line!, preview!]) {
      const now = after.clips[clip.id] as TextClip
      const laid = layoutLine(LONG, styleOf(clip), '16:9')
      expect(now.text).toBe(laid.text)
      expect(now.style.fontSize).toBe(laid.fontSize)
      expect(now.text.split('\n').length).toBeGreaterThan(clip.text.split('\n').length)
      for (const row of now.text.split('\n'))
        expect(textWidth(row, styleOf(now))).toBeLessThanOrEqual(rowWidth(styleOf(now), '16:9'))
    }
    const short = retype(after, 'f2', 'Every light')
    expect((short.clips[line!.id] as TextClip).style.fontSize).toBe(line!.style.fontSize)
    // Back to its words, it is as it was drafted.
    const back = retype(after, 'f2', p.lyrics!.lines.find((l) => l.id === 'f2')!.text)
    for (const clip of [line!, preview!]) {
      const now = back.clips[clip.id] as TextClip
      expect({ text: now.text, style: now.style, meta: now.meta }).toEqual({
        text: clip.text,
        style: clip.style,
        meta: clip.meta,
      })
      expect(settled(now.transform.y)).toBeCloseTo(settled(clip.transform.y), 5)
    }
  })

  it('grows a retyped clip away from the text beside it, clear of all text shown with it and inside the title-safe area', async () => {
    const p = await drafted('9:16')
    const [line] = lineClips(p, 'f2')
    const [preview] = director(p, 'preview', 'f2')
    const after = retype(p, 'f2', LONG)
    for (const clip of [line!, preview!]) {
      const now = after.clips[clip.id] as TextClip
      expect(now.text.split('\n').length).toBeGreaterThan(clip.text.split('\n').length)
      expect(now.style.fontSize).toBeGreaterThan(8)
      const b = box(now)
      expect(b.top).toBeGreaterThanOrEqual(TITLE_SAFE.top)
      expect(b.bottom).toBeLessThanOrEqual(TITLE_SAFE.bottom)
      expectClearOfTexts(after, now)
    }
    // The line keeps its bottom edge over the next line waiting below it, and rolls up from where its preview now is.
    const now = after.clips[line!.id] as TextClip
    expect(box(now).bottom).toBeCloseTo(box(line!).bottom, 5)
    expect(now.transform.y.keyframes?.[0]?.value).toBe(
      settled((after.clips[preview!.id] as TextClip).transform.y),
    )
    // Its preview keeps its top edge under the line before it.
    expect(box(after.clips[preview!.id] as TextClip).top).toBeCloseTo(box(preview!).top, 5)
  })

  const GROWN = 'We are burning bright and the night is so young'

  it('fits a retyped line between the texts above and below it, in smaller type when the room is short', async () => {
    const p = await drafted('9:16', LYRICS)
    const [line] = lineClips(p, 'l4')
    const was = box(line!)
    const between = withUserText(withUserText(p, line!, { bottom: was.top - 0.03 }), line!, {
      top: was.bottom + 0.035,
    })
    const after = retype(between, 'l4', GROWN)
    const now = after.clips[line!.id] as TextClip
    expect(now.text.replace(/\s+/g, ' ')).toBe(GROWN)
    expect(now.style.fontSize).toBeLessThan(layoutLine(GROWN, styleOf(line!), '9:16').fontSize)
    expectClearOfTexts(after, now)
  })

  it('keeps a retyped line inside the title-safe area when it was near its edge', async () => {
    const p = await drafted('9:16', LYRICS)
    const [line] = lineClips(p, 'l4')
    const half = (box(line!).bottom - box(line!).top) / 2
    const editor = new ProjectEditor(p)
    editor.dispatch({
      type: 'clip.set',
      clipId: line!.id,
      path: ['transform', 'y', 'value'],
      value: TITLE_SAFE.top + 0.001 + half,
    })
    const now = retype(editor.getProject(), 'l4', GROWN).clips[line!.id] as TextClip
    expect(now.text.split('\n').length).toBeGreaterThan(line!.text.split('\n').length)
    // It stops at the edge rather than growing past it.
    expect(box(now).top).toBeCloseTo(TITLE_SAFE.top, 5)
  })

  it('keeps the size the user set on a retyped line', async () => {
    const p = await drafted('9:16', LYRICS)
    const [line] = lineClips(p, 'l1')
    const drafted_ = line!.style.fontSize
    expect(directorMeta(line!)?.lineLayout).toEqual({ base: drafted_, fitted: drafted_ })
    const editor = new ProjectEditor(p)
    editor.dispatch({ type: 'clip.set', clipId: line!.id, path: ['style', 'fontSize'], value: drafted_ - 20 })
    const now = retype(editor.getProject(), 'l1', 'Walking through').clips[line!.id] as TextClip
    expect(now.style.fontSize).toBe(drafted_ - 20)
    expect(directorMeta(now)?.lineLayout).toEqual({ base: drafted_ - 20, fitted: drafted_ - 20 })
  })

  it('rolls a retyped line up from where its preview now is, also when the preview is stored after it', async () => {
    const p = await drafted('9:16')
    const [line] = lineClips(p, 'f2')
    const [preview] = director(p, 'preview', 'f2')
    const editor = new ProjectEditor(p)
    editor.dispatch([
      { type: 'clip.remove', clipIds: [preview!.id] },
      { type: 'clip.add', clip: preview! },
    ])
    const reordered = editor.getProject()
    const ids = Object.keys(reordered.clips)
    expect(ids.indexOf(preview!.id)).toBeGreaterThan(ids.indexOf(line!.id))
    const after = retype(reordered, 'f2', LONG)
    const moved = settled((after.clips[preview!.id] as TextClip).transform.y)
    expect(moved).not.toBeCloseTo(settled(preview!.transform.y), 3)
    expect((after.clips[line!.id] as TextClip).transform.y.keyframes?.[0]?.value).toBe(moved)
  })

  it('keeps the edge facing the nearest text beside a retyped line, not the first one found', async () => {
    const p = await drafted('9:16', LYRICS)
    const [line] = lineClips(p, 'l4')
    const was = box(line!)
    // The farther text is added first.
    const beside = withUserText(withUserText(p, line!, { bottom: was.top - 0.04 }), line!, {
      top: was.bottom + 0.02,
    })
    const now = retype(beside, 'l4', 'We burn').clips[line!.id] as TextClip
    expect(now.text.split('\n')).toHaveLength(1)
    expect(box(now).bottom).toBeCloseTo(was.bottom, 5)
  })
  it('keeps the words before an emphasized ending no bigger than the ending, above it where they were', async () => {
    const lyrics = SONG.map((l) => (l.id === 'l3' ? timedLine('l3', 'Hold on to me unbreakable me', 25) : l))
    const p = await drafted('9:16', lyrics)
    const [word] = director(p, 'emphasis', 'l3')
    const [head] = lineClips(p, 'l3')
    expect(word?.text).toBe('unbreakable me')
    expect(head!.style.fontSize).toBeLessThanOrEqual(word!.style.fontSize)
    const after = retype(p, 'l3', 'Hold me close and never let me go unbreakable me')
    const now = after.clips[head!.id] as TextClip
    expect(now.text.replace(/\s+/g, ' ')).toBe('Hold me close and never let me go')
    expect(now.style.fontSize).toBeLessThanOrEqual(word!.style.fontSize)
    expect(box(now).bottom).toBeCloseTo(box(head!).bottom, 5)
    expect(after.clips[word!.id]).toEqual(word)
  })

  it('lays out a line with no row break allowed on one row, within the frame', async () => {
    const p = await drafted()
    const [line] = lineClips(p, 'f2')
    expect(line!.text.split('\n')).toHaveLength(2)
    const now = retype(p, 'f2', '(The Supercalifragilisticexpialidocious)').clips[line!.id] as TextClip
    expect(now.text).toBe('(The Supercalifragilisticexpialidocious)')
    expect(textWidth(now.text, styleOf(now))).toBeLessThanOrEqual(0.9 * frameWidth('16:9'))
  })

  it('retypes a lyric of a project saved before clips recorded the size they were laid out from', () => {
    // Text clips of the drafted SONG lyrics at 9:16, as the build before lineLayout saved them.
    const saved = parseProject(
      JSON.parse(readFileSync(path.join(import.meta.dirname, 'saved-before-line-layout.json'), 'utf8')),
    )
    const [line] = lineClips(saved, 'f2')
    const [preview] = director(saved, 'preview', 'f2')
    expect(directorMeta(line!)?.lineLayout).toBeUndefined()
    const after = retype(saved, 'f2', LONG)
    for (const clip of [line!, preview!]) {
      const now = after.clips[clip.id] as TextClip
      // Laid out from the size it has, never larger: the size it was laid out from is not known.
      expect(now.text).toBe(layoutLine(LONG, styleOf(clip), '9:16').text)
      expect(now.text.split('\n').length).toBeGreaterThan(clip.text.split('\n').length)
      for (const row of now.text.split('\n'))
        expect(textWidth(row, styleOf(now))).toBeLessThanOrEqual(rowWidth(styleOf(now), '9:16'))
      const b = box(now)
      expect(b.top).toBeGreaterThanOrEqual(TITLE_SAFE.top)
      expect(b.bottom).toBeLessThanOrEqual(TITLE_SAFE.bottom)
      expectClearOfTexts(after, now)
      // From its first retype on, it records that size, and later retypes grow back to it.
      expect(directorMeta(now)?.lineLayout).toEqual({ base: clip.style.fontSize, fitted: now.style.fontSize })
    }
    expect((retype(saved, 'f2', 'Every light').clips[line!.id] as TextClip).style.fontSize).toBe(
      line!.style.fontSize,
    )
    const back = retype(after, 'f2', saved.lyrics!.lines.find((l) => l.id === 'f2')!.text)
    for (const clip of [line!, preview!]) {
      const now = back.clips[clip.id] as TextClip
      expect({ text: now.text, style: now.style }).toEqual({ text: clip.text, style: clip.style })
      expect(settled(now.transform.y)).toBeCloseTo(settled(clip.transform.y), 5)
    }
  })

  it('changes nothing for the same text or a line that is not in the lyrics', async () => {
    const p = await drafted()
    expect(lyricTextCommands(p, 'l3', p.lyrics!.lines.find((l) => l.id === 'l3')!.text)).toEqual([])
    expect(lyricTextCommands(p, 'nope', 'Anything')).toEqual([])
  })
})
