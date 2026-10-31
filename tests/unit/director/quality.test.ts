import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  planLocally,
  PACES,
  type EditPlan,
  type PlanShot,
} from '../../../src/director/index.ts'
import { musicEnd, songTitleFromName } from '../../../src/director/inputs.ts'
import { paceFor } from '../../../src/director/rules.ts'
import { beatGrid, cutTimes, phrasedCutTimes } from '../../../src/director/timing.ts'
import type { Asset, LyricLine, Project } from '../../../src/model/types.ts'
import { analysis, BEATS, DOWNBEATS, LYRICS, makeProject, SONG_ID, SONG_LENGTH } from './fixtures.ts'

const grid = beatGrid({
  duration: SONG_LENGTH,
  bpm: 120,
  beats: BEATS,
  downbeats: DOWNBEATS,
  sections: [],
  analyzed: true,
})

function main(p: EditPlan): PlanShot[] {
  return p.shots.filter((s) => s.layer === 'main').sort((a, b) => a.start - b.start)
}

async function plan(project: Project, kind: EditPlan['kind'], prompt = '') {
  return planLocally(await buildPlannerInput(project, { kind, seed: 7, prompt }))
}

const rank = (pace: (typeof PACES)[number]) => PACES.indexOf(pace)

describe('phrased cuts', () => {
  it('cuts louder bars twice as often and quieter bars half as often', () => {
    // 120 BPM, bars every 2 s: bars at 4-8 s are loud, bars at 12-16 s quiet.
    const energyAt = (start: number) => (start >= 4 && start < 8 ? 0.9 : start >= 12 ? 0.1 : 0.5)
    expect(phrasedCutTimes(0, 16, 4, grid, { energyAt })).toEqual([0, 2, 4, 5, 6, 7, 8, 10, 14])
  })

  it('speeds up through the last bar into a faster section', () => {
    expect(phrasedCutTimes(0, 8, 4, grid, { lift: true })).toEqual([0, 2, 4, 6, 7])
  })

  it('keeps an even rhythm when energy is flat', () => {
    expect(phrasedCutTimes(0, 16, 4, grid, { energyAt: () => 0.6 })).toEqual(cutTimes(0, 16, 4, grid))
  })
})

describe('pacing', () => {
  it('cuts choruses faster than verses even when the chorus measures quieter', () => {
    const chorus = paceFor('beat-cut', { label: 'chorus', energy: 0.82 }, 75, false)
    const verse = paceFor('beat-cut', { label: 'verse', energy: 0.87 }, 75, false)
    const intro = paceFor('beat-cut', { label: 'intro', energy: 0.3 }, 75, false)
    expect(rank(chorus)).toBeGreaterThan(rank(verse))
    expect(rank(verse)).toBeGreaterThan(rank(intro))
  })

  it('slows lyric videos and shifts every section for a preferred pace, keeping the contrast', () => {
    const chorus = { label: 'Chorus 2', energy: 0.9 }
    const verse = { label: 'Verse 1', energy: 0.9 }
    expect(rank(paceFor('lyric', chorus, 110, false))).toBeLessThan(
      rank(paceFor('beat-cut', chorus, 110, false)),
    )
    const fastChorus = paceFor('beat-cut', chorus, 110, false, 'fast')
    const fastVerse = paceFor('beat-cut', verse, 110, false, 'fast')
    expect(rank(fastVerse)).toBe(rank(paceFor('beat-cut', verse, 110, false)) + 1)
    expect(rank(fastChorus)).toBeGreaterThan(rank(fastVerse))
  })
})

