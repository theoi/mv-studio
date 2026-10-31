/**
 * Built-in kinetic typography presets. Words with lyric timings animate at their sung time; otherwise they animate in
 * order from the clip start, `stagger` seconds apart. Karaoke highlighting is applied by drawWord.
 */
import type { ParamSpec } from '../types.ts'
import type { TextAnimationDefinition, TextAnimationFrame, TextLayout, TextLayoutWord } from '../types.ts'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const num = (frame: TextAnimationFrame, key: string, fallback: number) => {
  const v = frame.params[key]
  return typeof v === 'number' ? v : fallback
}

/** Clip-local time at which a word starts animating. */
function wordStart(word: TextLayoutWord, frame: TextAnimationFrame, stagger: number): number {
  const clipStart = frame.time - frame.localTime
  return word.start !== undefined ? word.start - clipStart : word.index * stagger
}

function backOut(t: number, overshoot: number): number {
  const s = 1.70158 * overshoot * 1.5
  const u = t - 1
  return 1 + (s + 1) * u * u * u + s * u * u
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInCubic = (t: number) => t * t * t

/** Exit params shared by kinetic presets: how words leave at the end of the clip. */
export const EXIT_PARAMS: ParamSpec[] = [
  {
    key: 'exit',
    label: 'Exit',
    type: 'select',
    default: 'none',
    options: [
      { value: 'none', label: 'None' },
      { value: 'fade', label: 'Fade' },
      { value: 'rise', label: 'Float up' },
      { value: 'fall', label: 'Drop' },
      { value: 'shrink', label: 'Shrink' },
    ],
  },
  {
    key: 'exitDuration',
    label: 'Exit length',
    type: 'number',
    default: 0.4,
    min: 0.05,
    max: 2,
    step: 0.01,
    unit: 's',
    advanced: true,
  },
]

export interface WordPose {
  alpha: number
  dx: number
  dy: number
  scale: number
}

/**
 * How far a word is through the clip's exit (EXIT_PARAMS), as a pose to combine with its entrance. Words leave in
 * reading order, finishing exactly at the clip end.
 */
export function exitPose(word: TextLayoutWord, layout: TextLayout, frame: TextAnimationFrame): WordPose {
  const pose = { alpha: 1, dx: 0, dy: 0, scale: 1 }
  const mode = frame.params.exit
  if (typeof mode !== 'string' || mode === 'none') return pose
  const length = Math.max(num(frame, 'exitDuration', 0.4), 1e-3)
  const count = Math.max(layout.words.length, 1)
  const spread = Math.min(length, 0.04 * (count - 1))
  const start = frame.duration - length - spread + (count > 1 ? (spread * word.index) / (count - 1) : 0)
  const e = easeInCubic(clamp01((frame.localTime - start) / length))
  if (e <= 0) return pose
  pose.alpha = 1 - e
  if (mode === 'rise') pose.dy = -e * 0.6 * layout.fontPx
  if (mode === 'fall') pose.dy = e * 0.8 * layout.fontPx
  if (mode === 'shrink') pose.scale = 1 - 0.7 * e
  return pose
}

export const pop: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'pop',
  name: 'Pop',
  category: 'Entrance',
  description: 'Each word pops in with a little bounce.',
  tags: ['bounce', 'energetic', 'fun', 'punchy'],
  cost: 'low',
  padding: 0.5,
  params: [
    {
      key: 'stagger',
      label: 'Word delay',
      type: 'number',
      default: 0.1,
      min: 0,
      max: 1,
      step: 0.01,
      unit: 's',
    },
    {
      key: 'duration',
      label: 'Pop length',
      type: 'number',
      default: 0.35,
      min: 0.05,
      max: 1.5,
      step: 0.01,
      unit: 's',
    },
    {
      key: 'overshoot',
      label: 'Bounce',
      type: 'number',
      default: 0.6,
      min: 0,
      max: 1.5,
      step: 0.01,
      advanced: true,
    },
    ...EXIT_PARAMS,
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const stagger = num(frame, 'stagger', 0.1)
    const duration = Math.max(num(frame, 'duration', 0.35), 1e-3)
    const overshoot = num(frame, 'overshoot', 0.6)
    for (const word of layout.words) {
      const p = clamp01((frame.localTime - wordStart(word, frame, stagger)) / duration)
      if (p <= 0) continue
      const out = exitPose(word, layout, frame)
      helpers.drawWord(word, {
        scale: Math.max(backOut(p, overshoot), 0) * out.scale,
        alpha: clamp01(p * 3) * out.alpha,
        dy: out.dy,
      })
    }
  },
}

