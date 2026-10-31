import { describe, expect, it } from 'vitest'
import { lineDeltaRange, lineTimingCommands, wordEdgeCommands } from '../../../src/app/state/lyricEdits.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createAudioClip, createProject, createTextClip } from '../../../src/model/factory.ts'
import type { EditCommand } from '../../../src/model/commands.ts'
import type { LyricLine, Project, TextClip } from '../../../src/model/types.ts'

/**
 * A song clip and three lyric clips on one track. The middle line "hold on tight" is sung 10–11.8 s: "hold" and "on"
 * touch, "tight" starts after a gap. Its clip shows 9.8–12.1 s; the clip before ends at 9.5, the one after starts at
 * 12.5.
 */
function setup(song: { start?: number; sourceStart?: number; playbackRate?: number } = {}) {
  const project: Project = createProject()
  const music = project.tracks.find((t) => t.kind === 'audio')!
  const visual = project.tracks.find((t) => t.kind === 'visual')!
  project.songAssetId = 'song'
  const audio = createAudioClip({ trackId: music.id, assetId: 'song', start: song.start ?? 0, duration: 200 })
  audio.sourceStart = song.sourceStart ?? 0
  audio.playbackRate = song.playbackRate ?? 1
  project.clips[audio.id] = audio
  const line: LyricLine = {
    id: 'mid',
    text: 'hold on tight',
    start: 10,
    end: 11.8,
    words: [
      { text: 'hold', start: 10, end: 10.5 },
      { text: 'on', start: 10.5, end: 11 },
      { text: 'tight', start: 11.2, end: 11.8 },
    ],
  }
  project.lyrics = { source: 'pasted', audioAssetId: 'song', lines: [line] }
  const lyric = (lineId: string, start: number, duration: number) => {
    const clip = createTextClip({ trackId: visual.id, text: lineId, start, duration })
    clip.lyricLineId = lineId
    project.clips[clip.id] = clip
    return clip
  }
  lyric('before', 7, 2.5)
  const clip = lyric('mid', 9.8, 2.3)
  lyric('after', 12.5, 2)
  return { project, clip }
}

function apply(project: Project, commands: EditCommand[] | null) {
  if (!commands) throw new Error('no commands')
  const editor = new ProjectEditor(project)
  editor.dispatch(commands)
  const next = editor.getProject()
  const line = next.lyrics!.lines[0]!
  const clip = Object.values(next.clips).find((c) => c.type === 'text' && c.lyricLineId === 'mid') as TextClip
  return { line, clip, words: line.words.map((w) => [w.start, w.end]) }
}

const close = (actual: number[][], expected: number[][]) =>
  actual.forEach((pair, i) => pair.forEach((v, k) => expect(v).toBeCloseTo(expected[i]![k]!, 6)))

describe('lineTimingCommands', () => {
  it('moves the whole line: every word, the line span and its clip', () => {
    const { project } = setup()
    const r = apply(project, lineTimingCommands(project, 'mid', 'move', 0.3))
    close(r.words, [
      [10.3, 10.8],
      [10.8, 11.3],
      [11.5, 12.1],
    ])
    expect(r.line.start).toBeCloseTo(10.3, 6)
    expect(r.line.end).toBeCloseTo(12.1, 6)
    expect(r.clip.start).toBeCloseTo(10.1, 6)
    expect(r.clip.duration).toBeCloseTo(2.3, 6)
  })

  it('stops a move at the next clip on the track', () => {
    const { project } = setup()
    expect(lineDeltaRange(project, 'mid', 'move')![1]).toBeCloseTo(0.4, 6)
    const r = apply(project, lineTimingCommands(project, 'mid', 'move', 5))
    expect(r.clip.start + r.clip.duration).toBeCloseTo(12.5, 6)
    expect(r.words[2]![1]).toBeCloseTo(12.2, 6)
  })

  it('moves the start edge with the first word only, keeping the lead before it', () => {
    const { project } = setup()
    const r = apply(project, lineTimingCommands(project, 'mid', 'start', 0.2))
    close(r.words, [
      [10.2, 10.5],
      [10.5, 11],
      [11.2, 11.8],
    ])
    expect(r.line.start).toBeCloseTo(10.2, 6)
    expect(r.line.end).toBe(11.8)
    expect(r.clip.start).toBeCloseTo(10, 6)
    expect(r.clip.start + r.clip.duration).toBeCloseTo(12.1, 6)
  })

  it('never lets the first word or the last word shrink below 50 ms', () => {
    const { project } = setup()
    expect(apply(project, lineTimingCommands(project, 'mid', 'start', 3)).words[0]![0]).toBeCloseTo(10.45, 6)
    expect(apply(project, lineTimingCommands(project, 'mid', 'end', -3)).words[2]![1]).toBeCloseTo(11.25, 6)
  })

  it('moves the end edge with the last word and the clip end', () => {
    const { project } = setup()
    const r = apply(project, lineTimingCommands(project, 'mid', 'end', 0.25))
    expect(r.words[2]).toEqual([11.2, 12.05])
    expect(r.line.end).toBeCloseTo(12.05, 6)
    expect(r.clip.start).toBe(9.8)
    expect(r.clip.duration).toBeCloseTo(2.55, 6)
  })

  it('converts timeline seconds to the song time the words are in', () => {
    // The song starts 5 s into the timeline, from 2 s into the file, at double speed: 1 timeline second is 2 song seconds.
    const { project } = setup({ start: 5, sourceStart: 2, playbackRate: 2 })
    const r = apply(project, lineTimingCommands(project, 'mid', 'move', 0.25))
    expect(r.words[0]).toEqual([10.5, 11])
    expect(r.clip.start).toBeCloseTo(10.05, 6)
  })

  it('has nothing to move for a line without timing', () => {
    const { project } = setup()
    project.lyrics!.lines[0] = { id: 'mid', text: 'hold on tight', words: [] }
    expect(lineTimingCommands(project, 'mid', 'move', 0.3)).toBeNull()
    expect(lineDeltaRange(project, 'mid', 'start')).toBeNull()
  })
})

describe('wordEdgeCommands', () => {
  it('moves the boundary of two touching words together, up to 50 ms before the next word ends', () => {
    const { project } = setup()
    close(apply(project, wordEdgeCommands(project, 'mid', 0, 'end', 0.1)).words, [
      [10, 10.6],
      [10.6, 11],
      [11.2, 11.8],
    ])
    close(apply(project, wordEdgeCommands(project, 'mid', 0, 'end', 2)).words.slice(0, 2), [
      [10, 10.95],
      [10.95, 11],
    ])
  })

  it('stops at the next word when there is a gap, leaving that word alone', () => {
    const { project } = setup()
    close(apply(project, wordEdgeCommands(project, 'mid', 1, 'end', 1)).words.slice(1), [
      [10.5, 11.2],
      [11.2, 11.8],
    ])
  })

  it('keeps the first word inside its clip and the line start on the first word', () => {
    const { project } = setup()
    const r = apply(project, wordEdgeCommands(project, 'mid', 0, 'start', -1))
    expect(r.words[0]).toEqual([9.8, 10.5])
    expect(r.line.start).toBeCloseTo(9.8, 6)
    expect(r.clip.start).toBe(9.8)
  })
})
