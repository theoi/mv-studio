import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../../../src/director/index.ts'
import {
  balancedRows,
  bestSplit,
  emphasisStyle,
  layoutLine,
  lyricTypography,
  peakStyle,
  refitRows,
  rowWidth,
  runWidths,
  textWidth,
  titleStyle,
} from '../../../src/director/typography.ts'
import type { AspectPreset } from '../../../src/model/types.ts'

const ASPECTS: AspectPreset[] = ['16:9', '9:16', '1:1', '4:5']
const FONTS = ['Inter', 'Syne', 'Bebas Neue', 'Caveat', 'Playfair Display']
const WORDS =
  "I keep running where the river meets the sky city lights are calling out my name don't wanna let go oh every window flickers like a flame".split(
    ' ',
  )
const BRACKETS = [
  ['(feat.', 'Mara', 'Lane)'],
  ['[Extended', 'Club', 'Mix]'],
  ['(The', 'Extended', 'Midnight', 'Club', 'Remix', 'Version)'],
  ['(Acoustic)'],
  ['(Night', 'Mix)'],
]
const LONG = ['unbreakable', 'everlasting', 'heartbreaker', 'Supercalifragilisticexpialidocious']

/**
 * The reference: every split of `words` into `rows` rows, tried in order of their breaks, keeping the first with the
 * narrowest widest row; no row ending on a word that opens a bracket unless that costs the type over 10% of the size
 * it could have in rows `limit` wide. Also how many splits tie for the narrowest.
 */
function everySplit(words: string[], rows: number, width: (s: string) => number) {
  const opens = (word: string | undefined) => !!word && /^[([]/.test(word) && !/[)\]]/.test(word)
  let ties = 0
  const search = (together: boolean) => {
    let best: { rows: string[]; widest: number } | undefined
    const visit = (from: number, left: number, acc: string[]) => {
      if (left === 1) {
        const out = [...acc, words.slice(from).join(' ')]
        const widest = Math.max(...out.map(width))
        if (best && widest === best.widest) ties++
        if (!best || widest < best.widest) best = { rows: out, widest }
        return
      }
      for (let i = from + 1; i <= words.length - (left - 1); i++)
        if (!together || !opens(words[i - 1])) visit(i, left - 1, [...acc, words.slice(from, i).join(' ')])
    }
    if (words.length >= rows && rows >= 1) visit(0, rows, [])
    return best
  }
  const kept = search(true)
  const free = words.some(opens) ? search(false) : kept
  const choose = (limit: number) => {
    const scale = (split: { widest: number }) => Math.min(1, limit / split.widest)
    return !kept || !free ? (kept ?? free) : scale(kept) >= 0.9 * scale(free) ? kept : free
  }
  return { choose, ties, kept }
}

/** Generated lyric lines and titles: short, long, with brackets, and with long stressed endings. */
function generatedLines(count: number): string[][] {
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)] as T
  const some = (min: number, max: number) =>
    Array.from({ length: min + Math.floor(next() * (max - min + 1)) }, () => pick(WORDS))
  return Array.from({ length: count }, (_, i) => {
    const kind = i % 4
    if (kind === 0) return some(1, 6)
    if (kind === 1) return some(10, 14)
    if (kind === 2) {
      const words = some(2, 8)
      words.splice(Math.floor(next() * words.length), 0, ...pick(BRACKETS))
      if (next() < 0.4) words.push(...pick(BRACKETS))
      return words
    }
    const words = [...some(1, 8), pick(LONG)]
    if (next() < 0.3) words.splice(Math.floor(next() * words.length), 0, pick(LONG))
    return words
  })
}

describe('row splits', () => {
  it('match trying every split, in lyric, chorus, stressed and title styles at every aspect', () => {
    let cases = 0
    let tied = 0
    let openers = 0
    for (const [i, words] of generatedLines(320).entries()) {
      const aspect = ASPECTS[i % ASPECTS.length] as AspectPreset
      const fontFamily = FONTS[Math.floor(i / ASPECTS.length) % FONTS.length]
      const type = lyricTypography({ aspect, busy: false, catalog: DEFAULT_CATALOG, brief: { fontFamily } })
      const style = [
        type.style,
        peakStyle(type),
        emphasisStyle(type, type.style, words.at(-1) as string),
        titleStyle(type, 1.3, 800, 0.12),
      ][Math.floor(i / 20) % 4]!
      const size = style.fontSize as number
      const width = (s: string) => textWidth(s, style, size)
      const run = runWidths(words, style, size)
      for (let rows = 1; rows <= Math.min(5, words.length); rows++) {
        const expected = everySplit(words, rows, width)
        for (const limit of [rowWidth(style, aspect), Infinity]) {
          const split = expected.choose(limit)
          expect(bestSplit(words, rows, run, limit)).toEqual(split)
          cases++
          if (split !== expected.kept) openers++
        }
        if (expected.ties) tied++
        const byLength = everySplit(words, rows, (s) => s.length)
        const rowsByLength = byLength.choose(Infinity)!.rows
        expect(balancedRows(words, rows)).toBe(rows > 1 ? rowsByLength.join('\n') : words.join(' '))
        if (byLength.ties) tied++
      }
    }
    expect(cases).toBeGreaterThan(1000)
    // Equal widest rows, where the earliest breaks must win, and rows ending on an opener both occur.
    expect(tied).toBeGreaterThan(100)
    expect(openers).toBeGreaterThan(5)
  })

  it('lay out a 150-word line at 9:16 in 4 balanced rows, and refit it into 4 rows', () => {
    const style = lyricTypography({ aspect: '9:16', busy: false, catalog: DEFAULT_CATALOG }).style
    const words = Array.from({ length: 150 }, (_, i) => (i === 70 ? '(feat.' : WORDS[i % WORDS.length]!))
    const text = words.join(' ')
    const laid = layoutLine(text, style, '9:16')
    expect(laid.rows).toBe(4)
    expect(laid.text.replace(/\n/g, ' ')).toBe(text)
    // Far too long to fit, it takes the smallest size, in rows of about equal width.
    expect(laid.fontSize).toBe(8)
    const widths = laid.text.split('\n').map((row) => textWidth(row, style, laid.fontSize))
    expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.95)
    expect(refitRows(words, 4, style, '9:16')).toEqual({ text: laid.text, fontSize: 8 })
  })
})
