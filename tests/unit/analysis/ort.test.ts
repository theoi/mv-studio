import { describe, expect, it } from 'vitest'
import { backgroundThreadCount } from '../../../src/analysis/ort.ts'
import { wasmThreadCount } from '../../../src/shared/capabilities.ts'

describe('ONNX Runtime threads for background analysis', () => {
  it.each([
    [2, 1],
    [4, 2],
    [6, 3],
    [8, 4],
    [12, 6],
    [16, 8],
    [32, 8],
  ])('takes half of %i cores, within the shared policy: %i', (cores, threads) => {
    expect(backgroundThreadCount(wasmThreadCount(true, cores), cores)).toBe(threads)
  })

  it('stays within the user’s thread limit, and on one thread without cross-origin isolation', () => {
    expect(backgroundThreadCount(wasmThreadCount(true, 8, 2), 8)).toBe(2)
    expect(backgroundThreadCount(wasmThreadCount(true, 4, 1), 4)).toBe(1)
    expect(backgroundThreadCount(wasmThreadCount(false, 8), 8)).toBe(1)
  })
})
