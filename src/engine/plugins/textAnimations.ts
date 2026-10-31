/**
 * Built-in kinetic typography presets. Words with lyric timings animate at their sung time; otherwise they animate in
 * order from the clip start, `stagger` seconds apart. Karaoke highlighting is applied by drawWord.
 */
import type { TextAnimationDefinition, TextAnimationFrame, TextLayoutWord } from '../types.ts'

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

export const pop: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'pop',
  name: 'Pop',
  category: 'Kinetic',
  description: 'Each word pops in with a little bounce.',
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
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const stagger = num(frame, 'stagger', 0.1)
    const duration = Math.max(num(frame, 'duration', 0.35), 1e-3)
    const overshoot = num(frame, 'overshoot', 0.6)
    for (const word of layout.words) {
      const p = clamp01((frame.localTime - wordStart(word, frame, stagger)) / duration)
      if (p <= 0) continue
      helpers.drawWord(word, { scale: Math.max(backOut(p, overshoot), 0), alpha: clamp01(p * 3) })
    }
  },
}

export const fadeUp: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'fade-up',
  name: 'Fade up',
  category: 'Kinetic',
  description: 'Words drift up into place as they fade in.',
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
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const stagger = num(frame, 'stagger', 0.08)
    const duration = Math.max(num(frame, 'duration', 0.5), 1e-3)
    const distance = num(frame, 'distance', 0.6) * layout.fontPx
    for (const word of layout.words) {
      const p = clamp01((frame.localTime - wordStart(word, frame, stagger)) / duration)
      if (p <= 0) continue
      const e = easeOutCubic(p)
      helpers.drawWord(word, { alpha: e, dy: (1 - e) * distance })
    }
  },
}

export const typewriter: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'typewriter',
  name: 'Typewriter',
  category: 'Kinetic',
  description: 'Letters appear one by one.',
  params: [
    { key: 'speed', label: 'Letters per second', type: 'number', default: 20, min: 2, max: 80, step: 1 },
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const speed = Math.max(num(frame, 'speed', 20), 0.1)
    const clipStart = frame.time - frame.localTime
    // Without lyric timings, letters (and the space after each word) appear at a constant rate.
    let budget = frame.localTime * speed
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
      helpers.drawWord(word, chars >= len ? {} : { chars })
    }
  },
}

export const BUILTIN_TEXT_ANIMATIONS: TextAnimationDefinition[] = [pop, fadeUp, typewriter]
