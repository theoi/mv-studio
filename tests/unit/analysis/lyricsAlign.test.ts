import { describe, expect, it } from 'vitest'
import {
  alignLines,
  alignWords,
  realignFrom,
  realignLine,
  type CtcVocabulary,
} from '../../../src/analysis/lyrics/align.ts'
import { type CtcEmissions, forcedAlign } from '../../../src/analysis/lyrics/ctc.ts'
import { alignmentKey, parseLyricsText } from '../../../src/analysis/lyrics/text.ts'
import { ctcEmissions, type CtcModel } from '../../../src/analysis/lyrics/wav2vec2.ts'
import { createLyricsApi } from '../../../src/analysis/lyrics/worker-api.ts'
import type { DecodedAudio } from '../../../src/analysis/beats/fast.ts'
import { timingLooksUncertain } from '../../../src/app/state/lyricChecks.ts'

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ'"
const vocab: CtcVocabulary = {
  ids: Object.fromEntries([...LETTERS].map((c, i) => [c, i + 2])),
  blank: 0,
  wordDelimiter: 1,
}
const V = LETTERS.length + 2

/** Emissions where each listed frame strongly emits a token and every other frame emits blank. */
function emissions(frames: number, peaks: Record<number, number>): CtcEmissions {
  const logProbs = new Float32Array(frames * V).fill(Math.log(0.1 / (V - 1)))
  for (let f = 0; f < frames; f++) logProbs[f * V + (peaks[f] ?? 0)] = Math.log(0.9)
  return { logProbs, frames, vocab: V, frameSeconds: 0.02 }
}

/** Peaks spelling `words` with the first letter of word i at frame starts[i], one letter per 2 frames. */
function sung(words: string[], starts: number[], frames: number): CtcEmissions {
  const peaks: Record<number, number> = {}
  words.forEach((w, i) => {
    ;[...alignmentKey(w)].forEach((c, k) => (peaks[(starts[i] as number) + 2 * k] = vocab.ids[c] as number))
  })
  return emissions(frames, peaks)
}

describe('forcedAlign', () => {
  it('finds the frames of each token and needs a blank between repeated tokens', () => {
    const em = emissions(40, { 5: 2, 12: 3, 13: 3, 20: 3 })
    const spans = forcedAlign(em, [2, 3, 3], 0)
    expect(spans?.map((s) => s.start)).toEqual([5, 12, 20])
    expect(spans?.[0]?.score).toBeCloseTo(0.9, 5)
    expect(forcedAlign(emissions(2, {}), [3, 3], 0)).toBeNull()
  })
})

describe('alignWords', () => {
  it('times words at their letters and holds each until the next word or maxHold', () => {
    const words = ['hold', 'on', 'tight']
    const em = sung(words, [50, 70, 200], 300)
    const timed = alignWords(em, vocab, words, { maxHold: 0.5 })
    expect(timed.map((w) => w.start)).toEqual([1, 1.4, 4])
    // "hold" ends after its last letter (frame 56) but is held until "on" starts; "on" ends after frame 72 and is
    // held for at most 0.5 s.
    expect(timed[0]?.end).toBe(1.4)
    expect(timed[1]?.end).toBeCloseTo(1.46 + 0.5, 5)
    expect(timed[2]?.confidence).toBeGreaterThan(0.8)
  })

  it('does not split a word around a stray sound long before it is sung', () => {
    const G = vocab.ids.G as number
    const em = emissions(200, { 10: G, 100: G, 102: vocab.ids.O as number })
    em.logProbs[10 * V + G] = Math.log(0.95)
    expect(alignWords(em, vocab, ['go'])[0]?.start).toBe(2)
    expect(alignWords(em, vocab, ['go'], { intraWordPause: 0 })[0]?.start).toBe(0.2)
  })

  it('spreads words without letters over the gap they fall in', () => {
    const words = ['one', '2', '3', 'four']
    const em = sung(['one', 'four'], [10, 110], 200)
    const timed = alignWords(em, vocab, words, { maxHold: 0.1 })
    expect(timed.map((w) => w.text)).toEqual(words)
    const [one, two, three, four] = timed
    expect(two?.start).toBe(one?.end)
    expect(three?.end).toBe(four?.start)
    expect(two?.confidence).toBe(0)
  })

  it('aligns within the given time range only', () => {
    const em = sung(['la', 'la'], [20, 120], 200)
    expect(alignWords(em, vocab, ['la'], { from: 1 }).map((w) => w.start)).toEqual([2.4])
  })
})

