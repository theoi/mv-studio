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

/** What an idea asks for in plain words, for the whole video or for one kind of section. */
export interface IdeaAsk {
  /** Steps faster (positive) or slower (negative), up to 2 ("very fast"). */
  pace: number
  /** 1 brighter, -1 darker. */
  light: number
  /** The idea's own words for it, as written ("fast", "bright"). */
  words: string[]
}

export interface IdeaAsks {
  all: IdeaAsk
  /** By section role (normalizedLabel): "fast and bright in the chorus" asks it of the chorus. */
  roles: Map<string, IdeaAsk>
  /**
   * What a section the idea leaves out takes of `all` instead ("fast everywhere except the bridge": nothing): `all`
   * without the words of the sentences that left it out.
   */
  excepted: Map<string, IdeaAsk>
}

const ROLE_WORDS: [RegExp, string][] = [
  [/^(pre-choruse?s?|builds?|build-ups?|buildups?)$/, 'pre-chorus'],
  [/^(choruse?s?|hooks?|refrains?|drops?)$/, 'chorus'],
  [/^verses?$/, 'verse'],
  [/^(bridges?|breakdowns?)$/, 'bridge'],
  [/^intros?$/, 'intro'],
  [/^(outros?|ending)$/, 'outro'],
]
const FASTER = new Set([
  'fast',
  'faster',
  'fast-paced',
  'quick',
  'quicker',
  'rapid',
  'snappy',
  'punchy',
  'energetic',
  'upbeat',
  'uptempo',
  'up-tempo',
  'intense',
  'frantic',
  'hectic',
  'high-energy',
])
const SLOWER = new Set([
  'slow',
  'slower',
  'slow-paced',
  'calm',
  'calmer',
  'chill',
  'relaxed',
  'gentle',
  'mellow',
  'laid-back',
])
const BRIGHTER = new Set(['bright', 'brighter', 'sunny', 'colorful', 'colourful', 'vivid', 'vibrant'])
const DARKER = new Set(['dark', 'darker', 'moody', 'gloomy'])
const STRONGER = new Set(['very', 'really', 'super', 'extra', 'much'])
/** Words between two descriptions that still join them: "fast and very bright", "dark and so slow". */
const LINKING = new Set([...STRONGER, 'so', 'more'])
/** "too" too: "the verses are too slow" asks for the opposite, which is safer missed than guessed. */
const NEGATORS = new Set([
  'not',
  'no',
  'nor',
  'never',
  'without',
  'less',
  'nothing',
  'none',
  'avoid',
  'avoiding',
  'instead',
  'rather',
  'too',
  'dont',
  'doesnt',
  'isnt',
  'wont',
  'cant',
  'shouldnt',
])
/** Words that start a new thought: "fast verses but a slow bridge". */
const BREAKS = new Set(['but', 'then', 'while', 'whereas', 'yet'])
/** Words that start a part leaving sections out: "fast everywhere except the bridge" ("apart from" is one word here). */
const EXCLUDERS = new Set(['except', 'excluding', 'apart-from', 'aside-from', 'other-than'])
/** A part naming sections with one of these and no description leaves them out: "leave the bridge alone". */
const KEEPERS = new Set(['alone', 'untouched', 'unchanged', 'intact', 'as-is', 'the-same'])
/** Things a description list can be about besides sections: "dark, grainy footage, fast chorus" ends at "footage". */
const LIST_NOUNS = new Set(
  'footage clips shots visuals images pictures photos video videos scenes colors colours lighting lights look feel vibe vibes tones palette style cuts edits editing pacing transitions camera grain'.split(
    ' ',
  ),
)
/** After a section left out, a part starting with these is about that section: "except the bridge, which is slow". */
const RELATIVES = new Set(['which', 'where', 'when', 'that', 'there'])
/** "in the chorus" ends its part of the sentence: what follows is about something else. */
const PREPOSITIONS = new Set(['in', 'during', 'for', 'on', 'through', 'throughout', 'at'])
const DETERMINERS = new Set(['the', 'a', 'an', 'each', 'every', 'all', 'its', 'both'])
/** Words that start a clause leaving sections alone: "leave the bridge alone". */
const KEEP_VERBS = new Set(['keep', 'leave', 'let'])
/** Words a part can have besides sections and still only name them: "keep the intro" in "… and outro untouched". */
const NAMING = new Set([...DETERMINERS, ...KEEP_VERBS, ',', 'and'])

