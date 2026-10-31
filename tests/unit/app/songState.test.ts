import { describe, expect, it } from 'vitest'
import { createProject, type AudioAnalysis, type Project } from '../../../src/model/index.ts'
import { bpmOf } from '../../../src/app/state/project.ts'
import { foundText, songState } from '../../../src/app/state/songAnalysis.ts'

function withSong(analysis?: Partial<AudioAnalysis>): Project {
  const p = createProject()
  p.songAssetId = 'song'
  if (analysis) p.analysis.audio.song = { assetId: 'song', version: 'test', ...analysis }
  return p
}

describe('where the song analysis stands', () => {
  it('is not analyzed after a cancelled first analysis, and analyzing while it runs or waits for its file', () => {
    expect(songState(withSong(), 'idle', false)).toBe('not-analyzed')
    expect(songState(withSong(), 'running', false)).toBe('analyzing')
    expect(songState(withSong(), 'idle', true)).toBe('analyzing')
    expect(songState(withSong(), 'failed', false)).toBe('failed')
  })

  it('found no beat in a silent song, whose tempo is 0, and has no tempo to show', () => {
    const silent = withSong({ tempo: { bpm: 0, confidence: 0 }, beats: [] })
    expect(songState(silent, 'done', false)).toBe('no-beat')
    expect(bpmOf(silent)).toBeUndefined()
  })

  it('shows the facts of an analysis with a beat, also while the song is analyzed again', () => {
    const song = withSong({ tempo: { bpm: 120, confidence: 0.9 }, beats: [0, 0.5] })
    expect(songState(song, 'running', false)).toBe('analyzed')
    expect(bpmOf(song)).toBe(120)
  })
})

describe('what an analysis found, for its toast', () => {
  it('names the tempo and the sections, or says no beat was found', () => {
    const sections = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `s${i}`, start: i, end: i + 1, label: 'verse' }))
    expect(foundText({ tempo: { bpm: 119.6, confidence: 0.9 }, sections: sections(7) })).toBe(
      'Found 120 BPM and 7 sections',
    )
    expect(foundText({ tempo: { bpm: 0, confidence: 0 }, sections: sections(1) })).toBe(
      'No beat found. The song has 1 section',
    )
    expect(foundText({})).toBe('No beat found')
  })
})
