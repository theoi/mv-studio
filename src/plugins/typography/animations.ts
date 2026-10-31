/**
 * Kinetic typography presets: entrances, beat-driven emphasis and a karaoke spotlight. Words with lyric timings
 * animate at their sung time, other text word by word from the clip start. Every preset draws through
 * helpers.drawWord, so the clip's style, stroke, shadow and karaoke highlight always apply, and can end with an exit
 * (EXIT_PARAMS). Randomness is a hash of the word index and frame time, so preview equals export.
 */
import { EXIT_PARAMS, exitPose } from '../../engine/plugins/textAnimations.ts'
import { pacedTimings } from '../../engine/text.ts'
import type {
  ParamSpec,
  TextAnimationDefinition,
  TextAnimationFrame,
  TextDrawHelpers,
  TextLayout,
  TextLayoutWord,
} from '../../engine/types.ts'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const num = (frame: TextAnimationFrame, key: string, fallback: number) => {
  const v = frame.params[key]
  return typeof v === 'number' ? v : fallback
}
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInCubic = (t: number) => t * t * t
function backOut(t: number, overshoot = 1): number {
  const s = 1.70158 * overshoot
  const u = t - 1
  return 1 + (s + 1) * u * u * u + s * u * u
}
function bounceOut(t: number): number {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
/** Deterministic 0..1 noise from integers. */
function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Clip-local time at which a word starts. */
function wordStart(word: TextLayoutWord, frame: TextAnimationFrame, stagger: number): number {
  const clipStart = frame.time - frame.localTime
  return word.start !== undefined ? word.start - clipStart : word.index * stagger
}

const stagger = (value: number): ParamSpec => ({
  key: 'stagger',
  label: 'Word delay',
  type: 'number',
  default: value,
  min: 0,
  max: 1,
  step: 0.01,
  unit: 's',
})
const duration = (value: number, label = 'Entrance length'): ParamSpec => ({
  key: 'duration',
  label,
  type: 'number',
  default: value,
  min: 0.05,
  max: 2,
  step: 0.01,
  unit: 's',
})
const reactivity: ParamSpec = {
  key: 'reactivity',
  label: 'Beat reaction',
  type: 'number',
  default: 1,
  min: 0,
  max: 2,
  step: 0.05,
}

interface Pose {
  alpha?: number
  dx?: number
  dy?: number
  scale?: number
  rotation?: number
  color?: string
}

/** An entrance preset: `pose(p, word)` maps entrance progress 0..1 to a transform; the exit is layered on top. */
function entrance(
  def: Omit<TextAnimationDefinition, 'kind' | 'draw' | 'params'> & {
    params: ParamSpec[]
    defaultStagger: number
    defaultDuration: number
    pose: (p: number, word: TextLayoutWord, layout: TextLayout, frame: TextAnimationFrame) => Pose
    blur?: (p: number, layout: TextLayout) => number
  },
): TextAnimationDefinition {
  const { pose, blur, defaultStagger, defaultDuration, params, ...rest } = def
  return {
    kind: 'text-animation',
    ...rest,
    params: [stagger(defaultStagger), duration(defaultDuration), ...params, ...EXIT_PARAMS],
    draw(ctx, layout, _style, frame, helpers) {
      const delay = num(frame, 'stagger', defaultStagger)
      const length = Math.max(num(frame, 'duration', defaultDuration), 1e-3)
      for (const word of layout.words) {
        const p = clamp01((frame.localTime - wordStart(word, frame, delay)) / length)
        if (p <= 0) continue
        const blurPx = blur ? blur(p, layout) : 0
        if (blurPx > 0.05) ctx.filter = `blur(${blurPx.toFixed(2)}px)`
        drawPosed(helpers, word, pose(p, word, layout, frame), exitPose(word, layout, frame))
        if (blurPx > 0.05) ctx.filter = 'none'
      }
    },
  }
}

function drawPosed(helpers: TextDrawHelpers, word: TextLayoutWord, pose: Pose, out = exitIdentity): void {
  helpers.drawWord(word, {
    alpha: clamp01((pose.alpha ?? 1) * out.alpha),
    dx: (pose.dx ?? 0) + out.dx,
    dy: (pose.dy ?? 0) + out.dy,
    scale: Math.max((pose.scale ?? 1) * out.scale, 0),
    ...(pose.rotation ? { rotation: pose.rotation } : {}),
    ...(pose.color ? { color: pose.color } : {}),
  })
}
const exitIdentity = { alpha: 1, dx: 0, dy: 0, scale: 1 }

export const rise = entrance({
  id: 'rise',
  name: 'Rise',
  category: 'Entrance',
  description: 'Words rise into place from below the line, fast and smooth.',
  tags: ['smooth', 'modern', 'clean', 'cinematic', 'lyrics'],
  cost: 'low',
  padding: 1,
  defaultStagger: 0.07,
  defaultDuration: 0.6,
  params: [
    {
      key: 'distance',
      label: 'Distance',
      type: 'number',
      default: 0.9,
      min: 0,
      max: 3,
      step: 0.01,
      advanced: true,
    },
  ],
  pose: (p, _w, layout, frame) => {
    const e = easeOutExpo(p)
    return {
      alpha: clamp01(p * 2.5),
      dy: (1 - e) * num(frame, 'distance', 0.9) * layout.fontPx,
      scale: 0.94 + 0.06 * e,
    }
  },
})

export const zoomIn = entrance({
  id: 'zoom-in',
  name: 'Zoom in',
  category: 'Entrance',
  description: 'Words grow out of nothing and settle.',
  tags: ['punchy', 'energetic', 'impact'],
  cost: 'low',
  padding: 0.6,
  defaultStagger: 0.08,
  defaultDuration: 0.45,
  params: [],
  pose: (p) => ({ alpha: clamp01(p * 3), scale: 0.2 + 0.8 * easeOutExpo(p) }),
})

export const stamp = entrance({
  id: 'stamp',
  name: 'Stamp',
  category: 'Entrance',
  description: 'Words slam down from above the screen and shake on impact.',
  tags: ['impact', 'punchy', 'hip-hop', 'heavy', 'energetic', 'beat'],
  cost: 'low',
  padding: 1.4,
  defaultStagger: 0.12,
  defaultDuration: 0.5,
  params: [{ key: 'shake', label: 'Shake', type: 'number', default: 0.6, min: 0, max: 2, step: 0.01 }],
  pose: (p, word, layout, frame) => {
    const hit = 0.32
    if (p < hit) {
      const e = easeInCubic(p / hit)
      return { alpha: clamp01(e * 4), scale: 1.7 - 0.7 * e }
    }
    const after = (p - hit) / (1 - hit)
    const amount = num(frame, 'shake', 0.6) * (1 - after) ** 2 * layout.fontPx * 0.08
    const tick = Math.floor(frame.localTime * 60)
    return {
      dx: (hash(word.index, tick) - 0.5) * 2 * amount,
      dy: (hash(word.index + 17, tick) - 0.5) * 2 * amount,
      scale: 1 - 0.04 * Math.sin(after * Math.PI) * (1 - after),
    }
  },
})

export const drop = entrance({
  id: 'drop',
  name: 'Drop',
  category: 'Entrance',
  description: 'Words fall in from above and bounce to rest.',
  tags: ['bounce', 'fun', 'playful', 'pop'],
  cost: 'low',
  padding: 1.3,
  defaultStagger: 0.09,
  defaultDuration: 0.7,
  params: [],
  pose: (p, _w, layout) => ({ alpha: clamp01(p * 4), dy: -(1 - bounceOut(p)) * 1.2 * layout.fontPx }),
})

export const slideIn = entrance({
  id: 'slide-in',
  name: 'Slide in',
  category: 'Entrance',
  description: 'Words glide in from the side, alternating direction line by line.',
  tags: ['smooth', 'modern', 'clean', 'story'],
  cost: 'low',
  padding: 1.6,
  defaultStagger: 0.06,
  defaultDuration: 0.6,
  params: [],
  pose: (p, word, layout) => {
    const dir = word.line % 2 === 0 ? -1 : 1
    return { alpha: clamp01(p * 2), dx: dir * (1 - easeOutExpo(p)) * 1.4 * layout.fontPx }
  },
})

export const swing = entrance({
  id: 'swing',
  name: 'Swing',
  category: 'Entrance',
  description: 'Words swing upright from a tilt with a springy overshoot.',
  tags: ['playful', 'fun', 'bounce', 'pop'],
  cost: 'low',
  padding: 0.9,
  defaultStagger: 0.08,
  defaultDuration: 0.6,
  params: [],
  pose: (p) => ({
    alpha: clamp01(p * 3),
    rotation: (1 - backOut(p, 1.6)) * -35,
    scale: 0.7 + 0.3 * easeOutCubic(p),
  }),
})

export const blurIn = entrance({
  id: 'blur-in',
  name: 'Focus',
  category: 'Entrance',
  description: 'Words pull into focus from a soft blur.',
  tags: ['cinematic', 'dreamy', 'soft', 'elegant', 'calm'],
  cost: 'medium',
  padding: 0.8,
  defaultStagger: 0.1,
  defaultDuration: 0.8,
  params: [],
  pose: (p) => ({ alpha: easeOutCubic(p), scale: 1.12 - 0.12 * easeOutCubic(p) }),
  blur: (p, layout) => (1 - easeOutCubic(p)) * 0.35 * layout.fontPx,
})

export const flicker = entrance({
  id: 'flicker',
  name: 'Neon flicker',
  category: 'Entrance',
  description: 'Words stutter on like a neon sign, then keep a faint buzz.',
  tags: ['neon', 'retro', 'night', 'electronic', 'glow'],
  cost: 'low',
  padding: 0.3,
  defaultStagger: 0.15,
  defaultDuration: 0.6,
  params: [{ key: 'buzz', label: 'Buzz', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 }],
  pose: (p, word, _l, frame) => {
    const tick = Math.floor(frame.localTime * 30)
    if (p < 1) {
      const on = hash(word.index, tick) < 0.25 + 0.75 * p
      return { alpha: on ? 0.55 + 0.45 * p : 0.08 }
    }
    const buzz = num(frame, 'buzz', 0.3)
    return {
      alpha: hash(word.index + 5, tick) < 0.04 * buzz ? 0.35 : 1 - 0.08 * buzz * hash(word.index, tick),
    }
  },
})

export const glitch: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'glitch-text',
  name: 'Glitch',
  category: 'Emphasis',
  description: 'Words glitch in with split color ghosts, and twitch again on the beat.',
  tags: ['glitch', 'digital', 'electronic', 'edgy', 'cyberpunk', 'beat', 'reactive'],
  cost: 'low',
  padding: 0.5,
  params: [
    stagger(0.08),
    duration(0.5),
    { key: 'intensity', label: 'Intensity', type: 'number', default: 0.6, min: 0, max: 2, step: 0.01 },
    reactivity,
    { key: 'colorA', label: 'Ghost color', type: 'color', default: '#ff2a6d', advanced: true },
    { key: 'colorB', label: 'Second ghost color', type: 'color', default: '#05d9e8', advanced: true },
    ...EXIT_PARAMS,
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const delay = num(frame, 'stagger', 0.08)
    const length = Math.max(num(frame, 'duration', 0.5), 1e-3)
    const intensity = num(frame, 'intensity', 0.6)
    const react = num(frame, 'reactivity', 1)
    const tick = Math.floor(frame.localTime * 24)
    const beat = Math.max(frame.audio.onset, frame.audio.beat)
    const colorA = typeof frame.params.colorA === 'string' ? frame.params.colorA : '#ff2a6d'
    const colorB = typeof frame.params.colorB === 'string' ? frame.params.colorB : '#05d9e8'
    for (const word of layout.words) {
      const p = clamp01((frame.localTime - wordStart(word, frame, delay)) / length)
      if (p <= 0) continue
      const out = exitPose(word, layout, frame)
      const settling = 1 - p
      const twitch = react * beat * (hash(word.index, tick + 3) < 0.5 ? 1 : 0.3)
      const amount = intensity * Math.max(settling, twitch * 0.6) * layout.fontPx * 0.12
      const jitter = (hash(word.index, tick) - 0.5) * 2 * amount
      const visible = p >= 1 || hash(word.index + 9, tick) < 0.3 + 0.7 * p
      if (!visible) continue
      if (amount > 0.2) {
        drawPosed(helpers, word, { alpha: 0.7, dx: jitter - amount, color: colorA }, out)
        drawPosed(helpers, word, { alpha: 0.7, dx: jitter + amount, color: colorB }, out)
      }
      const slice = hash(word.index + 3, tick) < 0.25 * intensity * settling
      drawPosed(helpers, word, { dx: jitter * 0.5, ...(slice ? { dy: amount * 0.5 } : {}) }, out)
    }
  },
}

