import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  DirectorError,
  estimatePlanCost,
  expandBrief,
  generationOptionsFor,
  planLocally,
  ruleBrief,
  shotsToGenerate,
  type EditPlan,
  type LookPreset,
  type PlanShot,
  PACES,
} from '../../../src/director/index.ts'
import { ideaAsks, visualIdea } from '../../../src/director/rules.ts'
import { CLIPS, fakeMatcher, makeProject as visionProject } from '../vision/autocut/fixtures.ts'
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
    // Sections start on a bar here, so the cut rhythm starts with them: equal shots, only the last may be shorter,
    // except in the last bar (2 s) before a faster section, which speeds up into it.
    for (const section of SECTIONS) {
      const lengths = shots
        .filter((s) => s.sectionId === section.id && s.start < section.end - 2)
        .map((s) => s.end - s.start)
      for (const length of lengths.slice(0, -1)) expect(length).toBeCloseTo(lengths[0]!, 3)
    }
    const verseEnd = verse.filter((s) => s.start >= 22)
    expect(verseEnd.length).toBeGreaterThan(1)
    for (const s of verseEnd) expect(s.end - s.start).toBeLessThan(verse[0]!.end - verse[0]!.start)
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

  it('chooses clips with the footage matcher for the line sung, the prompt and the brief', async () => {
    const asset = (s: PlanShot) => (s.source.type === 'media' ? s.source.assetId : undefined)
    // Without the fixture's topic-less clip, which the fake encoder makes match every mood prompt.
    const project = () => visionProject({ clips: CLIPS.filter((c) => c.topic) })
    const draft = async (prompt = '') =>
      planLocally(
        await buildPlannerInput(project(), { kind: 'beat-cut', seed: 7, prompt, footage: fakeMatcher() }),
      )
    const p = await draft()
    const at = (plan: EditPlan, t: number) => main(plan).find((s) => s.start >= t - 1e-3)!
    // "neon city lights at night", "waves on the ocean shore", "everybody dance with the crowd"
    expect(asset(at(p, 9.6))).toBe('city')
    expect(asset(at(p, 14.4))).toBe('ocean')
    expect(asset(at(p, 28.8))).toBe('crowd')
    expect(p.warnings).toEqual([])
    // No line is sung in the intro, so the prompt decides.
    expect(asset(at(await draft('ocean at dawn'), 0))).toBe('ocean')

    const input = await buildPlannerInput(project(), { kind: 'beat-cut', seed: 7, footage: fakeMatcher() })
    const brief = ruleBrief(input)
    const preferring = {
      ...brief,
      sections: brief.sections.map((s) => (s.sectionId === 'chorus' ? { ...s, assetIds: ['ocean'] } : s)),
    }
    const ocean = (plan: EditPlan) =>
      main(plan).filter((s) => s.sectionId === 'chorus' && asset(s) === 'ocean').length
    const preferred = await expandBrief(preferring, input, { planner: 'llm' })
    const plain = await expandBrief(brief, input, { planner: 'llm' })
    expect(ocean(preferred)).toBeGreaterThan(ocean(plain))
    const chorus = main(preferred).filter((s) => s.sectionId === 'chorus')
    for (let i = 1; i < chorus.length; i++) expect(asset(chorus[i]!)).not.toBe(asset(chorus[i - 1]!))
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
    expect(p.texts.filter((t) => t.role !== 'title')).toEqual([])
    expect(p.warnings.some((w) => w.includes('Add lyrics'))).toBe(true)
  })

  it('layers a scene, a visualizer and chorus particles per section, reacting harder in loud parts', async () => {
    const p = await plan('visualizer', { videos: 0 })
    const shots = main(p)
    expectContiguous(shots, SONG_LENGTH)
    expect(shots).toHaveLength(SECTIONS.length)
    const generator = (s: PlanShot) => (s.source.type === 'generator' ? s.source : undefined)
    // Scenes underneath, drifting in and out.
    expect(shots.every((s) => generator(s)?.generatorId.startsWith('generator.'))).toBe(true)
    expect(shots.every((s) => s.motion === 'push-in' || s.motion === 'pull-out')).toBe(true)
    const reactivity = (id: string) => generator(shots.find((s) => s.sectionId === id)!)?.params?.reactivity
    expect(reactivity('s-chorus1')).toBeGreaterThan(reactivity('s-verse') as number)
    expect(reactivity('s-verse')).toBeGreaterThan(reactivity('s-intro') as number)
    // A visualizer over every scene, pulsing with the kick in the chorus.
    const overlays = p.shots.filter((s) => s.layer === 'overlay')
    expect(overlays).toHaveLength(SECTIONS.length)
    expect(overlays.every((s) => generator(s)?.generatorId.startsWith('visualizer.'))).toBe(true)
    const chorus = overlays.find((s) => s.sectionId === 's-chorus1')!
    expect(chorus.reactions).toEqual([{ reaction: 'kick', target: { property: 'scale' }, amount: 0.3 }])
    expect(overlays.find((s) => s.sectionId === 's-intro')!.reactions).toBeUndefined()
    // Sections of different kinds look different.
    const ids = (sectionId: string) =>
      p.shots
        .filter((s) => s.sectionId === sectionId)
        .map(generator)
        .map((g) => g?.generatorId)
    expect(ids('s-chorus1')).not.toEqual(ids('s-verse'))
    expect(ids('s-chorus2')).toEqual(ids('s-chorus1'))
    // Particles only on the choruses.
    const accents = p.shots.filter((s) => s.layer === 'accent')
    expect(accents.map((s) => s.sectionId)).toEqual(['s-chorus1', 's-chorus2'])
    expect(accents.every((s) => generator(s)?.generatorId === 'visualizer.particles')).toBe(true)
    expect(p.texts.find((t) => t.role === 'title')?.text).toBeTruthy()
  })

  it('treats a chorus label guessed from the audio as a verse unless the energy agrees', async () => {
    const particlesOn = async (confidence: number) => {
      const project = makeProject({ videos: 0 })
      // The first chorus is no louder than the verse; the second is the loudest part of the song.
      project.analysis.audio.song!.sections = SECTIONS.map((s) => ({
        ...s,
        confidence,
        ...(s.id === 's-chorus1' ? { energy: 0.45 } : {}),
      }))
      const p = await planLocally(await buildPlannerInput(project, { kind: 'visualizer', seed: 7 }))
      return p.shots.filter((s) => s.layer === 'accent').map((s) => s.sectionId)
    }
    expect(await particlesOn(0.4)).toEqual(['s-chorus2'])
    expect(await particlesOn(0.8)).toEqual(['s-chorus1', 's-chorus2'])
  })

  it('rests the visualizer every other 16-bar phrase of a long section, over one unbroken scene', async () => {
    const project = makeProject({ videos: 0 })
    // A 30-bar verse (2 s bars).
    project.analysis.audio.song!.sections = [
      { id: 's-intro', label: 'intro', start: 0, end: 4, energy: 0.2 },
      { id: 's-verse', label: 'verse', start: 4, end: 64, energy: 0.6 },
    ]
    const p = await planLocally(await buildPlannerInput(project, { kind: 'visualizer', seed: 7 }))
    const inVerse = (layer: string) => p.shots.filter((s) => s.layer === layer && s.sectionId === 's-verse')
    expect(inVerse('main').map((s) => [s.start, s.end])).toEqual([[4, 64]])
    expect(inVerse('overlay').map((s) => [s.start, s.end])).toEqual([[4, 36]])
    expect(p.shots.filter((s) => s.layer === 'overlay' && s.sectionId === 's-intro')).toHaveLength(1)
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
    expect(p.warnings[0]).toMatch(/analysis isn’t finished/)
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

  it('sends the picture the idea describes to the image model, not what it asks of the edit', async () => {
    const generation = generationOptionsFor(fakeProvider(), { mode: 'images', tier: 'draft' })!
    const idea = 'Summer day outdoors: ocean waves, bees in lavender, a city at night. Use my own clips.'
    const shots = shotsToGenerate(await plan('ai', { videos: 0 }, { generation, prompt: idea }))
    expect(shots.length).toBeGreaterThan(0)
    for (const s of shots) {
      expect(s.source.prompt).toMatch(
        /^Summer day outdoors: ocean waves, bees in lavender, a city at night\. \w/,
      )
      expect(s.source.prompt).not.toMatch(/clips/i)
    }
    // With nothing visual left, the prompts describe the kind of video instead.
    const bare = shotsToGenerate(await plan('ai', { videos: 0 }, { generation, prompt: 'Use my own clips.' }))
    expect(bare.length).toBeGreaterThan(0)
    for (const s of bare)
      expect(s.source.prompt).toMatch(/^Cinematic music video with a consistent main character/)
  })

  it('leaves what an LLM concept asks of the edit out of the prompts filled in from it', async () => {
    const generation = generationOptionsFor(fakeProvider(), { mode: 'images', tier: 'draft' })!
    const input = await buildPlannerInput(makeProject({ videos: 0 }), { kind: 'ai', seed: 1, generation })
    const concept = 'A runner crosses a neon city at night. Use the user’s own clips, cut on the beat.'
    const p = await expandBrief({ title: 'Test', concept, visual: 'generated', sections: [] }, input, {
      planner: 'llm',
    })
    const shots = shotsToGenerate(p)
    expect(shots.length).toBeGreaterThan(0)
    for (const s of shots) {
      expect(s.source.prompt).toMatch(/^A runner crosses a neon city at night\. \w/)
      expect(s.source.prompt).not.toMatch(/clips|beat/i)
    }
  })

  it('titles and describes a rule brief by the picture in the idea, in any script', async () => {
    const input = await buildPlannerInput(makeProject({ videos: 0 }), {
      kind: 'ai',
      seed: 1,
      prompt: 'Use my own clips. 東京の夜、ネオンの雨',
    })
    // An LLM brief without a title takes this one, and it can reach the title card.
    expect(ruleBrief(input)).toMatchObject({ title: '東京の夜、ネオンの雨', concept: '東京の夜、ネオンの雨' })
  })

  it.each([
    [
      'Summer day outdoors: ocean waves, skaters at night, bees in lavender, a city at night. Use my own clips.',
      'Summer day outdoors: ocean waves, skaters at night, bees in lavender, a city at night',
    ],
    [
      'Make a music video about a girl skating through Tokyo. Cut on the beat and show the lyrics.',
      'a girl skating through Tokyo',
    ],
    [
      'Waves crashing on black rocks with my own clips, fast cuts in the chorus',
      'Waves crashing on black rocks',
    ],
    ['Fireworks over the harbour in the chorus; vertical 9:16 for TikTok', 'Fireworks over the harbour'],
    ['Dancers moving to the beat in a warehouse. Make it 30 seconds long.', 'Dancers moving in a warehouse'],
    ['Use my footage. No AI.', ''],
    [
      'A neon city at night, use stock footage, quick edits, keep it under 2 minutes, for TikTok',
      'A neon city at night',
    ],
    ['Sunset over the sea. Make a 30-second video for Instagram, no AI images.', 'Sunset over the sea'],
    ['Sync it to the music. Smooth transitions. A desert road.', 'A desert road'],
    ['A rooftop at dawn. Show the lyrics on screen.', 'A rooftop at dawn'],
    ['Create images of a lighthouse in a storm', 'a lighthouse in a storm'],
    ['Faster in the chorus, a city at night', 'a city at night'],
    ['東京の夜。ネオンの雨。Use my own clips.', '東京の夜。ネオンの雨'],
  ])('takes the picture out of the idea %j', (idea, picture) => {
    expect(visualIdea(idea)).toBe(picture)
  })

  it.each([
    '東京の夜、ネオンの雨',
    'Ночной Токио, неоновый дождь',
    '서울의 밤거리, 네온 불빛',
    'Νύχτα στην Αθήνα, βροχή',
    'A lonely AI android walking through a rainy city',
    'A YouTube star dancing in her bedroom',
    'An Instagram influencer on a beach at sunset',
    'Use a vintage film look with heavy grain',
    'Use warm colors, neon and rain',
    'A woman editing photos in a darkroom',
    'Kids making paper cuts at a kitchen table',
    'A man waiting 10 minutes for a train in the snow',
    'A boxer with a cut on his cheek, a tailor cutting with scissors',
    'A singer scribbling lyrics on a napkin',
    'Make it 3D animated, a robot city',
    'A choir singing in the chorus of a cathedral',
    'Dancers on the beat of the drum',
    'A 1990s mall, freshly cut grass outside, a bridge over the river',
  ])('keeps an idea that only describes pictures as it is: %j', (idea) => {
    expect(visualIdea(idea)).toBe(idea)
  })
})

