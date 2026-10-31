import type { Mood } from '../types.ts'

/** Generic, content-neutral captions; a frame's mean similarity to them measures how "hub-like" it is. */
export const REFERENCE_PROMPTS: readonly string[] = [
  'a photo',
  'a video frame',
  'an image',
  'a picture of something',
  'a scene',
  'a blurry photo',
  'a close-up photo',
  'a wide shot',
  'an indoor scene',
  'an outdoor scene',
  'a dark photo',
  'a bright photo',
  'a photo of a person',
  'a photo of an object',
  'a still from a movie',
  'a screenshot',
  'a low quality photo',
  'a high quality photo',
  'a cropped photo',
  'a photo of a place',
  'a frame from a video clip',
  'a snapshot',
  'a colorful image',
  'a black and white photo',
]

export const MOOD_PROMPTS: Record<Mood, readonly string[]> = {
  calm: [
    'a calm, peaceful, still scene',
    'a serene landscape with soft light',
    'a quiet, tranquil moment with nothing moving',
    'gentle still water under a clear sky',
  ],
  energetic: [
    'a fast, energetic, action-packed scene',
    'people dancing wildly at a crowded party',
    'a dynamic scene full of motion and excitement',
    'bright flashing lights at a lively concert',
  ],
  dark: [
    'a dark, shadowy, ominous scene',
    'a gloomy night with deep shadows',
    'a dimly lit, mysterious place',
    'a sinister scene in low light',
  ],
  bright: [
    'a bright, sunny, cheerful scene',
    'a colorful scene in vivid daylight',
    'sunlight shining on a happy day',
    'a vibrant, well-lit, joyful place',
  ],
  melancholic: [
    'a sad, lonely, melancholic scene',
    'rain on a window on a grey day',
    'a lonely person in an empty place',
    'a wistful, nostalgic, faded scene',
  ],
  romantic: [
    'a romantic scene with a couple in love',
    'two people holding hands at sunset',
    'a warm, intimate, tender moment',
    'candlelight and soft romantic atmosphere',
  ],
  epic: [
    'an epic, grand, sweeping landscape',
    'a dramatic aerial view of vast mountains',
    'a heroic, cinematic, larger-than-life scene',
    'a huge crowd under dramatic skies',
  ],
  dreamy: [
    'a dreamy, soft-focus, ethereal scene',
    'hazy pastel light with a magical glow',
    'a surreal, floating, dreamlike image',
    'soft bokeh lights in a gentle haze',
  ],
}

/** Words that mean each mood, for queries written in another vocabulary (the director, LLM output). */
const MOOD_WORDS: Record<Mood, readonly string[]> = {
  calm: [
    'calm',
    'chill',
    'relaxed',
    'relaxing',
    'peaceful',
    'serene',
    'mellow',
    'tranquil',
    'gentle',
    'quiet',
    'ambient',
  ],
  energetic: [
    'energetic',
    'upbeat',
    'hype',
    'intense',
    'aggressive',
    'party',
    'fast',
    'exciting',
    'lively',
    'euphoric',
    'angry',
  ],
  dark: [
    'dark',
    'moody',
    'ominous',
    'sinister',
    'mysterious',
    'gritty',
    'menacing',
    'eerie',
    'tense',
    'haunting',
    'spooky',
  ],
  bright: [
    'bright',
    'happy',
    'joyful',
    'cheerful',
    'uplifting',
    'sunny',
    'playful',
    'fun',
    'optimistic',
    'hopeful',
  ],
  melancholic: [
    'melancholic',
    'melancholy',
    'sad',
    'lonely',
    'nostalgic',
    'somber',
    'sombre',
    'wistful',
    'bittersweet',
    'heartbroken',
  ],
  romantic: ['romantic', 'love', 'loving', 'sensual', 'intimate', 'tender', 'passionate', 'sexy'],
  epic: ['epic', 'grand', 'cinematic', 'triumphant', 'heroic', 'anthemic', 'powerful', 'dramatic'],
  dreamy: ['dreamy', 'ethereal', 'hazy', 'psychedelic', 'surreal', 'floaty', 'atmospheric'],
}

const MOOD_BY_WORD = new Map(
  (Object.entries(MOOD_WORDS) as [Mood, readonly string[]][]).flatMap(([mood, words]) =>
    words.map((w) => [w, mood] as const),
  ),
)

/**
 * The supported mood for a mood word or short phrase ("Chill" -> calm, "dark and moody" -> dark): the first word
 * that names or means a mood wins. Undefined when none does, so the caller can rank without a mood.
 */
export function resolveMood(value: string | undefined): Mood | undefined {
  for (const word of value?.toLowerCase().match(/[a-z]+/g) ?? []) {
    const mood = MOOD_BY_WORD.get(word)
    if (mood) return mood
  }
  return undefined
}

/** Expected energy 0..1 for moods whose meaning implies an amount of motion; null where motion says little. */
export const MOOD_ENERGY_PRIOR: Record<Mood, number | null> = {
  calm: 0.15,
  energetic: 0.85,
  dark: null,
  bright: null,
  melancholic: null,
  romantic: null,
  epic: 0.7,
  dreamy: 0.3,
}

const QUERY_TEMPLATES = ['a photo of {}', 'a video of {}', 'a scene showing {}'] as const

/** The raw text plus caption-style templates; the caller averages their embeddings. */
export function queryVariants(text: string): string[] {
  const t = text.trim()
  if (t === '') return []
  return [t, ...QUERY_TEMPLATES.map((tpl) => tpl.replace('{}', t))]
}

/** Content labels offered to the director, each described by a few captions (averaged). */
export const LABEL_PROMPTS: Record<string, readonly string[]> = {
  people: ['a photo of people', 'a person in the frame'],
  crowd: ['a large crowd of people', 'many people gathered together'],
  'close-up': ['a close-up of a face', 'a portrait shot of a person'],
  dancing: ['people dancing', 'a person dancing'],
  performance: ['a singer performing on stage', 'a band playing music'],
  talking: ['a person talking to the camera', 'an interview'],
  city: ['a city street with buildings', 'an urban scene'],
  night: ['a scene at night with city lights', 'a dark night scene'],
  nature: ['a natural landscape', 'trees and plants in nature'],
  forest: ['a forest with tall trees', 'woods'],
  water: ['water, a lake or a river', 'the ocean with waves'],
  beach: ['a sandy beach by the sea'],
  mountains: ['mountains and hills'],
  sky: ['the sky with clouds', 'a wide open sky'],
  sunset: ['a sunset or sunrise with warm light'],
  rain: ['rain falling', 'a rainy street with wet ground'],
  snow: ['snow and winter landscape'],
  car: ['a car driving on a road', 'a vehicle'],
  animals: ['animals', 'a bird or a wild animal'],
  indoor: ['an indoor room', 'inside a building'],
  fire: ['fire and flames'],
  lights: ['colorful neon lights', 'stage lights and lasers'],
}