export const wave: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'wave',
  name: 'Wave',
  category: 'Emphasis',
  description: 'Words ride a gentle wave that swells with the music.',
  tags: ['playful', 'dreamy', 'flow', 'reactive', 'calm'],
  cost: 'low',
  padding: 0.6,
  params: [
    stagger(0.06),
    duration(0.4, 'Fade-in length'),
    { key: 'amplitude', label: 'Height', type: 'number', default: 0.18, min: 0, max: 1, step: 0.01 },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.8, min: 0, max: 4, step: 0.01, unit: 'Hz' },
    reactivity,
    ...EXIT_PARAMS,
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const delay = num(frame, 'stagger', 0.06)
    const length = Math.max(num(frame, 'duration', 0.4), 1e-3)
    const amp =
      num(frame, 'amplitude', 0.18) *
      layout.fontPx *
      (0.7 + 0.6 * num(frame, 'reactivity', 1) * frame.audio.loudness)
    const phase = frame.localTime * num(frame, 'speed', 0.8) * Math.PI * 2
    for (const word of layout.words) {
      const p = clamp01((frame.localTime - wordStart(word, frame, delay)) / length)
      if (p <= 0) continue
      const dy = Math.sin(phase - word.index * 0.7) * amp
      drawPosed(
        helpers,
        word,
        { alpha: easeOutCubic(p), dy, rotation: Math.cos(phase - word.index * 0.7) * 3 },
        exitPose(word, layout, frame),
      )
    }
  },
}

