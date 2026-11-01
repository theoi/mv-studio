import { describe, expect, it } from 'vitest'
import { sizeLabel } from '../../../src/app/screens/export/outputs.ts'

describe('the export size label', () => {
  it.each([
    [258_600_000, 'Up to about 259 MB'],
    [400_000, 'Up to about 1 MB'],
    [1_240_000_000, 'Up to about 1.2 GB'],
  ])('for %s bytes says %s: the encoder’s target, which a file stays near or under', (bytes, label) => {
    expect(sizeLabel(bytes)).toBe(label)
  })
})