describe('alignLines and realignFrom', () => {
  const lines = [{ text: 'we were young' }, { text: 'and the night was long' }]
  const words = lines.flatMap((l) => l.text.split(' '))
  const starts = [10, 30, 50, 150, 170, 190, 210, 230]
  const em = sung(words, starts, 400)

  it('keeps lines and their words together', () => {
    const aligned = alignLines(em, vocab, lines)
    expect(aligned.map((l) => [l.text, l.start, l.words.length])).toEqual([
      ['we were young', 0.2, 3],
      ['and the night was long', 3, 5],
    ])
  })

  it('pins a dragged word and re-aligns only what follows it', () => {
    const aligned = alignLines(em, vocab, lines)
    const fixed = realignFrom(em, vocab, aligned, 1, 2, 3.9)
    expect(fixed[0]).toEqual(aligned[0])
    expect(fixed[1]?.words.slice(0, 2)).toEqual(aligned[1]?.words.slice(0, 2))
    expect(fixed[1]?.words[2]?.start).toBe(3.9)
    expect(fixed[1]?.words[3]?.start).toBeGreaterThanOrEqual(3.9)
    expect(fixed[1]?.end).toBe(fixed[1]?.words.at(-1)?.end)
  })

  it('re-times a line after the nearest timed line, skipping untimed lines in between', () => {
    const song = sung(
      'we were young a lion is out we were young'.split(' '),
      [10, 30, 50, 150, 170, 190, 210, 300, 320, 340],
      400,
    )
    const [first] = alignLines(song, vocab, [{ text: 'we were young' }], { to: 2.5 })
    const untimed = (id: string, text: string) => ({ id, text, words: [] })
    const doc = [first!, untimed('b', 'a lion is out'), untimed('c', 'we were young')]
    const fixed = realignLine(song, vocab, doc, 2)
    expect(fixed[2]?.start).toBe(6)
    expect(fixed[2]?.words.map((w) => w.text)).toEqual(['we', 'were', 'young'])
    expect(fixed.slice(0, 2)).toEqual(doc.slice(0, 2))
  })
})

