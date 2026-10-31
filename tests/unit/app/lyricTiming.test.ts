import { describe, expect, it } from 'vitest'
import { lineTiming } from '../../../src/app/state/lyricTiming.ts'

const words = (text: string) => text.split(' ').map((t, i) => ({ text: t, start: i, end: i + 1 }))

describe('lineTiming', () => {
  it('calls a line timed while its text matches its timed words', () => {
    expect(
      lineTiming({ id: 'a', text: 'hold  on tight', start: 0, end: 3, words: words('hold on tight') }),
    ).toBe('timed')
  })

  it('notices a corrected word or an added word', () => {
    const timed = words('hold on tight')
    expect(lineTiming({ id: 'a', text: 'hold on tighter', start: 0, end: 3, words: timed })).toBe('edited')
    expect(lineTiming({ id: 'a', text: 'hold on tight now', start: 0, end: 3, words: timed })).toBe('edited')
  })

  it('calls a line without timings untimed', () => {
    expect(lineTiming({ id: 'a', text: 'hold on', words: [] })).toBe('untimed')
  })
})