export const bounce: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'bounce',
  name: 'Beat bounce',
  category: 'Emphasis',
  description: 'Words pop in, then jump on every beat.',
  tags: ['beat', 'reactive', 'energetic', 'party', 'dance', 'hype'],
  cost: 'low',
  padding: 0.6,
  params: [
    stagger(0.08),
    duration(0.35),
    { key: 'amount', label: 'Jump', type: 'number', default: 0.5, min: 0, max: 2, step: 0.01 },
    ...EXIT_PARAMS,
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const delay = num(frame, 'stagger', 0.08)
    const length = Math.max(num(frame, 'duration', 0.35), 1e-3)
    const amount = num(frame, 'amount', 0.5)
    const beat = frame.audio.beat
    for (const word of layout.words) {
      const p = clamp01((frame.localTime - wordStart(word, frame, delay)) / length)
      if (p <= 0) continue
      const kick = beat * amount
      drawPosed(
        helpers,
        word,
        {
          alpha: clamp01(p * 3),
          scale: backOut(p, 1.2) * (1 + 0.18 * kick),
          dy: -kick * 0.18 * layout.fontPx,
        },
        exitPose(word, layout, frame),
      )
    }
  },
}

export const sweep: TextAnimationDefinition = {
  kind: 'text-animation',
  id: 'sweep',
  name: 'Karaoke sweep',
  category: 'Karaoke',
  description:
    'Sing-along spotlight: words wait dimmed, lift as they are sung and stay lit. Turn on karaoke for the color sweep.',
  tags: ['karaoke', 'lyrics', 'sing-along', 'highlight'],
  cost: 'low',
  padding: 0.5,
  params: [
    { key: 'dim', label: 'Upcoming opacity', type: 'number', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'lift', label: 'Lift', type: 'number', default: 0.35, min: 0, max: 1.5, step: 0.01 },
    ...EXIT_PARAMS,
  ],
  draw(_ctx, layout, _style, frame, helpers) {
    const dim = num(frame, 'dim', 0.45)
    const lift = num(frame, 'lift', 0.35)
    const clipStart = frame.time - frame.localTime
    const paced = pacedTimings(layout.words, clipStart, frame.duration)
    for (const word of layout.words) {
      const start = word.start ?? paced[word.index]?.start ?? clipStart
      const end = word.end ?? paced[word.index]?.end ?? start
      const into = frame.time - start
      const sung = clamp01(into / Math.max(Math.min(end - start, 0.25), 0.05))
      const active = frame.time >= start && frame.time < end + 0.15
      const swell = active
        ? Math.sin(Math.PI * clamp01((frame.time - start) / Math.max(end - start + 0.15, 0.1)))
        : 0
      drawPosed(
        helpers,
        word,
        {
          alpha: dim + (1 - dim) * sung,
          scale: 1 + 0.08 * lift * swell,
          dy: -0.12 * lift * swell * layout.fontPx,
        },
        exitPose(word, layout, frame),
      )
    }
  },
}

export const TEXT_ANIMATIONS: TextAnimationDefinition[] = [
  rise,
  zoomIn,
  stamp,
  drop,
  slideIn,
  swing,
  blurIn,
  flicker,
  glitch,
  wave,
  bounce,
  sweep,
]