describe('alignLines across instrumental stretches', () => {
  /** Mostly blank emissions; `spell` writes words from frame `start`, a word every 10 frames, a letter every 2. */
  const blank = (frames: number) => emissions(frames, {})
  function spell(em: CtcEmissions, text: string, start: number, p: number) {
    text.split(' ').forEach((word, w) =>
      [...alignmentKey(word)].forEach((c, k) => {
        const row = (start + 10 * w + 2 * k) * V
        em.logProbs.fill(Math.log(0.01 / (V - 2)), row, row + V)
        em.logProbs[row + vocab.blank] = Math.log(0.99 - p)
        em.logProbs[row + (vocab.ids[c] as number)] = Math.log(p)
      }),
    )
  }

  it('keeps a line out of a long instrumental in the middle where the vocals only bleed, but can still place it there', () => {
    // "go" is sung at 30 s; at 10 s, in the instrumental, bleed sounds even more like it.
    const em = blank(1600)
    spell(em, 'no', 50, 0.9)
    spell(em, 'go', 500, 0.9)
    spell(em, 'go', 1500, 0.6)
    const lines = [{ text: 'no' }, { text: 'go' }]
    expect(alignLines(em, vocab, lines)[1]?.start).toBe(10)
    const voiced = [
      { start: 0.5, end: 2 },
      { start: 29.5, end: 31 },
    ]
    expect(alignLines(em, vocab, lines, { voiced })[1]?.start).toBe(30)
    // A cost, not a ban: a line the voice detector missed is still timed where it is sung.
    const quiet = blank(1600)
    spell(quiet, 'no', 50, 0.9)
    spell(quiet, 'go', 1500, 0.6)
    expect(alignLines(quiet, vocab, lines, { voiced: voiced.slice(0, 1) })[1]?.start).toBe(30)
  })

  it('does not take bleed of a loud instrumental in the vocals stem for singing when the mix is given', async () => {
    const em = () => {
      const e = blank(1600)
      spell(e, 'no', 50, 0.9)
      spell(e, 'go', 500, 0.9)
      spell(e, 'go', 1500, 0.6)
      return e
    }
    /** 32 s of noise at the given amplitude over time. */
    const audio = (amplitude: (t: number) => number): DecodedAudio => {
      const pcm = new Float32Array(32 * 16000)
      let seed = 1
      for (let i = 0; i < pcm.length; i++) {
        seed = (seed * 16807) % 2147483647
        pcm[i] = ((seed / 2147483647) * 2 - 1) * amplitude(i / 16000)
      }
      return { sampleRate: 16000, channels: [pcm] }
    }
    // "no" and "go" are sung at 1 s and 30 s, 6 dB below the mix. From 5 to 20 s the band leaks into the stem 30 dB
    // below the mix (24 dB below the singing), and at 10 s the bleed sounds even more like "go".
    const vocals = audio((t) =>
      (t >= 0.5 && t < 2) || (t >= 29.5 && t < 31) ? 0.15 : t >= 5 && t < 20 ? 0.0095 : 0.0003,
    )
    const mix = audio(() => 0.3)
    const model: CtcModel = {
      async run(input) {
        const frames = Math.floor(input.length / 320)
        return { logits: new Float32Array(frames * V), frames, vocab: V }
      },
    }
    const api = createLyricsApi({
      ctcModel: async () => ({ model, vocab }),
      transcriber: async () => {
        throw new Error('not used')
      },
    })
    const ctx = { signal: new AbortController().signal, progress: () => {} }
    const lines = [{ text: 'no' }, { text: 'go' }]
    const bleeding = (await api.align({ vocals, lines, emissions: em() }, ctx)).value
    expect(bleeding.lines[1]?.start).toBe(10)
    const gated = (await api.align({ vocals, mix, lines, emissions: em() }, ctx)).value
    expect(gated.lines[1]?.start).toBe(30)
    expect(gated.voiced.filter((r) => r.end > 5 && r.start < 20)).toEqual([])
    // Re-aligning after the project is reopened uses the same regions.
    expect((await api.emissions({ vocals, mix }, ctx)).value.voiced).toEqual(gated.voiced)
  })

  it('keeps the words of a line together instead of starting it in an instrumental', () => {
    const em = blank(1700)
    spell(em, 'hold', 500, 0.9)
    spell(em, 'hold on tight', 1500, 0.6)
    const words = ['hold', 'on', 'tight']
    expect(alignWords(em, vocab, words)[0]?.start).toBe(10)
    expect(alignLines(em, vocab, [{ text: 'hold on tight' }])[0]?.start).toBe(30)
  })

  it('does not squeeze lyrics pasted without line breaks to avoid an instrumental between them', () => {
    const first = 'sun sky red sea day old new far end way one two six'
    const second = 'big cat dog fox hat jam kit log map net owl pig rug'
    const em = blank(2200)
    spell(em, first, 50, 0.9)
    // Bleed right after the first part sounds a little like the second, sung after a 36 s instrumental.
    spell(em, second, 250, 0.45)
    spell(em, second, 2000, 0.6)
    const startOfSecond = (lines: { text: string }[]) =>
      alignLines(em, vocab, lines).flatMap((l) => l.words)[13]?.start
    expect(startOfSecond([{ text: first }, { text: second }])).toBe(40)
    expect(startOfSecond([{ text: `${first} ${second}` }])).toBe(40)
  })
})