describe('looks', () => {
  const look: LookPreset = {
    id: 'test-look',
    name: 'Test look',
    tags: ['test'],
    adjustments: { contrast: 0.1 },
    effects: [],
    textColor: '#fafafa',
    accentColor: '#ff00ff',
    promptStyle: 'test style',
    palette: { primary: '#112233', secondary: '#445566' },
    text: {
      style: { fontWeight: 500, letterSpacing: 0.05, textTransform: 'uppercase' },
      animation: { presetId: 'typewriter' },
    },
  }

  it('colors visualizers with the look palette and styles text with its typography', async () => {
    const input = await buildPlannerInput(makeProject({ videos: 0 }), { kind: 'visualizer', seed: 1 })
    const p = await expandBrief(
      {
        title: 'Test',
        concept: 'A test.',
        lookId: look.id,
        visual: 'visualizer',
        text: { show: true },
        sections: SECTIONS.map((s) => ({
          sectionId: s.id,
          mood: 'calm',
          intensity: 0.4,
          pace: 'slow' as const,
          generatorId: 'visualizer.spectrum',
        })),
      },
      { ...input, catalog: { ...input.catalog, looks: [look] } },
      { planner: 'llm' },
    )
    expect(p.look?.name).toBe('Test look')
    const visuals = main(p)
    expect(visuals).toHaveLength(SECTIONS.length)
    for (const s of visuals) {
      expect(s.source).toMatchObject({ type: 'generator', params: { color: '#112233', color2: '#445566' } })
    }
    const lyrics = p.texts.filter((t) => t.role === 'lyric')
    expect(lyrics).toHaveLength(LYRICS.length)
    for (const t of lyrics) {
      expect(t.animationPresetId).toBe('typewriter')
      expect(t.style).toMatchObject({
        fontWeight: 500,
        letterSpacing: 0.05,
        uppercase: true,
        color: '#fafafa',
      })
    }
    const title = p.texts.find((t) => t.role === 'title')!
    expect(title.style.letterSpacing).toBeLessThan(0.5)
  })
})

