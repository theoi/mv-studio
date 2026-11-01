import { describe, expect, it, vi } from 'vitest'
import type { Clip, GeneratorClip, Project } from '../../../src/model/types.ts'
import { currentLook } from '../../../src/plugins/looks.ts'
import { sampleSong } from '../../../src/app/mock/demoProject.ts'

vi.mock('../../../src/app/state/persistence.ts', () => ({
  loadSetupDraft: vi.fn(),
  startProject: vi.fn(),
  unusedProjectName: (name: string) => name,
}))
vi.mock('../../../src/app/state/importer.ts', () => ({ analyzeSong: vi.fn(), storeFiles: vi.fn() }))
vi.mock('../../../src/app/state/director.ts', () => ({ draftFromSetup: vi.fn() }))

const { buildSetupProject, chooseSong, isAudioFile, isVisualFile, useSetup } =
  await import('../../../src/app/state/setup.ts')
const { storeFiles } = await import('../../../src/app/state/importer.ts')

const onTrack = (p: Project, name: string): Clip[] => {
  const track = p.tracks.find((t) => t.name === name)
  return Object.values(p.clips).filter((c) => c.trackId === track?.id)
}

describe('the project the setup screen opens', () => {
  const sample = sampleSong()

  it('uses the song, its analysis and the chosen visualizer style', () => {
    const p = buildSetupProject('visualizer', {
      name: sample.title,
      song: sample.asset,
      analysis: sample.analysis,
      visualizerStyle: 'particles',
    })
    expect(p.name).toBe('Neon Skyline')
    expect(p.songAssetId).toBe(sample.asset.id)
    expect(p.analysis.audio[sample.asset.id]?.tempo?.bpm).toBe(sample.analysis.tempo?.bpm)
    const [visualizer] = onTrack(p, 'Visualizer') as GeneratorClip[]
    expect(visualizer?.generatorId).toBe('visualizer.particles')
    expect(currentLook(p)?.lookId).toBe('dreamy')
  })

  it('gives a lyric video the sample song’s timed lyrics, on the Lyrics track, when none were pasted', () => {
    const p = buildSetupProject('lyric', {
      song: sample.asset,
      analysis: sample.analysis,
      timedLyrics: sample.lyrics,
    })
    expect(p.lyrics?.lines).toHaveLength(sample.lyrics.lines.length)
    expect(p.lyrics?.lines.every((l) => l.words.length > 0)).toBe(true)
    const lines = onTrack(p, 'Lyrics')
    expect(lines.length).toBe(sample.lyrics.lines.length)
    expect(lines.every((c) => c.type === 'text' && c.lyricLineId)).toBe(true)
  })

  it('prefers pasted lyrics over the sample’s, as untimed lines', () => {
    const p = buildSetupProject('lyric', {
      song: sample.asset,
      analysis: sample.analysis,
      timedLyrics: sample.lyrics,
      lyrics: 'First line\n\n  Second line  \n',
    })
    expect(p.lyrics?.lines.map((l) => l.text)).toEqual(['First line', 'Second line'])
    expect(p.lyrics?.lines.every((l) => l.words.length === 0)).toBe(true)
  })

  it('keeps the clips of a beat-cut video as media, and makes a project without a song when skipped', () => {
    const clip = { ...sample.asset, id: 'clip-1', kind: 'video' as const, name: 'clip.mp4' }
    const p = buildSetupProject('footage', { footage: [clip] })
    expect(p.assets['clip-1']?.name).toBe('clip.mp4')
    expect(p.songAssetId).toBeUndefined()
    expect(p.tracks.map((t) => t.name)).toContain('Video')
  })
})

describe('the song the setup screen takes', () => {
  it('is named by the title in its file name while it is stored, then by its tags', async () => {
    const tagged = {
      ...sampleSong().asset,
      id: 'song-2',
      name: 'song_show-me_josh-woodward.mp3',
      tags: { title: 'Show Me', artist: 'Josh Woodward' },
    }
    let stored: (result: Awaited<ReturnType<typeof storeFiles>>) => void = () => {}
    vi.mocked(storeFiles).mockReturnValue(new Promise((resolve) => (stored = resolve)))
    const choosing = chooseSong(new File(['x'], tagged.name, { type: 'audio/mpeg' }))
    expect(useSetup.getState().song?.title).toBe('Song Show Me Josh Woodward')
    stored({ assets: [tagged], failed: [] })
    await choosing
    expect(useSetup.getState().song?.title).toBe('Show Me')
  })
})

describe('the files the setup screen takes', () => {
  const file = (name: string, type: string) => new File(['x'], name, { type })

  it('takes audio as the song, by type or, without one, by extension', () => {
    expect(isAudioFile(file('a.mp3', 'audio/mpeg'))).toBe(true)
    expect(isAudioFile(file('a.flac', ''))).toBe(true)
    expect(isAudioFile(file('a.mp4', 'video/mp4'))).toBe(false)
    expect(isAudioFile(file('notes.txt', ''))).toBe(false)
  })

  it('takes videos and images as clips', () => {
    expect(isVisualFile(file('a.mp4', 'video/mp4'))).toBe(true)
    expect(isVisualFile(file('a.png', 'image/png'))).toBe(true)
    expect(isVisualFile(file('a.mov', ''))).toBe(true)
    expect(isVisualFile(file('a.wav', 'audio/wav'))).toBe(false)
  })
})