describe('draft quality', () => {
  it('keeps lyric-video cuts out of sung lines', async () => {
    const p = await plan(makeProject(), 'lyric')
    const cuts = main(p).map((s) => s.start)
    expect(cuts.length).toBeGreaterThan(8)
    for (const t of cuts) {
      const inside = LYRICS.find((l) => t > l.start! + 0.2 && t < l.end! - 0.1)
      expect(inside, `cut at ${t}`).toBeUndefined()
    }
  })

  it('slows a clip slightly shorter than its shot instead of starting it before its first frame', async () => {
    const project = makeProject({ videos: 0 })
    const clip: Asset = {
      id: 'short',
      kind: 'video',
      name: 'short.mp4',
      mimeType: 'video/mp4',
      byteSize: 1000,
      storageKey: 'media/short',
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
      // 0.75% shorter than the 4 s intro shots.
      duration: 3.97,
    }
    project.assets.short = clip
    const p = await plan(project, 'beat-cut')
    const long = main(p).filter((s) => s.end - s.start > 3.97)
    expect(long.length).toBeGreaterThan(0)
    for (const s of main(p)) {
      if (s.source.type !== 'media') throw new Error('expected media')
      const rate = s.source.playbackRate ?? 1
      expect(s.source.sourceStart ?? 0).toBeGreaterThanOrEqual(0)
      expect((s.source.sourceStart ?? 0) + (s.end - s.start) * rate).toBeLessThanOrEqual(3.97 + 1e-3)
    }
  })

  it("titles the video with the song's title and artist, never the prompt", async () => {
    const project = makeProject({ videos: 0 })
    project.assets[SONG_ID] = { ...project.assets[SONG_ID]!, name: 'Rxbyn_-_Bad_Side.mp3' }
    const p = await plan(project, 'visualizer', 'neon city at night')
    expect(p.texts.filter((t) => t.role === 'title').map((t) => t.text)).toEqual(['Bad Side', 'Rxbyn'])
  })

  it('fades in from black, fades out at the end and stops when the music does', async () => {
    const project = makeProject()
    // Music for 60 s, then 4 s of silence.
    const values = Array.from({ length: SONG_LENGTH * 10 }, (_, i) =>
      i < 600 ? 0.4 + 0.4 * Math.sin(i / 30) ** 2 : 0,
    )
    project.analysis.audio[SONG_ID] = analysis({ energy: { rate: 10, values } })
    expect(musicEnd({ duration: SONG_LENGTH, energy: { rate: 10, values } })).toBe(60)
    const shots = main(await plan(project, 'beat-cut'))
    expect(shots[0]!.transitionIn?.kind).toBe('fade')
    const last = shots[shots.length - 1]!
    expect(last.end).toBe(60)
    expect(last.transitionOut?.kind).toBe('fade')
    expect(shots.slice(0, -1).every((s) => !s.transitionOut)).toBe(true)
  })

  it('gives intros, verses and choruses their own visualizer and repeats it with the chorus', async () => {
    const shots = main(await plan(makeProject({ videos: 0 }), 'visualizer'))
    const generator = (id: string) => {
      const s = shots.find((x) => x.sectionId === id)!.source
      return s.type === 'generator' ? s.generatorId : undefined
    }
    expect(new Set([generator('s-intro'), generator('s-verse'), generator('s-chorus1')]).size).toBe(3)
    expect(generator('s-chorus2')).toBe(generator('s-chorus1'))
  })

  it('gives a fast long line time to be read when the gap after it allows', async () => {
    const text = 'every word of this long line goes by much too fast to read'
    const words = text.split(' ').map((w, i) => ({ text: w, start: 9 + i * 0.08, end: 9 + i * 0.08 + 0.07 }))
    const line: LyricLine = { id: 'fast', text, start: 9, end: words[words.length - 1]!.end, words }
    const p = await plan(makeProject({ lyrics: [line, ...LYRICS.slice(1)] }), 'lyric')
    const shown = p.texts.find((t) => t.lyricLineId === 'fast')!
    expect(shown.end - shown.start).toBeGreaterThanOrEqual(text.length / 17 - 1e-3)
    expect(shown.end).toBeLessThan(LYRICS[1]!.start!)
  })
})

describe('songTitleFromName', () => {
  it.each([
    ['Rxbyn_-_Bad_Side.mp3', { artist: 'Rxbyn', title: 'Bad Side' }],
    ['Lower Loveday – Is It Right.flac', { artist: 'Lower Loveday', title: 'Is It Right' }],
    ['03 - Night Drive.wav', { title: 'Night Drive' }],
    ['demo.mp3', { title: 'demo' }],
  ])('%s', (name, expected) => {
    expect(songTitleFromName(name)).toEqual(expected)
  })
})
