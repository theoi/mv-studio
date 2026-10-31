import { describe, expect, it } from 'vitest'
import { cancelledMessage } from '../../../src/app/screens/export/outputs.ts'

describe('a cancelled export', () => {
  it.each([
    [3, 0, 'Export cancelled. Nothing was saved.'],
    [1, 0, 'Export cancelled. Nothing was saved.'],
    [3, 1, 'Export cancelled. 1 of 3 files was saved to Downloads.'],
    [3, 2, 'Export cancelled. 2 of 3 files were saved to Downloads.'],
  ])('of %i files with %i saved says so', (total, saved, message) => {
    expect(cancelledMessage(total, saved)).toBe(message)
  })
})
