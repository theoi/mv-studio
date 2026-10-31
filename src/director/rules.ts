/**
 * Rule-based creative choices shared by the local planner and by expandBrief (to fill in anything an LLM brief
 * leaves out): moods, pacing, looks, prompts and text styling, derived from the song and the user's prompt.
 */
import type { LyricLine, LyricsDoc } from '../model/types.ts'
import { bestByTags, type CatalogItem, type DirectorCatalog, type LookPreset } from './catalog.ts'
import type { BriefSection, CreativeBrief } from './brief.ts'
import type { FootageMood, PlannerInput, SectionInfo, VideoKind } from './inputs.ts'
import type { Pace } from './plan.ts'
import { createRng } from './timing.ts'

const PACE_ORDER: Pace[] = ['very-slow', 'slow', 'medium', 'fast', 'very-fast']

export function slower(pace: Pace, steps = 1): Pace {
  return PACE_ORDER[Math.max(0, PACE_ORDER.indexOf(pace) - steps)] as Pace
}

export function faster(pace: Pace, steps = 1): Pace {
  return PACE_ORDER[Math.min(PACE_ORDER.length - 1, PACE_ORDER.indexOf(pace) + steps)] as Pace
}

/** Lowercase words and two-word phrases from a prompt, for tag matching. */
export function promptWords(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9&\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`)
  return [...words, ...pairs, ...words.slice(2).map((w, i) => `${words[i]} ${words[i + 1]} ${w}`)]
}

export function normalizedLabel(label: string): string {
  const l = label.toLowerCase()
  if (/chorus|hook|refrain|drop/.test(l)) return 'chorus'
  if (/pre[- ]?chorus|build/.test(l)) return 'pre-chorus'
  if (/verse/.test(l)) return 'verse'
  if (/bridge|break/.test(l)) return 'bridge'
  if (/intro/.test(l)) return 'intro'
  if (/outro|end|coda/.test(l)) return 'outro'
  return l
}

/** Chorus labels less sure than this (about 0.4 from the audio alone) need the energy to agree. */
export const SURE_LABEL = 0.6
/** Energy an unsure chorus label needs to be treated as a chorus. */
const UNSURE_CHORUS_ENERGY = 0.6

/**
 * A section's role from its label. A chorus label the analysis is unsure of, on a section no louder than the rest of
 * the song, is treated as a verse, so the video's biggest moments are not staked on a guess.
 */
export function roleOf(section: Pick<SectionInfo, 'label' | 'energy' | 'confidence'>): string {
  const label = normalizedLabel(section.label)
  const unsure = (section.confidence ?? 1) < SURE_LABEL && section.energy < UNSURE_CHORUS_ENERGY
  return label === 'chorus' && unsure ? 'verse' : label
}

/**
 * Beat-cut pace by a section's role. Energy alone can't tell verses from choruses: once normalized within a song
 * they often measure the same, and a stripped-back chorus can measure quieter than its verse.
 */
const ROLE_PACE: Record<string, Pace> = {
  intro: 'slow',
  verse: 'medium',
  'pre-chorus': 'medium',
  chorus: 'fast',
  bridge: 'slow',
  outro: 'slow',
}

export function moodFor(section: Pick<SectionInfo, 'label' | 'energy' | 'confidence'>): {
  mood: string
  tags: string[]
} {
  const label = roleOf(section)
  const e = section.energy
  if (label === 'chorus' || (e >= 0.8 && !(label in ROLE_PACE)))
    return { mood: 'euphoric, peak', tags: ['peak', 'energetic'] }
  if (label === 'pre-chorus') return { mood: 'rising, tense', tags: ['rising', 'energetic'] }
  if (label === 'intro')
    return { mood: e > 0.5 ? 'bold opening' : 'quiet, building', tags: ['calm', 'steady'] }
  if (label === 'outro') return { mood: 'fading, reflective', tags: ['calm', 'falling', 'soft'] }
  if (label === 'bridge') return { mood: 'reflective, open', tags: ['dreamy', 'soft', 'calm'] }
  if (e >= 0.6) return { mood: 'driving, confident', tags: ['driving', 'steady', 'energetic'] }
  if (e <= 0.3) return { mood: 'intimate, calm', tags: ['calm', 'soft'] }
  return { mood: 'steady, grounded', tags: ['steady'] }
}

const FOOTAGE_MOODS: [FootageMood, RegExp][] = [
  ['romantic', /love|romantic|tender|intimate/],
  ['dreamy', /dream|ethereal|hazy|float|open/],
  ['melancholic', /sad|melanchol|lonely|reflective|fading|nostalg|wistful/],
  ['dark', /dark|tense|moody|noir|ominous|menac/],
  ['epic', /epic|triumph|anthem|dramatic|cinematic/],
  ['energetic', /energetic|euphoric|peak|driving|rising|bold|hype|party|confident|punchy|fast/],
  ['bright', /bright|happy|joy|sunny|playful|uplift/],
  ['calm', /calm|quiet|gentle|soft|steady|grounded|building/],
]

/** The vision matcher's mood for a free-text section mood, falling back to the section's intensity. */
export function footageMood(mood: string, intensity: number): FootageMood | undefined {
  const text = mood.toLowerCase()
  const match = FOOTAGE_MOODS.find(([, pattern]) => pattern.test(text))
  if (match) return match[0]
  if (intensity >= 0.7) return 'energetic'
  if (intensity <= 0.3) return 'calm'
  return undefined
}

/**
 * Pace for a section: choruses cut fastest, verses a step slower, intros, bridges and outros slowest, and sections
 * with other names by their energy. Energy moves a role one step at most (a quiet chorus slows, a loud intro, bridge
 * or outro picks up). Then slower for lyric and AI videos, generated shots and fast tempos. `preferred` shifts every
 * section by the same number of steps from 'medium', so the contrast between sections stays.
 */
export function paceFor(
  kind: VideoKind,
  section: Pick<SectionInfo, 'label' | 'energy' | 'confidence'>,
  bpm: number,
  generated: boolean,
  preferred?: Pace,
): Pace {
  const label = roleOf(section)
  const e = section.energy
  let pace: Pace = ROLE_PACE[label] ?? (e >= 0.75 ? 'fast' : e >= 0.4 ? 'medium' : 'slow')
  if (label === 'chorus' && e < 0.4) pace = 'medium'
  if ((label === 'intro' || label === 'bridge' || label === 'outro') && e >= 0.75) pace = 'medium'
  if (bpm >= 150) pace = slower(pace)
  if (kind === 'lyric' || kind === 'ai') pace = slower(pace)
  if (generated) pace = slower(pace)
  if (preferred) {
    const shift = PACE_ORDER.indexOf(preferred) - PACE_ORDER.indexOf('medium')
    pace = shift >= 0 ? faster(pace, shift) : slower(pace, -shift)
  }
  return pace
}

/** Whether a section is a peak of the song: a chorus, or a loud section with no role. */
export function isPeak(section: Pick<SectionInfo, 'label' | 'energy' | 'confidence'>): boolean {
  const label = roleOf(section)
  return label === 'chorus' ? section.energy >= 0.4 : !(label in ROLE_PACE) && section.energy >= 0.75
}

const KIND_LOOK: Record<VideoKind, string> = {
  lyric: 'clean',
  visualizer: 'vivid',
  'beat-cut': 'vivid',
  ai: 'cinematic',
}

/** The look whose tags best match the prompt, else the default for the video kind. */
export function pickLook(prompt: string, kind: VideoKind, catalog: DirectorCatalog): LookPreset | undefined {
  const matched = bestByTags(catalog.looks, promptWords(prompt))
  return matched ?? catalog.looks.find((l) => l.id === KIND_LOOK[kind]) ?? catalog.looks[0]
}

const TIER_TAGS = {
  peak: ['peak', 'energetic', 'punchy'],
  mid: ['driving', 'steady'],
  calm: ['calm', 'soft', 'falling'],
}

export type SectionTier = keyof typeof TIER_TAGS

/** Peaks, quiet parts (intro, bridge, outro, quiet sections) and everything in between. */
export function sectionTier(section: Pick<SectionInfo, 'label' | 'energy' | 'confidence'>): SectionTier {
  if (isPeak(section)) return 'peak'
  const label = roleOf(section)
  const quiet = label === 'intro' || label === 'bridge' || label === 'outro' || section.energy < 0.4
  return quiet ? 'calm' : 'mid'
}

export const PARTICLES_ID = 'visualizer.particles'
const isScene = (g: CatalogItem) => g.id.startsWith('generator.')
const LYRIC_SCENE_TAGS = ['calm', 'soft', 'dreamy', 'ambient', 'background']

/** Full-frame scenes (`generator.*`) to lay visualizers or lyrics over; lyric videos use only the calm ones. */
export function scenePool(input: Pick<PlannerInput, 'catalog' | 'kind'>): CatalogItem[] {
  const scenes = input.catalog.generators.filter(isScene)
  if (input.kind !== 'lyric') return scenes
  const calm = scenes.filter((g) => g.tags.some((t) => LYRIC_SCENE_TAGS.includes(t)))
  return calm.length ? calm : scenes
}

/** Visualizers drawn over a scene or footage (`visualizer.*`). Particles are kept for choruses. */
export function overlayPool(input: Pick<PlannerInput, 'catalog'>): CatalogItem[] {
  return input.catalog.generators.filter((g) => !isScene(g) && g.id !== PARTICLES_ID)
}

/**
 * One visual per kind of section, kept for the whole video: peaks, verses and quiet parts (intro, bridge,
 * outro) each get their own, so the visuals change with the song and stay consistent. Prompt words (space,
 * synthwave...) count double; the seed breaks ties, so "Try another version" varies them. Picks from `pool` when it
 * has anything, else from every generator.
 */
export function visualizerPalette(
  sections: SectionInfo[],
  input: PlannerInput,
  pool: CatalogItem[] = input.catalog.generators,
): Map<string, string> {
  const generators = pool.length ? pool : input.catalog.generators
  const words = promptWords(input.prompt)
  const rng = createRng(input.seed)
  const used = new Set<string>()
  const pick = (tags: string[]) => {
    let best: string | undefined
    let bestScore = -Infinity
    for (const g of generators) {
      const score =
        tags.filter((t) => g.tags.includes(t)).length +
        2 * words.filter((w) => g.tags.includes(w)).length -
        (used.has(g.id) ? 10 : 0) +
        rng() * 0.9
      if (score > bestScore) {
        best = g.id
        bestScore = score
      }
    }
    if (best) used.add(best)
    return best
  }
  const peak = pick(TIER_TAGS.peak)
  const mid = pick(TIER_TAGS.mid)
  const calm = pick(TIER_TAGS.calm)
  const out = new Map<string, string>()
  const byTier: Record<SectionTier, string | undefined> = { peak, mid, calm }
  for (const s of sections) {
    const id = byTier[sectionTier(s)]
    if (id) out.set(s.id, id)
  }
  return out
}

export function linesIn(lyrics: LyricsDoc | undefined, start: number, end: number): LyricLine[] {
  if (!lyrics) return []
  return lyrics.lines.filter((l) => {
    const s = l.start ?? l.words[0]?.start
    return s !== undefined && s >= start - 0.05 && s < end
  })
}

export function defaultVisual(input: PlannerInput): CreativeBrief['visual'] {
  const hasVideo = input.useMedia && input.media.some((m) => m.kind === 'video')
  const hasImages = input.useMedia && input.media.some((m) => m.kind === 'image')
  switch (input.kind) {
    case 'visualizer':
      return 'visualizer'
    case 'ai':
      return 'generated'
    case 'beat-cut':
      return hasVideo ? 'footage' : hasImages ? 'stills' : input.generation ? 'generated' : 'visualizer'
    case 'lyric':
      return hasVideo ? 'footage' : hasImages ? 'stills' : input.generation ? 'generated' : 'visualizer'
  }
}

const CAMERA_HINTS = [
  'wide establishing shot',
  'medium shot',
  'close-up detail',
  'slow tracking shot',
  'aerial view',
  'low-angle shot',
]

/** Generation prompts for one section: the concept, the section's mood, a lyric hint, and the shared style. */
export function sectionPrompts(o: {
  concept: string
  mood: string
  lyrics: LyricLine[]
  count: number
  offset: number
}): string[] {
  const lyric = o.lyrics.map((l) => l.text).find((t) => t.trim().length > 3)
  const prompts: string[] = []
  for (let i = 0; i < Math.max(1, o.count); i++) {
    const camera = CAMERA_HINTS[(o.offset + i) % CAMERA_HINTS.length]
    const parts = [o.concept, `${camera}, ${o.mood} mood`]
    if (lyric) parts.push(`evoking the line "${lyric.slice(0, 120)}"`)
    prompts.push(parts.join('. '))
  }
  return prompts
}

export const DEFAULT_CONCEPT: Record<VideoKind, string> = {
  lyric: 'Atmospheric abstract backdrop for a lyric video',
  visualizer: 'Abstract music visualizer',
  'beat-cut': 'Energetic montage',
  ai: 'Cinematic music video with a consistent main character and setting',
}

/** A rule-based brief section, used by the local planner and to fill gaps in an LLM brief. */
export function defaultSectionBrief(
  section: SectionInfo,
  input: PlannerInput,
  bpm: number,
  generated: boolean,
): BriefSection {
  const { mood, tags } = moodFor(section)
  const intensity = section.energy
  const catalog = input.catalog
  const label = roleOf(section)
  const effects: string[] = []
  if (isPeak(section)) {
    const glow =
      catalog.effects.find((e) => e.id === 'glow') ?? bestByTags(catalog.effects, ['peak', 'energetic'])
    if (glow) effects.push(glow.id)
  }
  return {
    sectionId: section.id,
    mood,
    intensity,
    pace: paceFor(input.kind, section, bpm, generated, input.pace),
    effects,
    reactive: intensity >= 0.6 ? Math.min(1, 0.3 + intensity * 0.6) : 0,
    mediaQuery: [input.prompt, mood].filter(Boolean).join(', '),
    generatorId: bestByTags(catalog.generators, tags)?.id ?? catalog.generators[0]?.id,
    motion: label === 'outro' ? 'pull-out' : undefined,
  }
}