describe('alignLines with unlisted singing', () => {
  /** Mostly blank emissions with `words` spelled strongly from the given frames, a letter every 2 frames. */
  function song(frames: number, words: Record<number, string>): CtcEmissions {
    const peaks: Record<number, number> = {}
    for (const [start, word] of Object.entries(words))
      [...alignmentKey(word)].forEach((c, k) => (peaks[Number(start) + 2 * k] = vocab.ids[c] as number))
    return emissions(frames, peaks)
  }
  /**
   * Frames [from, to) sung with words the lyrics do not list: the model hears letters (mostly Q), almost never a blank,
   * and the letter `like` a little more than the others.
   */
  function unlisted(em: CtcEmissions, from: number, to: number, like?: string) {
    for (let f = from; f < to; f++) {
      const row = f * V
      em.logProbs.fill(Math.log(0.45 / (V - 3)), row, row + V)
      em.logProbs[row + vocab.blank] = Math.log(0.001)
      em.logProbs[row + (vocab.ids.Q as number)] = Math.log(0.5)
      if (like) em.logProbs[row + (vocab.ids[like] as number)] = Math.log(0.05)
    }
  }
  const off = { unlistedCost: Infinity }
  const lines = [{ text: 'no' }, { text: 'go' }]

  it('keeps the next line out of unlisted singing between two lines', () => {
    // "go" is sung at 16 s, after 10 s of other words that sound a little like a held G.
    const em = song(1000, { 50: 'no', 800: 'go' })
    unlisted(em, 200, 700, 'G')
    expect(alignLines(em, vocab, lines)[1]?.start).toBe(16)
    // Without it, "go" starts with the unlisted singing (after the word delimiter in its first frame).
    expect(alignLines(em, vocab, lines, off)[1]?.start).toBe(4.02)
  })

  it('keeps the last line out of an unlisted outro', () => {
    const em = song(1000, { 50: 'no', 300: 'go' })
    unlisted(em, 400, 900, 'G')
    expect(alignLines(em, vocab, lines)[1]?.start).toBe(6)
    expect(alignLines(em, vocab, lines, off)[1]?.start).toBe(8)
  })

  it('takes a short burst before a line for part of it, not for unlisted singing', () => {
    const em = song(400, { 50: 'no', 300: 'go' })
    unlisted(em, 200, 230, 'G')
    expect(alignLines(em, vocab, lines)[1]?.start).toBe(4.02)
    expect(alignLines(em, vocab, lines, { unlistedEntry: 0 })[1]?.start).toBe(6)
  })

  it('gives words that only unlisted singing can take a low confidence, so the timing check flags their line', () => {
    const em = song(1000, { 50: 'no', 800: 'go' })
    unlisted(em, 200, 700)
    const aligned = alignLines(em, vocab, [{ text: 'no' }, { text: 'never sung' }, { text: 'go' }])
    expect(aligned.map(timingLooksUncertain)).toEqual([false, true, false])
    expect(aligned[1]?.words.every((w) => (w.confidence ?? 1) < 0.1)).toBe(true)
  })

  it('puts no unlisted singing before a dragged word', () => {
    // "go" is sung faintly at 4 s, where the user drags it, and "go now" clearly at 16 s after unlisted singing that
    // sounds a little like the N of "now".
    const em = song(1000, { 50: 'no', 800: 'go', 820: 'now' })
    unlisted(em, 210, 700, 'N')
    em.logProbs.fill(Math.log(0.4 / (V - 2)), 200 * V, 204 * V)
    for (const [f, c] of [
      [200, 'G'],
      [202, 'O'],
    ] as const) {
      em.logProbs[f * V + (vocab.ids[c] as number)] = Math.log(0.5)
      em.logProbs[f * V + vocab.blank] = Math.log(0.1)
    }
    const aligned = alignLines(em, vocab, [{ text: 'no' }, { text: 'go now' }])
    expect(aligned[1]?.start).toBe(16)
    // Unlisted singing before it would let the dragged word's letters wait for the clear ones at 16 s.
    const dragged = realignFrom(em, vocab, aligned, 1, 0, 4)[1]?.words[0]
    expect(dragged?.start).toBe(4)
    expect(dragged?.end).toBeLessThan(5)
  })
})

describe('lyrics text', () => {
  it('drops section markers and blank lines', () => {
    expect(parseLyricsText('[Chorus]\nHold on\n\n(x2)\n  tight  now ')).toEqual([
      { text: 'Hold on', words: ['Hold', 'on'] },
      { text: 'tight  now', words: ['tight', 'now'] },
    ])
  })

  it('maps words onto A-Z and apostrophes', () => {
    expect(['Café', 'Straße', 'l’amour,', 'Œuvre', '2', "'cause"].map(alignmentKey)).toEqual([
      'CAFE',
      'STRASSE',
      "L'AMOUR",
      'OEUVRE',
      '',
      'CAUSE',
    ])
  })
})

describe('ctcEmissions', () => {
  it('stitches overlapping windows so every frame comes from the window it is most central in', async () => {
    const calls: number[] = []
    const model: CtcModel = {
      async run(input) {
        calls.push(input.length)
        const frames = Math.floor(input.length / 320)
        // Logit 0 carries the window number, logit 1 the frame index within the window.
        const logits = new Float32Array(frames * 2)
        for (let f = 0; f < frames; f++) {
          logits[2 * f] = calls.length - 1
          logits[2 * f + 1] = f
        }
        return { logits, frames, vocab: 2 }
      },
    }
    const pcm = new Float32Array(16000 * 70).map((_, i) => Math.sin(i))
    const em = await ctcEmissions(model, pcm, { windowSeconds: 30, overlapSeconds: 2 })
    expect(em.frames).toBe(3500)
    // 30 s windows advancing by 26 s: starts at 0, 26 and 52 s, the last one cut off at the end of the song.
    expect(calls).toEqual([480000, 480000, 288000])
    const windowOf = (g: number) => {
      // The difference of the two logits survives the log-softmax.
      const diff = (em.logProbs[2 * g] as number) - (em.logProbs[2 * g + 1] as number)
      // diff = window - localFrame, and localFrame = g - windowStart / 320.
      for (const [w, start] of [0, 1300, 2600].entries())
        if (Math.abs(diff - (w - (g - start))) < 1e-3) return w
      return -1
    }
    expect([0, 1399, 1400, 2699, 2700, 3499].map(windowOf)).toEqual([0, 0, 1, 1, 2, 2])
  })
})
