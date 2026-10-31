import { afterEach, describe, expect, it } from 'vitest'
import {
  hasSuggestionTurn,
  joinSuggestionQueue,
  useSuggestionQueue,
} from '../../../src/app/state/suggestions.ts'

afterEach(() => useSuggestionQueue.setState({ waiting: [] }))

const keys = () => useSuggestionQueue.getState().waiting.map((w) => w.key)

describe('inline suggestions, one at a time', () => {
  it('shows only the first suggestion to ask, then the next when it goes', () => {
    const leaveCamera = joinSuggestionQueue('camera')
    const leaveBehind = joinSuggestionQueue('behind')
    expect(hasSuggestionTurn('camera')).toBe(true)
    expect(hasSuggestionTurn('behind')).toBe(false)

    leaveCamera()
    expect(hasSuggestionTurn('behind')).toBe(true)
    leaveBehind()
    expect(keys()).toEqual([])
  })

  it('never lets a newer suggestion replace the one on screen', () => {
    const leaveBehind = joinSuggestionQueue('behind')
    const leaveCamera = joinSuggestionQueue('camera')
    leaveBehind()
    joinSuggestionQueue('behind')
    expect(hasSuggestionTurn('camera')).toBe(true)
    leaveCamera()
    expect(hasSuggestionTurn('behind')).toBe(true)
  })

  it('keeps one place in line for a suggestion that asks twice, and leaving twice is harmless', () => {
    joinSuggestionQueue('cut')
    const leave = joinSuggestionQueue('cut')
    joinSuggestionQueue('match')
    expect(keys()).toEqual(['cut', 'match'])
    leave()
    leave()
    expect(hasSuggestionTurn('match')).toBe(true)
  })

  it('lets a standing hint give way to a suggestion about the selection, and brings it back after', () => {
    joinSuggestionQueue('time-lyrics', true)
    expect(hasSuggestionTurn('time-lyrics')).toBe(true)
    const leaveCamera = joinSuggestionQueue('camera')
    expect(hasSuggestionTurn('camera')).toBe(true)
    expect(hasSuggestionTurn('time-lyrics')).toBe(false)
    leaveCamera()
    expect(hasSuggestionTurn('time-lyrics')).toBe(true)
  })
})
