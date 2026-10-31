import { describe, expect, it } from 'vitest'
import { stemBars } from '../../../src/app/state/stems.ts'

describe('stemBars', () => {
  it('draws each bar at the loudest moment of its stretch, so short hits stay visible', () => {
    const features = {
      rate: 50,
      loudness: [0, 0.9, 0, 0, 0, 0, 0.2, 0.4, 0.1],
      bands: [],
      bandEdgesHz: [],
      onsets: [],
    }
    expect(stemBars(features, 3)).toEqual([0.9, 0, 0.4])
  })

  it('draws flat bars for a stem without features', () => {
    expect(stemBars(undefined, 4)).toEqual([0, 0, 0, 0])
  })
})