export const fadeUp: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'fade-up',
  name: 'Fade up',
  category: 'Entrance',
  description: 'Words drift up into place as they fade in.',
  tags: ['soft', 'calm', 'elegant', 'minimal'],
  cost: 'low',
  padding: 0.8,
  params: [
    {
      key: 'stagger',
      label: 'Word delay',
      type: 'number',
      default: 0.08,
      min: 0,
      max: 1,
      step: 0.01,
      unit: 's',
    },
    {
      key: 'duration',
      label: 'Fade length',
      type: 'number',
      default: 0.5,
      min: 0.05,
      max: 2,
      step: 0.01,
      unit: 's',
    },
    {
      key: 'distance',
      label: 'Distance',
      type: 'number',
      default: 0.6,
      min: 0,
      max: 2,
      step: 0.01,
      advanced: true,
    },
    ...EXIT_PARAMS,
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const stagger = num(frame, 'stagger', 0.08)
    const duration = Math.max(num(frame, 'duration', 0.5), 1e-3)
    const distance = num(frame, 'distance', 0.6) * layout.fontPx
    for (const word of layout.words) {
      const p = clamp01((frame.localTime - wordStart(word, frame, stagger)) / duration)
      if (p <= 0) continue
      const e = easeOutCubic(p)
      const out = exitPose(word, layout, frame)
      helpers.drawWord(word, { alpha: e * out.alpha, dy: (1 - e) * distance + out.dy, scale: out.scale })
    }
  },
}

export const typewriter: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'typewriter',
  name: 'Typewriter',
  category: 'Entrance',
  description: 'Letters appear one by one behind a blinking cursor.',
  tags: ['type', 'retro', 'minimal', 'story'],
  cost: 'low',
  params: [
    { key: 'speed', label: 'Letters per second', type: 'number', default: 20, min: 2, max: 80, step: 1 },
    { key: 'cursor', label: 'Cursor', type: 'boolean', default: true },
    ...EXIT_PARAMS,
  ],
  draw(ctx, layout, _style, frame, helpers) {
    const speed = Math.max(num(frame, 'speed', 20), 0.1)
    const clipStart = frame.time - frame.localTime
    // Without lyric timings, letters (and the space after each word) appear at a constant rate.
    let budget = frame.localTime * speed
    let last: { word: TextLayoutWord; chars: number } | undefined
    for (const word of layout.words) {
      const len = word.text.length
      let chars: number
      if (word.start !== undefined) {
        chars = Math.floor((frame.localTime - (word.start - clipStart)) * speed)
      } else {
        chars = Math.floor(budget)
        budget -= len + 1
      }
      if (chars <= 0) continue
      const out = exitPose(word, layout, frame)
      helpers.drawWord(word, {
        ...(chars >= len ? {} : { chars }),
        alpha: out.alpha,
        dy: out.dy,
        scale: out.scale,
      })
      last = { word, chars: Math.min(chars, len) }
    }
    const typing =
      last !== undefined && (last.chars < last.word.text.length || last.word === layout.words.at(-1))
    if (frame.params.cursor !== false && last && typing && Math.floor(frame.localTime * 2) % 2 === 0) {
      const { word, chars } = last
      const typed = ctx.measureText(word.text.slice(0, chars)).width
      const cursor = { ...word, text: '_', width: ctx.measureText('_').width }
      cursor.x = word.x + typed + layout.fontPx * 0.04
      helpers.drawWord(cursor, { alpha: exitPose(word, layout, frame).alpha })
    }
  },
}

export const BUILTIN_TEXT_ANIMATIONS: TextAnimationDefinition[] = [pop, fadeUp, typewriter]