const roleWord = (word: string) => ROLE_WORDS.find(([pattern]) => pattern.test(word))?.[1]
const paceOf = (word: string) => (FASTER.has(word) ? 1 : SLOWER.has(word) ? -1 : 0)
const lightOf = (word: string) => (BRIGHTER.has(word) ? 1 : DARKER.has(word) ? -1 : 0)
const describes = (word: string | undefined) => !!word && (!!paceOf(word) || !!lightOf(word))
const negates = (word: string) => NEGATORS.has(word) || word.endsWith("n't")
const endsPhrase = (next: string | undefined) =>
  next === undefined ||
  next === ',' ||
  next === '.' ||
  next === 'and' ||
  BREAKS.has(next) ||
  EXCLUDERS.has(next) ||
  PREPOSITIONS.has(next)
/** "leave the bridge alone", "keep the verses as they are", "let the bridge be". */
const keeps = (words: string[]) =>
  words.some((w) => KEEPERS.has(w)) || (words[0] === 'let' && words.at(-1) === 'be')
const onlyNames = (words: string[]) => words.every((w) => !!roleWord(w) || NAMING.has(w))

/** The prompt as words, with sentence ends as "." and commas as ",". */
function ideaTokens(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\bpre[\s-]+chorus/g, 'pre-chorus')
    .replace(/\bbuild[\s-]+up/g, 'build-up')
    .replace(/\b(apart|aside)\s+from\b/g, '$1-from')
    .replace(/\bother\s+than\b/g, 'other-than')
    .replace(/\bas\s+((it|they)\s+)?(is|are)\b/g, 'as-is')
    .replace(/\bthe\s+same\b(?!\s+as\b)/g, 'the-same')
    .replace(/&/g, ' and ')
    .replace(/[.;:!?()\n]/g, ' . ')
    .replace(/,/g, ' , ')
    .replace(/[^a-z0-9'.,\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Whether the words from `from` on lead to a section through words the lists may not know, as "dreamy verses" does
 * after "slow,": an adjective list still waiting for its noun. A noun other than a section ends it where its phrase
 * ends ("grainy footage, fast chorus"), not where it describes the next word ("feel good chorus").
 */
function listGoesOn(tokens: string[], from: number): boolean {
  let adjectives = 0
  for (let i = from; i < tokens.length && adjectives <= 3; i++) {
    const word = tokens[i] as string
    if (roleWord(word)) return adjectives > 0
    if (word === ',' || word === 'and' || LINKING.has(word)) continue
    if (word === '.' || BREAKS.has(word) || EXCLUDERS.has(word) || negates(word)) return false
    if (PREPOSITIONS.has(word) || DETERMINERS.has(word)) return false
    if (LIST_NOUNS.has(word) && endsPhrase(tokens[i + 1])) return false
    adjectives++
  }
  return false
}

interface Part {
  words: string[]
  /** Which sentence of the idea the part is in, from 0. */
  sentence: number
  /** It follows "but", which can mean "except": "everything fast but the chorus". */
  afterBut?: boolean
  /** An adjective list waiting for its section has kept it open at a comma or "and". */
  list?: boolean
}

/**
 * Splits the words into parts that each say one thing: at sentence ends, at "but"/"then", before "except"/"apart
 * from" (which stay as the part's first word), at "and" or a comma unless they join two descriptions ("fast and
 * bright", "a fast, punchy chorus") or a list of them still waiting for its section ("slow, dreamy verses"), and after
 * a section named with "in the" or "for every".
 */
function ideaParts(tokens: string[]): Part[] {
  let sentence = 0
  const parts: Part[] = [{ words: [], sentence }]
  const open = () => parts[parts.length - 1] as Part
  const close = () => {
    if (open().words.length) parts.push({ words: [], sentence })
    else open().sentence = sentence
  }
  tokens.forEach((word, i) => {
    const part = open().words
    if (word === '.') {
      sentence++
      close()
      open().afterBut = false
      return
    }
    if (BREAKS.has(word)) {
      close()
      if (word === 'but') open().afterBut = true
      return
    }
    if (word === ',' || word === 'and') {
      let next = i + 1
      while (LINKING.has(tokens[next] ?? '')) next++
      const listing =
        open().list ||
        (part.some(describes) && part.every((w) => describes(w) || LINKING.has(w) || DETERMINERS.has(w)))
      if (listing && listGoesOn(tokens, next)) open().list = true
      else if (!(describes(part[part.length - 1]) && describes(tokens[next]))) close()
      return
    }
    if (EXCLUDERS.has(word)) close()
    open().words.push(word)
    const words = open().words
    const before = words[words.length - 2] ?? ''
    const named =
      PREPOSITIONS.has(before) || (DETERMINERS.has(before) && PREPOSITIONS.has(words[words.length - 3] ?? ''))
    if (roleWord(word) && named) close()
  })
  return parts.filter((p) => p.words.length)
}

interface Vote {
  word: string
  pace: number
  light: number
  sentence: number
}

const noAsk = (): IdeaAsk => ({ pace: 0, light: 0, words: [] })

/** One section's (or the whole video's) words; opposite words cancel out rather than one of them winning. */
function tally(votes: Vote[]): IdeaAsk | undefined {
  const mixed = (key: 'pace' | 'light') => votes.some((v) => v[key] > 0) && votes.some((v) => v[key] < 0)
  const kept = votes.filter((v) => !(v.pace && mixed('pace')) && !(v.light && mixed('light')))
  if (!kept.length) return undefined
  const pace = kept.reduce((p, v) => (Math.abs(v.pace) > Math.abs(p) ? v.pace : p), 0)
  return {
    pace,
    light: kept.find((v) => v.light)?.light ?? 0,
    words: [...new Set(kept.map((v) => v.word))],
  }
}

/**
 * Pace and brightness words in an idea, without a language model. The idea is read in parts that each say one thing
 * (see ideaParts()). In each, a word goes to the section named nearest to it ("slow verses", "keep the chorus fast"),
 * or to the section the part before named when this part names none ("in the chorus, fast and bright"), else to the
 * whole video. A part with "not", "don't", "no", "avoid", "too" and the like is left out entirely: a missed word only
 * leaves the draft as it would be, a misread one turns it the wrong way. A part that starts with "except" or "apart
 * from", or is negated, or says to leave them alone, and names sections leaves those sections out of the whole-video
 * words of its sentence ("fast everywhere except the bridge", "fast cuts, but not in the verses", "leave the bridge
 * alone"), as does a part naming only sections after "but" ("everything fast but the chorus") or right after such a
 * part ("except the bridge and the outro"). Leaving alone also reaches sections named just before it in its sentence
 * by parts that only name them ("keep the intro and outro untouched"), unless its own part starts with "keep", "leave"
 * or "let". In a sentence with no whole-video words of its own, it reaches the whole idea ("Fast cuts. Don't touch the
 * bridge.").
 */
export function ideaAsks(prompt: string): IdeaAsks {
  const votes = new Map<string | undefined, Vote[]>()
  const leftOut: { role: string; sentence: number }[] = []
  let previous: { role?: string; carries: boolean; excluding: boolean; sentence: number } | undefined
  /** Sections named just before by parts that only name them: "keep the intro" in "… and outro untouched". */
  let waiting: { role: string; sentence: number }[] = []
  for (const { words, sentence, afterBut } of ideaParts(ideaTokens(prompt))) {
    const named = words.flatMap((w, i) => {
      const role = roleWord(w)
      return role ? [{ i, role }] : []
    })
    const negated = words.some(negates)
    const described = words.some(describes)
    const excluding =
      named.length > 0 &&
      (EXCLUDERS.has(words[0] ?? '') ||
        negated ||
        (!described &&
          (!!afterBut || keeps(words) || (!!previous?.excluding && previous.sentence === sentence))))
    if (excluding) leftOut.push(...named.map(({ role }) => ({ role, sentence })))
    waiting = waiting.filter((w) => w.sentence === sentence && !afterBut)
    // The word that leaves sections alone comes last, so it reaches back ("keep the intro and outro untouched"),
    // unless its part starts a clause of its own ("fast verses and chorus, leave the bridge alone").
    if (excluding && !negated && keeps(words) && !KEEP_VERBS.has(words[0] ?? '')) leftOut.push(...waiting)
    waiting =
      named.length && onlyNames(words) ? [...waiting, ...named.map(({ role }) => ({ role, sentence }))] : []
    if (described && !negated) {
      const carried =
        !named.length &&
        previous?.role &&
        (previous.carries || (previous.excluding && RELATIVES.has(words[0] ?? '')))
      words.forEach((word, i) => {
        if (!describes(word)) return
        // The nearest section named; on a tie the one after the word ("slow verse fast chorus").
        const near = named.reduce<{ i: number; role: string } | undefined>(
          (best, n) => (!best || Math.abs(n.i - i) <= Math.abs(best.i - i) ? n : best),
          undefined,
        )
        const role = near?.role ?? (carried ? previous?.role : undefined)
        const strength = STRONGER.has(words[i - 1] ?? '') ? 2 : 1
        const list = votes.get(role) ?? []
        list.push({ word, pace: paceOf(word) * strength, light: lightOf(word), sentence })
        votes.set(role, list)
      })
    }
    previous = {
      role: named[named.length - 1]?.role,
      carries: !excluding && !described && !negated,
      excluding,
      sentence,
    }
  }
  const whole = votes.get(undefined) ?? []
  const all = tally(whole) ?? noAsk()
  const roles = new Map<string, IdeaAsk>()
  for (const [role, list] of votes) {
    const ask = role ? tally(list) : undefined
    if (role && ask) roles.set(role, ask)
  }
  const excepted = new Map<string, IdeaAsk>()
  const reaches = (l: { sentence: number }, v: Vote) =>
    l.sentence === v.sentence || !whole.some((w) => w.sentence === l.sentence)
  for (const role of new Set(leftOut.map((l) => l.role))) {
    const kept = whole.filter((v) => !leftOut.some((l) => l.role === role && reaches(l, v)))
    if (kept.length < whole.length) excepted.set(role, tally(kept) ?? noAsk())
  }
  return { all, roles, excepted }
}

export function normalizedLabel(label: string): string {
  const l = label.toLowerCase()
  if (/pre[- ]?chorus|build/.test(l)) return 'pre-chorus'
  if (/chorus|hook|refrain|drop/.test(l)) return 'chorus'
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

// Non-capturing, so AI_MADE's replacer gets its own groups.
const MEDIA = String.raw`(?:clips?|footage|videos?|photos?|pictures?|images?|media|recordings?)`
const SHOTS = String.raw`(?:${MEDIA}|montage|visuals?|scenes?|shots?)`
const AI_SOURCE = String.raw`(ai[\s-]+(generated\s+|made\s+)?)`
const DURATION = String.raw`\d+[\s-]*(secs?|seconds?|mins?|minutes?)`
/** How many of a medium: "the", "some", "a few", "two" AI scenes of … */
const QUANTITY = String.raw`(the|these|those|some|my|our|an?|a\s+few|a\s+couple(\s+of)?|several|many|more|lots\s+of|a\s+lot\s+of|\d+|one|two|three|four|five|six|seven|eight|nine|ten)`

/**
 * Request words in front of the picture, which stays: "Make an AI video of …", "AI visuals of …", "my footage of …",
 * "Edit my clips into …", "Use AI to show …". Each runs on what the one before left.
 */
const REQUESTS = [
  new RegExp(
    String.raw`^(please\s+)?((can|could|would)\s+you\s+)?(make|create|generate|produce|give\s+me|show\s+me|i\s+want|i['’]?d\s+like|i\s+would\s+like)\s+(me\s+)?((a|an|some)\s+)?${AI_SOURCE}?(music\s+)?${SHOTS}\s+(of|about|with|showing|featuring|set\s+in|where)\s+`,
    'i',
  ),
  new RegExp(
    String.raw`^(please\s+)?(edit|cut|turn|make)\s+((my|our|the|these|those)\s+)?(own\s+)?${SHOTS}\s+into\s+`,
    'i',
  ),
  new RegExp(
    String.raw`^((a|an|some|my|our)\s+)?(own\s+)?(stock\s+|${AI_SOURCE})?(music\s+)?${SHOTS}(\s+(of|about|showing|featuring)\s+|\s*:\s*)`,
    'i',
  ),
  new RegExp(
    String.raw`^(please\s+)?use\s+(ai\s+to\s+(show|create|make|generate|depict|render|imagine|visuali[sz]e)|((my|our|the|these|those|some)\s+)?(own\s+)?(stock\s+|${AI_SOURCE})?${MEDIA}\s+(of|showing|from))\s+`,
    'i',
  ),
]

/**
 * "AI-generated" before what it describes goes, with its article fixed: "An AI-generated dreamscape" → "A dreamscape".
 * Not when it's the verb ("The AI generated a storm").
 */
const AI_MADE = new RegExp(
  String.raw`\b(?:(an?)\s+)?ai[\s-]+(?:generated|made)\s+(?!(?:${SHOTS}|a|an|the|this|that|these|those|some|every|it|its|them|my|our|his|her|their)\b)(?=(\S))`,
  'gi',
)

/**
 * Clauses of an idea that ask something of the editor instead of describing a picture: whose media to use, how to
 * cut, on-screen words, AI as a source, length and format. An image or video model would try to draw them. Each
 * pattern needs the words around it that make it an instruction, so a scene with the same words stays ("an AI
 * android", "paper cuts", "a woman editing photos"): an instruction left in costs less than a picture dropped.
 */
const INSTRUCTION_CLAUSES = [
  new RegExp(
    String.raw`^(please\s+)?(only\s+)?(don['’]?t\s+|do\s+not\s+)?use\s+(only\s+)?((my|our|their|the|these|those|some|more|less|no|the\s+user['’]?s)\s+)?(own\s+)?(${MEDIA}|stock|ai)\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(my|our|the\s+user['’]?s)\s+(own\s+)?${MEDIA}\b|\b(uploaded|imported)\s+${MEDIA}\b`,
    'i',
  ),
  new RegExp(String.raw`\b(no|without)\s+ai\b|^(only\s+)?${AI_SOURCE}${SHOTS}(\s+only)?$`, 'i'),
  /\bstock\s+(footage|clips?|videos?)\b/i,
  /\b(fast|quick|rapid|slow|hard|jump|sharp|snappy|smooth|lots\s+of|many|more|fewer)\s+(cuts|edits|editing|transitions)\b|\bthe\s+(edit|edits|editing)\b|\btransitions\b/i,
  /\bcut(s|ting)?\s+(on|to)\s+(the\s+|every\s+)?(beats?|music|rhythm|drums?|bass|bars?|downbeats?)\b|\bcut(s|ting)?\s+(between|every)\b/i,
  /\bsync(s|ed|ing)?\s+(it\s+|everything\s+)?(to|with)\s+(the\s+)?(beats?|music|song|rhythm|lyrics)\b/i,
  /\b(subtitles?|captions?|karaoke)\b|\b(show|display|add|put|include|no|with)\s+(the\s+)?(song['’]?s\s+)?lyrics?\b|\blyrics?\s+(on[\s-]screen|in\s+the\s+video|over)\b/i,
  new RegExp(
    String.raw`\b(make|keep)\s+it\s+((under|about|around)\s+\d|short(er)?\b|long(er)?\b|${DURATION})|\b(under|at\s+most|max(imum)?|no\s+longer\s+than|less\s+than)\s+${DURATION}\b|\b${DURATION}\s+(long|video|clip|edit|max)\b`,
    'i',
  ),
  /\b(16:9|9:16|4:5|1:1|aspect\s+ratio|export)\b|\bfor\s+(tiktok|instagram|youtube|reels|shorts)\b|\b(tiktok|instagram|youtube)\s+(format|reels?|shorts|ratio)\b/i,
]

/** Only where the clause ends or goes on with another place or action, so "a choir in the chorus of a cathedral" stays. */
const PHRASE_END = String.raw`(?=\s*$|\s+(in|at|on|with|under|over|through|across|by|near|and|while|as)\b)`

/** Phrases about the edit inside a clause that also describes a picture ("waves crashing to the beat"). */
const INSTRUCTION_PHRASES = [
  new RegExp(String.raw`\s*\b(using|with|from|in)\s+(my|our)\s+(own\s+)?${MEDIA}\b${PHRASE_END}`, 'gi'),
  new RegExp(String.raw`\s*\b(on|to|with)\s+(the|every)\s+beats?\b${PHRASE_END}`, 'gi'),
  new RegExp(
    String.raw`\s*\b(in|during|for)\s+(the|every|each)\s+(chorus(es)?|verses?|intro|outro)\b${PHRASE_END}`,
    'gi',
  ),
  // "…and AI shots of the ocean", "The AI generated images of a storm", "…and stock footage of the sea", "…and my
  // photos of the beach", "a few AI scenes of the crowd": the source words go, what they show stays.
  new RegExp(
    String.raw`\b(${QUANTITY}\s+)?(own\s+)?(stock\s+|${AI_SOURCE})${SHOTS}\s+(of|showing|featuring)\s+|\b(my|our)\s+(own\s+)?${MEDIA}\s+(of|showing|featuring)\s+`,
    'gi',
  ),
]

/**
 * A clause that rules media out ("No stock footage of cities", "Don't use my photos of the beach", "Instead of AI
 * images of people") goes whole: without its source words, what it rules out would read as the picture.
 */
const RULED_OUT = [
  /\b(no|not|never|without|don['’]?t|do\s+not|avoid(ing)?|skip(ping)?|exclud(e|ing)|except|instead\s+of|leave\s+out|leaving\s+out|rather\s+than|other\s+than)\b/i,
  new RegExp(
    String.raw`\b((my|our|the\s+user['’]?s)\s+(own\s+)?${MEDIA}|(stock\s+|${AI_SOURCE})${SHOTS})\b`,
    'i',
  ),
]

/**
 * An edit of media at the start of a clause: "Cut my clips of the concert …", "Mix my footage of the band …", "Open
 * with AI shots of the skyline". The edit goes, what the media show stays.
 */
const EDIT_OF_MEDIA = new RegExp(
  String.raw`^(please\s+)?((cut|edit|mix|trim|splice|combine|blend|intercut)\s+|(open|begin|start|end|finish|close)\s+(with|on)\s+)(${QUANTITY}\s+)?(own\s+)?(stock\s+|${AI_SOURCE})?${SHOTS}\s+(of|showing|featuring)\s+`,
  'i',
)

/**
 * "A summer montage with my photos of the beach" → "A summer montage of the beach": the source goes, what it shows
 * stays. At the start of a clause the preposition goes too, and after "end with" and the like ("…and end with my
 * footage of the harbour") so do both.
 */
const WITH_OWN_MEDIA = new RegExp(
  String.raw`(^|\s+)((open|begin|start|end|finish|close)(s|ing)?\s+)?(with|using|from|in)\s+(my|our)\s+(own\s+)?${MEDIA}\s+(of|showing|featuring)\s+`,
  'gi',
)

const FILLER = new Set(
  'please make do create it this that the a an me video music clip just and also so faster slower ai generated cut cuts cutting sync syncing synced edit edits editing'.split(
    ' ',
  ),
)

/**
 * The picture an idea describes, for image and video prompts: the idea without what it asks of the editor ("Use my
 * own clips", "cut on the beat", "show the lyrics"). Empty when nothing visual is left. The patterns are English, so
 * instructions in other languages stay in.
 */
export function visualIdea(idea: string): string {
  let kept = ''
  for (const sentence of idea.trim().split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\s*\n+\s*/)) {
    const end = /[.!?。！？]*$/.exec(sentence)?.[0] ?? ''
    const clauses = REQUESTS.reduce(
      (s, p) => s.replace(p, ''),
      sentence.slice(0, sentence.length - end.length),
    )
      .split(/\s*[,;]\s*|\s+[-–—]\s+/)
      .filter((c) => !RULED_OUT.every((p) => p.test(c)))
      .map((c) => c.replace(EDIT_OF_MEDIA, ''))
      .map((c) =>
        c.replace(AI_MADE, (_m, article?: string, next = '') =>
          article ? `${articleFor(next, article)} ` : '',
        ),
      )
      .map((c) =>
        c.replace(WITH_OWN_MEDIA, (_m, before: string, verb?: string) =>
          !before ? '' : verb ? ' ' : ' of ',
        ),
      )
      .map((c) => INSTRUCTION_PHRASES.reduce((s, p) => s.replace(p, ''), c).trim())
      .filter((c) => c && !INSTRUCTION_CLAUSES.some((p) => p.test(c)) && !onlyFiller(c))
    if (!clauses.length) continue
    // Sentences after a full-width stop follow without a space, as they were written.
    if (kept) kept += /[。！？]$/.test(kept) ? '' : ' '
    kept += clauses.join(', ') + end
  }
  return kept.replace(/[\s.,;:!?。！？、]+$/, '')
}

/** A clause whose words are all filler ("make it", "and also"); one with no words at all is not. */
function onlyFiller(clause: string): boolean {
  const words = clause
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’]+/u)
    .filter(Boolean)
  return words.length > 0 && words.every((w) => FILLER.has(w))
}

/** "a" or "an" for the word starting with `next`, capitalized like `article`. */
function articleFor(next: string, article: string): string {
  const fit = /[aeiou]/i.test(next) ? 'an' : 'a'
  return article.startsWith('A') ? `A${fit.slice(1)}` : fit
}
/** A rule-based brief section, used by the local planner and to fill gaps in an LLM brief. */
export function defaultSectionBrief(
  section: SectionInfo,
  input: PlannerInput,
  bpm: number,
  generated: boolean,
): BriefSection {
  const { mood: songMood, tags } = moodFor(section)
  const asks = ideaAsks(input.prompt)
  // As the section is named, not its role: the user's chorus is the one the song map shows, sure or not.
  const role = normalizedLabel(section.label)
  const own = asks.roles.get(role)
  const whole = asks.excepted.get(role) ?? asks.all
  const light = whole.words.filter((w) => BRIGHTER.has(w) || DARKER.has(w))
  const mood = own?.words.length
    ? [...(own.light ? [] : light), ...own.words].join(', ')
    : [...light, songMood].join(', ')
  const ownPace = own?.pace ?? 0
  const intensity =
    ownPace > 0
      ? Math.max(section.energy, 0.75)
      : ownPace < 0
        ? Math.min(section.energy, 0.35)
        : section.energy
  const steps = ownPace || whole.pace
  const pace = paceFor(input.kind, section, bpm, generated, input.pace)
  const catalog = input.catalog
  const label = roleOf(section)
  const effects: string[] = []
  if (isPeak(section) || (own?.light ?? 0) > 0) {
    const glow =
      catalog.effects.find((e) => e.id === 'glow') ?? bestByTags(catalog.effects, ['peak', 'energetic'])
    if (glow) effects.push(glow.id)
  }
  return {
    sectionId: section.id,
    mood,
    intensity,
    pace: steps >= 0 ? faster(pace, steps) : slower(pace, -steps),
    effects,
    reactive: intensity >= 0.6 ? Math.min(1, 0.3 + intensity * 0.6) : 0,
    mediaQuery: [input.prompt, mood].filter(Boolean).join(', '),
    generatorId: bestByTags(catalog.generators, tags)?.id ?? catalog.generators[0]?.id,
    motion: label === 'outro' ? 'pull-out' : undefined,
  }
}
