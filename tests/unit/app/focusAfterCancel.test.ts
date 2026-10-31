import { describe, expect, it } from 'vitest'
import { scrollToShow } from '../../../src/app/screens/editor/assist/jobState.ts'

// After a Cancel, the stopped view's note and its Generate button are scrolled into view together when they fit.
describe('scrollToShow', () => {
  it('leaves a span that is already in view where it is', () => {
    expect(scrollToShow(100, 300, 150, 380)).toBe(100)
  })

  it('scrolls down just enough to show the bottom of the span', () => {
    expect(scrollToShow(0, 300, 120, 420)).toBe(120)
  })

  it('scrolls up to the top of a span that starts above the view', () => {
    expect(scrollToShow(400, 300, 250, 500)).toBe(250)
  })

  it('gives up on a span taller than the view', () => {
    expect(scrollToShow(0, 300, 100, 401)).toBeNull()
    expect(scrollToShow(0, 300, 100, 400)).toBe(100)
  })
})
