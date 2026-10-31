import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  DirectorError,
  estimatePlanCost,
  generationOptionsFor,
  planLocally,
  shotsToGenerate,
  type EditPlan,
  type FootageMatcher,
  type MatchQuery,
  type PlanShot,
} from '../../../src/director/index.ts'
import { MOOD_PROMPTS } from '../../../src/vision/matching/prompts.ts'
import {
  BEATS,
  fakeProvider,
  LYRICS,
  makeProject,
  SECTIONS,
  SONG_LENGTH,
  type FixtureOptions,
} from './fixtures.ts'

async function plan(
  kind: EditPlan['kind'],
  fixture: FixtureOptions = {},
  extra: Parameters<typeof buildPlannerInput>[1] | object = {},
) {
  const project = makeProject(fixture)
  const input = await buildPlannerInput(project, { kind, seed: 7, ...extra })
  return planLocally(input)
}

function main(p: EditPlan): PlanShot[] {
  return p.shots.filter((s) => s.layer === 'main').sort((a, b) => a.start - b.start)
}

function expectContiguous(shots: PlanShot[], duration: number) {
  expect(shots.length).toBeGreaterThan(0)
  expect(shots[0]!.start).toBe(0)
  for (let i = 1; i < shots.length; i++) expect(shots[i]!.start).toBeCloseTo(shots[i - 1]!.end, 3)
  expect(shots[shots.length - 1]!.end).toBeCloseTo(duration, 3)
}

const meanLength = (shots: PlanShot[]) => shots.reduce((s, x) => s + x.end - x.start, 0) / shots.length

