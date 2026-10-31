import { describe, expect, it } from 'vitest'
import { haldToLut, lutToStrip, parseCubeLut, sampleLut } from '../../../src/plugins/lut.ts'

/** A .cube text for a transform, written the way grading tools export it. */
function cube(size: number, f: (r: number, g: number, b: number) => [number, number, number], header = '') {
  const rows: string[] = []
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++)
        rows.push(
          f(r / (size - 1), g / (size - 1), b / (size - 1))
            .map((v) => v.toFixed(6))
            .join(' '),
        )
  return `# Created by a test\nTITLE "Warm"\n${header}LUT_3D_SIZE ${size}\n\n${rows.join('\n')}\n`
}

const warm = (r: number, g: number, b: number): [number, number, number] => [Math.min(1, r * 1.1), g, b * 0.8]

describe('cube LUTs', () => {
  it('parses title, size and rows with red changing fastest', () => {
    const lut = parseCubeLut(cube(3, warm))
    expect(lut.title).toBe('Warm')
    expect(lut.size).toBe(3)
    expect(Array.from(lut.data.subarray(3, 6)).map((v) => Number(v.toFixed(5)))).toEqual([0.55, 0, 0])
    expect(sampleLut(lut, 0.5, 0.5, 1)[2]).toBeCloseTo(0.8)
  })

  it('interpolates trilinearly between entries', () => {
    const lut = parseCubeLut(cube(2, (r, g, b) => [r, g, b]))
    expect(sampleLut(lut, 0.25, 0.5, 0.75).map((v) => Number(v.toFixed(5)))).toEqual([0.25, 0.5, 0.75])
    expect(sampleLut(lut, -1, 2, 0.5)).toEqual([0, 1, 0.5])
  })

  it('remaps a non-unit input domain onto 0..1', () => {
    // The LUT covers inputs 0..2 and halves them; after remapping, input 1 maps to the entry for 1 (output 0.5).
    const lut = parseCubeLut(cube(5, (r, g, b) => [r, g, b], 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n'))
    expect(sampleLut(lut, 1, 1, 1)[0]).toBeCloseTo(0.5, 5)
  })

  it('rejects 1D LUTs, missing sizes and wrong row counts with a readable message', () => {
    expect(() => parseCubeLut('LUT_1D_SIZE 4\n0 0 0')).toThrow(/1D LUT/)
    expect(() => parseCubeLut('0 0 0\n1 1 1')).toThrow(/LUT_3D_SIZE/)
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 1 1')).toThrow(/Expected 8 LUT rows/)
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 x')).toThrow(/Malformed/)
  })
})

describe('LUT strips', () => {
  it('lays a cube out as an n*n x n strip: x = r + n * b, y = g', () => {
    const strip = lutToStrip(parseCubeLut(cube(4, warm)))
    expect([strip.width, strip.height]).toEqual([16, 4])
    const px = (x: number, y: number) =>
      Array.from(strip.pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4))
    // r = 3 (white red), g = 0, b = 0
    expect(px(3, 0)).toEqual([255, 0, 0, 255])
    // r = 0, g = 3, b = 3: blue scaled by 0.8
    expect(px(12, 3)).toEqual([0, 255, 204, 255])
  })

  it('resamples large LUTs down to the strip size limit', () => {
    const big = parseCubeLut(cube(65, (r, g, b) => [r, g, b]))
    const strip = lutToStrip(big)
    expect([strip.width, strip.height]).toEqual([4096, 64])
    const o = (10 * 4096 + 5 * 64 + 63) * 4
    expect(Array.from(strip.pixels.subarray(o, o + 3))).toEqual([
      255,
      Math.round((10 / 63) * 255),
      Math.round((5 / 63) * 255),
    ])
  })

  it('reads Hald CLUT images and ignores other shapes', () => {
    // Level 2: 8 x 8 image holding a 4-entry cube.
    const pixels = new Uint8ClampedArray(8 * 8 * 4)
    for (let i = 0; i < 64; i++) {
      const r = i % 4
      const g = Math.floor(i / 4) % 4
      const b = Math.floor(i / 16)
      pixels.set([r * 85, g * 85, b * 85, 255], i * 4)
    }
    const lut = haldToLut(pixels, 8, 8)
    expect(lut?.size).toBe(4)
    expect(sampleLut(lut!, 1, 0, 1 / 3).map((v) => Math.round(v * 255))).toEqual([255, 0, 85])
    expect(haldToLut(pixels, 8, 4)).toBeNull()
    expect(haldToLut(new Uint8ClampedArray(10 * 10 * 4), 10, 10)).toBeNull()
  })
})
