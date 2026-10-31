/**
 * Rule-based creative choices shared by the local planner and by expandBrief (to fill in anything an LLM brief
 * leaves out): moods, pacing, looks, prompts and text styling, derived from the song and the user's prompt.
 */
import type { LyricLine, LyricsDoc } from '../model/types.ts'
import { bestByTags, type DirectorCatalog, type LookPreset } from './catalog.ts'
import type { BriefSection, CreativeBrief } from './brief.ts'
import type { FootageMood, PlannerInput, SectionInfo, VideoKind } from './inputs.ts'
import type { Pace } from './plan.ts'

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

export function moodFor(section: SectionInfo): { mood: string; tags: string[] } {
  const label = normalizedLabel(section.label)
  const e = section.energy
  if (label === 'chorus' || e >= 0.8) return { mood: 'euphoric, peak', tags: ['peak', 'energetic'] }
  if (label === 'pre-chorus') return { mood: 'rising, tense', tags: ['rising', 'energetic'] }
  if (label === 'intro')
    return { mood: e > 0.5 ? 'bold opening' : 'quiet, building', tags: ['calm', 'steady'] }
  if (label === 'outro') return { mood: 'fading, reflective', tags: ['calm', 'falling', 'soft'] }
  if (label === 'bridge') return { mood: 'reflective, open', tags: ['dreamy', 'soft', 'calm'] }
  if (e >= 0.6) return { mood: 'driving, confident', tags: ['energetic', 'steady'] }
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

/** Pace for a section: busier with more energy, adjusted for the video kind and tempo. */
export function paceFor(kind: VideoKind, energy: number, bpm: number, generated: boolean): Pace {
  let pace: Pace = energy >= 0.75 ? 'fast' : energy >= 0.45 ? 'medium' : 'slow'
  if (energy >= 0.9 && bpm < 110) pace = 'very-fast'
  if (bpm >= 150) pace = slower(pace)
  if (kind === 'lyric') pace = slower(pace)
  if (kind === 'ai' || generated) pace = slower(pace, 2)
  return pace
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
  const label = normalizedLabel(section.label)
  const effects: string[] = []
  if (intensity >= 0.75) {
    const glow =
      catalog.effects.find((e) => e.id === 'glow') ?? bestByTags(catalog.effects, ['peak', 'energetic'])
    if (glow) effects.push(glow.id)
  }
  return {
    sectionId: section.id,
    mood,
    intensity,
    pace: input.pace ?? paceFor(input.kind, intensity, bpm, generated),
    effects,
    reactive: intensity >= 0.6 ? Math.min(1, 0.3 + intensity * 0.6) : 0,
    mediaQuery: [input.prompt, mood].filter(Boolean).join(', '),
    generatorId: bestByTags(catalog.generators, tags)?.id ?? catalog.generators[0]?.id,
    textPresetId: bestByTags(catalog.textPresets, tags)?.id,
    motion: label === 'outro' ? 'pull-out' : undefined,
  }
}