describe('local planner', () => {
  it('cuts footage on beats, faster in the chorus than in the verse', async () => {
    const p = await plan('beat-cut')
    const shots = main(p)
    expectContiguous(shots, SONG_LENGTH)
    const sectionStarts = new Set(SECTIONS.map((s) => s.start))
    for (const s of shots) {
      if (!sectionStarts.has(s.start)) expect(BEATS).toContain(s.start)
      expect(s.source.type).toBe('media')
    }
    const chorus = shots.filter((s) => s.sectionId === 's-chorus1')
    const verse = shots.filter((s) => s.sectionId === 's-verse')
    expect(meanLength(chorus)).toBeLessThan(meanLength(verse))
    // Sections start on a bar here, so the cut rhythm starts with them: equal shots, only the last may be shorter.
    for (const section of SECTIONS) {
      const lengths = shots.filter((s) => s.sectionId === section.id).map((s) => s.end - s.start)
      for (const length of lengths.slice(0, -1)) expect(length).toBeCloseTo(lengths[0]!, 3)
    }
    expect(p.warnings).toEqual([])
  })

  it('never uses the same clip twice in a row and keeps video windows inside the source', async () => {
    const project = makeProject()
    const p = await planLocally(await buildPlannerInput(project, { kind: 'beat-cut', seed: 3 }))
    const shots = main(p)
    for (let i = 1; i < shots.length; i++) {
      const a = shots[i - 1]!.source
      const b = shots[i]!.source
      expect(a.type === 'media' && b.type === 'media' && a.assetId === b.assetId).toBe(false)
    }
    for (const s of shots) {
      if (s.source.type !== 'media') continue
      const duration = project.assets[s.source.assetId]!.duration!
      const rate = s.source.playbackRate ?? 1
      expect((s.source.sourceStart ?? 0) + (s.end - s.start) * rate).toBeLessThanOrEqual(duration + 1e-3)
    }
  })

  it('is deterministic for a seed and varies with the seed', async () => {
    const strip = (p: EditPlan) => main(p).map((s) => [s.start, s.end, JSON.stringify(s.source), s.motion])
    const a = await plan('beat-cut', { images: 2 })
    const b = await plan('beat-cut', { images: 2 })
    expect(strip(a)).toEqual(strip(b))
    const others = await Promise.all([2, 3, 4].map((seed) => plan('beat-cut', { images: 2 }, { seed })))
    expect(others.some((o) => JSON.stringify(strip(o)) !== JSON.stringify(strip(a)))).toBe(true)
  })

  it('asks the footage matcher with moods it knows and uses its best clips and ranges', async () => {
    const project = makeProject()
    const queries: MatchQuery[] = []
    const matcher: FootageMatcher = {
      async rank(query) {
        if (typeof query !== 'string') queries.push(query)
        return [
          { assetId: 'video4', score: 0.95, time: 7.5 },
          { assetId: 'video2', score: 0.4 },
        ]
      },
      info: async () => [],
    }
    const p = await planLocally(await buildPlannerInput(project, { kind: 'beat-cut', seed: 7, matcher }))
    expect(queries).toHaveLength(SECTIONS.length)
    for (const q of queries) if (q.mood) expect(Object.keys(MOOD_PROMPTS)).toContain(q.mood)
    const loudest = queries.reduce((a, b) => ((b.energy ?? 0) > (a.energy ?? 0) ? b : a))
    expect(loudest.mood).toBe('energetic')
    const firstUse = main(p).find((s) => s.source.type === 'media' && s.source.assetId === 'video4')!
    expect(firstUse.source.type === 'media' && firstUse.source.sourceStart).toBe(7.5)
    expect(p.warnings).toEqual([])
  })

  it('places every timed lyric line with karaoke highlighting', async () => {
    const p = await plan('lyric')
    const lyricTexts = p.texts.filter((t) => t.role === 'lyric')
    expect(lyricTexts.map((t) => t.lyricLineId)).toEqual(LYRICS.map((l) => l.id))
    for (const [i, t] of lyricTexts.entries()) {
      expect(t.karaoke?.mode).toBe('word')
      expect(t.start).toBeLessThanOrEqual(LYRICS[i]!.start!)
      expect(t.end).toBeGreaterThanOrEqual(LYRICS[i]!.end!)
      if (i > 0) expect(t.start).toBeGreaterThanOrEqual(lyricTexts[i - 1]!.end)
    }
    // Lyric videos dim the background so text stays readable.
    expect(main(p).every((s) => (s.adjustments?.brightness ?? 0) < 0)).toBe(true)
  })

  it('spreads untimed lyrics evenly with a warning', async () => {
    const untimed = LYRICS.map((l) => ({ id: l.id, text: l.text, words: [] }))
    const p = await plan('lyric', { lyrics: untimed })
    const texts = p.texts.filter((t) => t.role === 'lyric')
    expect(texts).toHaveLength(untimed.length)
    expect(texts.every((t) => !t.karaoke)).toBe(true)
    expect(p.warnings.some((w) => w.includes("Lyrics aren't timed"))).toBe(true)
  })

  it('asks for lyrics when a lyric video has none', async () => {
    const p = await plan('lyric', { lyrics: null })
    expect(p.texts).toEqual([])
    expect(p.warnings.some((w) => w.includes('Add lyrics'))).toBe(true)
  })

  it('makes one music-reactive visual per section for a visualizer', async () => {
    const p = await plan('visualizer', { videos: 0 })
    const shots = main(p)
    expectContiguous(shots, SONG_LENGTH)
    expect(shots).toHaveLength(SECTIONS.length)
    expect(shots.every((s) => s.source.type === 'generator')).toBe(true)
    const chorus = shots.find((s) => s.sectionId === 's-chorus1')!
    expect(chorus.reactive?.some((r) => r.source === 'beat')).toBe(true)
    expect(p.texts.find((t) => t.role === 'title')?.text).toBeTruthy()
  })

  it('layers the visualizer over the user images when there are some', async () => {
    const p = await plan('visualizer', { videos: 0, images: 2 })
    expect(main(p).every((s) => s.source.type === 'media' && s.motion)).toBe(true)
    const overlays = p.shots.filter((s) => s.layer === 'overlay')
    expect(overlays).toHaveLength(SECTIONS.length)
    expect(overlays.every((s) => s.blendMode === 'screen')).toBe(true)
  })

  it('falls back to an even grid with a warning when the song is not analyzed', async () => {
    const p = await plan('beat-cut', { analyzed: false })
    const shots = main(p)
    expectContiguous(shots, SONG_LENGTH)
    expect(p.warnings[0]).toMatch(/analysis isn't finished/)
    // 120 BPM fallback grid: every cut lands on a multiple of half a second.
    for (const s of shots) expect(Math.abs(s.start * 2 - Math.round(s.start * 2))).toBeLessThan(1e-6)
  })

  it('refuses to plan without a song', async () => {
    const error = await plan('beat-cut', { song: false }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).reason).toBe('no-song')
  })

  it('uses visuals and explains how to connect fal.ai when an AI video has no generation', async () => {
    const p = await plan('ai', { videos: 0 })
    expect(main(p).every((s) => s.source.type === 'generator')).toBe(true)
    expect(shotsToGenerate(p)).toHaveLength(0)
    expect(p.warnings.some((w) => w.includes('connect fal.ai in Settings'))).toBe(true)
  })

  it('plans generated shots, reuses them for the repeated chorus and prices them', async () => {
    const provider = fakeProvider()
    const generation = generationOptionsFor(provider, { mode: 'images', tier: 'draft' })!
    const p = await plan('ai', { videos: 0 }, { generation, prompt: 'neon city at night' })
    const shots = main(p)
    expectContiguous(shots, SONG_LENGTH)
    expect(shots.every((s) => s.source.type === 'generate' && s.motion)).toBe(true)
    expect(p.look?.id).toBe('neon')
    const chorus2 = shots.filter((s) => s.sectionId === 's-chorus2')
    const chorus1Ids = new Set(shots.filter((s) => s.sectionId === 's-chorus1').map((s) => s.id))
    expect(chorus2.length).toBeGreaterThan(0)
    for (const s of chorus2)
      expect(chorus1Ids.has(s.source.type === 'generate' ? (s.source.sameAs ?? '') : '')).toBe(true)
    for (const s of shotsToGenerate(p)) expect(s.source.prompt).toContain('neon-lit night')

    const cost = estimatePlanCost(p, provider)
    expect(cost.count).toBe(shotsToGenerate(p).length)
    // FLUX schnell at 1280x720 bills 1 MP at $0.003.
    expect(cost.usd).toBeCloseTo(0.003 * cost.count, 6)
  })

  it('caps generated shots at maxShots and reuses the rest', async () => {
    const provider = fakeProvider()
    const generation = generationOptionsFor(provider, { mode: 'video', tier: 'draft', maxShots: 3 })!
    const p = await plan('ai', { videos: 0 }, { generation })
    expect(shotsToGenerate(p)).toHaveLength(3)
    expect(p.warnings.some((w) => w.includes('Limited to 3'))).toBe(true)
    for (const s of main(p)) {
      expect(s.source.type).toBe('generate')
      // Video shots never exceed what one request can return.
      expect(s.end - s.start).toBeLessThanOrEqual(generation.maxVideoDuration + 1e-3)
    }
  })
})