describe('pace and brightness words in the idea', () => {
  const none = { pace: 0, light: 0, words: [] }
  const fast = { pace: 1, light: 0, words: ['fast'] }
  it.each([
    ['fast and bright in the chorus', { chorus: { pace: 1, light: 1, words: ['fast', 'bright'] } }, none],
    [
      'slow verses and fast choruses',
      { verse: { pace: -1, light: 0, words: ['slow'] }, chorus: { pace: 1, light: 0, words: ['fast'] } },
      none,
    ],
    [
      'slow verse fast chorus',
      { verse: { pace: -1, light: 0, words: ['slow'] }, chorus: { pace: 1, light: 0, words: ['fast'] } },
      none,
    ],
    [
      'punchy in the pre chorus but calm in the bridge',
      {
        'pre-chorus': { pace: 1, light: 0, words: ['punchy'] },
        bridge: { pace: -1, light: 0, words: ['calm'] },
      },
      none,
    ],
    ['Very fast in the drop', { chorus: { pace: 2, light: 0, words: ['fast'] } }, none],
    ['A dark, very slow video', {}, { pace: -2, light: -1, words: ['dark', 'slow'] }],
    ['Not too fast in the chorus, less dark', {}, none],
    ['a dreamy night drive through a neon city, ending at sunrise', {}, none],
    // Each section named after "in the" ends its part, and "and" between parts starts the next one.
    [
      'fast in the chorus and slow in the verses',
      { chorus: { pace: 1, light: 0, words: ['fast'] }, verse: { pace: -1, light: 0, words: ['slow'] } },
      none,
    ],
    [
      'bright in the chorus and dark in the bridge',
      { chorus: { pace: 0, light: 1, words: ['bright'] }, bridge: { pace: 0, light: -1, words: ['dark'] } },
      none,
    ],
    [
      'keep the chorus fast and the verses slow',
      { chorus: { pace: 1, light: 0, words: ['fast'] }, verse: { pace: -1, light: 0, words: ['slow'] } },
      none,
    ],
    [
      'fast in the chorus with slower cuts in the verses',
      { chorus: { pace: 1, light: 0, words: ['fast'] }, verse: { pace: -1, light: 0, words: ['slower'] } },
      none,
    ],
    ['In the chorus, fast and bright', { chorus: { pace: 1, light: 1, words: ['fast', 'bright'] } }, none],
    [
      'fast and very bright in the chorus',
      { chorus: { pace: 1, light: 1, words: ['fast', 'bright'] } },
      none,
    ],
    // A comma or "and" between two descriptions keeps them together.
    ['a fast, bright chorus', { chorus: { pace: 1, light: 1, words: ['fast', 'bright'] } }, none],
    ['fast, punchy cuts in the chorus', { chorus: { pace: 1, light: 0, words: ['fast', 'punchy'] } }, none],
    [
      'a slow build to a fast drop',
      {
        'pre-chorus': { pace: -1, light: 0, words: ['slow'] },
        chorus: { pace: 1, light: 0, words: ['fast'] },
      },
      none,
    ],
    ['a fast-paced video', {}, { pace: 1, light: 0, words: ['fast-paced'] }],
    // Negated, or contradicting itself: left out rather than turned around.
    ["don't make it too fast", {}, none],
    ['don’t make the chorus fast', {}, none],
    ['nothing too fast', {}, none],
    ['avoid anything slow', {}, none],
    ['not so very fast', {}, none],
    ['the verses are too slow', {}, none],
    ['fast and slow in the chorus', {}, none],
    ['fast in the chorus but not in the verses', { chorus: { pace: 1, light: 0, words: ['fast'] } }, none],
    // "but" starts a new part, so the negation after it leaves the words before it alone.
    ['a fast chorus but not too bright', { chorus: { pace: 1, light: 0, words: ['fast'] } }, none],
    // A list of descriptions stays open for its section, even through a word the lists don't know.
    ['slow, dreamy verses', { verse: { pace: -1, light: 0, words: ['slow'] } }, none],
    ['slow and dreamy verses', { verse: { pace: -1, light: 0, words: ['slow'] } }, none],
    ['slow, dreamy, hazy verses', { verse: { pace: -1, light: 0, words: ['slow'] } }, none],
    [
      'slow, dreamy verses and a fast, punchy chorus',
      {
        verse: { pace: -1, light: 0, words: ['slow'] },
        chorus: { pace: 1, light: 0, words: ['fast', 'punchy'] },
      },
      none,
    ],
    [
      'fast and bright, verses slow',
      { verse: { pace: -1, light: 0, words: ['slow'] } },
      { pace: 1, light: 1, words: ['fast', 'bright'] },
    ],
    ['fast video, slow chorus', { chorus: { pace: -1, light: 0, words: ['slow'] } }, fast],
    // A part after "but" with words of its own is about its section, not an exception.
    ['fast cuts but keep the bridge slow', { bridge: { pace: -1, light: 0, words: ['slow'] } }, fast],
  ])('reads “%s”', (idea, roles, all) => {
    const asks = ideaAsks(idea)
    expect(Object.fromEntries(asks.roles)).toEqual(roles)
    expect(asks.all).toEqual(all)
    expect(asks.excepted).toEqual(new Map())
  })

  it.each([
    ['everything fast apart from the bridge', {}, { bridge: none }],
    ['fast cuts other than in the bridge', {}, { bridge: none }],
    ['fast everywhere except the bridge', {}, { bridge: none }],
    ['fast all the way through, aside from the intro', {}, { intro: none }],
    ['fast cuts, but not in the verses', {}, { verse: none }],
    ['fast cuts but not during the bridge', {}, { bridge: none }],
    ['fast everywhere except the bridge and the outro', {}, { bridge: none, outro: none }],
    // "but" naming only sections means "except".
    ['fast everywhere but the bridge', {}, { bridge: none }],
    ['everything fast but the chorus', {}, { chorus: none }],
    ['fast cuts, but the bridge is different', {}, { bridge: none }],
    // The part after a section left out goes to the whole video, unless it starts with "which" or the like.
    ['Apart from the bridge, fast cuts', {}, { bridge: none }],
    [
      'fast everywhere except the bridge, which should be slow',
      { bridge: { pace: -1, light: 0, words: ['slow'] } },
      { bridge: none },
    ],
  ])('leaves the sections “%s” excepts out of the whole video’s words', (idea, roles, excepted) => {
    const asks = ideaAsks(idea)
    expect(asks.all).toEqual(fast)
    expect(Object.fromEntries(asks.roles)).toEqual(roles)
    expect(Object.fromEntries(asks.excepted)).toEqual(excepted)
  })

  it('leaves a section out of only the whole-video words of the sentences that except it', () => {
    expect(Object.fromEntries(ideaAsks('bright throughout, except for the verses').excepted)).toEqual({
      verse: none,
    })
    expect(Object.fromEntries(ideaAsks('fast cuts and dark colours, except the bridge').excepted)).toEqual({
      bridge: none,
    })
    // A sentence with no whole-video words of its own excepts from the whole idea.
    expect(Object.fromEntries(ideaAsks('Fast cuts. Don’t touch the bridge.').excepted)).toEqual({
      bridge: none,
    })
    const asks = ideaAsks('A dark video. Fast everywhere except the bridge.')
    expect(asks.all).toEqual({ pace: 1, light: -1, words: ['dark', 'fast'] })
    expect(Object.fromEntries(asks.excepted)).toEqual({ bridge: { pace: 0, light: -1, words: ['dark'] } })
  })

  /** An AI video of the user's clips whose first chorus is a guess no louder than the verse, as on many songs. */
  async function guessedChorus(prompt: string) {
    const project = makeProject()
    project.analysis.audio.song!.sections = SECTIONS.map((s) => ({
      ...s,
      confidence: 0.4,
      ...(s.id === 's-chorus1' ? { energy: 0.45 } : {}),
    }))
    const input = await buildPlannerInput(project, { kind: 'ai', seed: 7, prompt })
    const p = await planLocally(input)
    const section = (id: string) => p.sections.find((s) => s.id === id)!
    const shots = (id: string) => main(p).filter((s) => s.sectionId === id)
    const brief = (id: string) => ruleBrief(input).sections.find((s) => s.sectionId === id)!
    return { p, section, shots, brief }
  }

  it('makes the chorus the idea calls fast and bright faster and brighter, guessed or not', async () => {
    const plain = await guessedChorus('neon city')
    const asked = await guessedChorus('neon city, fast and bright in the chorus')
    expect(plain.section('s-chorus1').mood).toBe('steady, grounded')
    expect(asked.section('s-chorus1').mood).toBe('fast, bright')
    expect(PACES.indexOf(asked.section('s-chorus1').pace)).toBe(
      PACES.indexOf(plain.section('s-chorus1').pace) + 1,
    )
    expect(meanLength(asked.shots('s-chorus1'))).toBeLessThan(meanLength(plain.shots('s-chorus1')))
    // It reacts to the music as a loud section does.
    expect(plain.brief('s-chorus1').reactive).toBe(0)
    expect(asked.brief('s-chorus1').intensity).toBe(0.75)
    expect(asked.brief('s-chorus1').reactive).toBeGreaterThan(0)
    const glows = (shots: PlanShot[]) => shots.filter((s) => s.effects?.some((e) => e.effectId === 'glow'))
    expect(glows(plain.shots('s-chorus1'))).toEqual([])
    expect(glows(asked.shots('s-chorus1')).length).toBeGreaterThan(0)
    // The rest of the song is as before.
    for (const id of ['s-intro', 's-verse', 's-bridge', 's-outro'])
      expect(asked.section(id)).toEqual(plain.section(id))
  })

  it('keeps the whole video’s brightness in front of a section’s own words without one', async () => {
    const { section } = await guessedChorus('a dark video, fast chorus')
    expect(section('s-chorus1').mood).toBe('dark, fast')
    expect(section('s-verse').mood).toBe('dark, steady, grounded')
    const bright = await guessedChorus('a dark video, bright chorus')
    expect(bright.section('s-chorus1').mood).toBe('bright')
  })

  it('leaves the pre-chorus out of what the idea asks of the chorus', async () => {
    const project = makeProject()
    project.analysis.audio.song!.sections = SECTIONS.map((s) =>
      s.id === 's-bridge' ? { ...s, label: 'Pre-chorus', energy: 0.7 } : s,
    )
    const p = await planLocally(
      await buildPlannerInput(project, { kind: 'beat-cut', seed: 7, prompt: 'fast in the chorus' }),
    )
    expect(p.sections.find((s) => s.id === 's-chorus2')?.mood).toBe('fast')
    expect(p.sections.find((s) => s.id === 's-bridge')?.mood).toBe('rising, tense')
  })

  it('slows every section a step for a slow idea and leads every mood with “dark”', async () => {
    const plain = await guessedChorus('neon city')
    const asked = await guessedChorus('a slow, dark neon city')
    expect(asked.p.sections).toHaveLength(SECTIONS.length)
    for (const s of asked.p.sections) {
      const before = plain.section(s.id)
      expect(PACES.indexOf(s.pace)).toBe(Math.max(0, PACES.indexOf(before.pace) - 1))
      expect(s.mood).toBe(`dark, ${before.mood}`)
    }
  })

  it('gives a section its own pace in place of the whole video’s, and an excepted section none of it', async () => {
    const plain = await guessedChorus('neon city')
    const paces = (p: { p: { sections: { id: string; pace: string }[] } }) =>
      Object.fromEntries(p.p.sections.map((s) => [s.id, s.pace]))
    /** The plain draft's paces moved by the given steps (every other section by `rest`). */
    const moved = (rest: number, steps: Record<string, number>) =>
      Object.fromEntries(
        plain.p.sections.map((s) => {
          const i = PACES.indexOf(s.pace) + (steps[s.id] ?? rest)
          return [s.id, PACES[Math.max(0, Math.min(PACES.length - 1, i))]]
        }),
      )
    expect(paces(await guessedChorus('fast video, slow chorus'))).toEqual(
      moved(1, { 's-chorus1': -1, 's-chorus2': -1 }),
    )
    expect(paces(await guessedChorus('fast video, very fast chorus'))).toEqual(
      moved(1, { 's-chorus1': 2, 's-chorus2': 2 }),
    )
    expect(paces(await guessedChorus('fast in the chorus, slow elsewhere'))).toEqual(
      moved(-1, { 's-chorus1': 1, 's-chorus2': 1 }),
    )
    expect(paces(await guessedChorus('everything fast apart from the bridge'))).toEqual(
      moved(1, { 's-bridge': 0 }),
    )
    expect(paces(await guessedChorus('fast everywhere except the bridge, which should be slow'))).toEqual(
      moved(1, { 's-bridge': -1 }),
    )
    const bright = await guessedChorus('bright throughout, except for the verses')
    expect(bright.section('s-verse').mood).toBe(plain.section('s-verse').mood)
    expect(bright.section('s-intro').mood).toBe(`bright, ${plain.section('s-intro').mood}`)
  })
})
