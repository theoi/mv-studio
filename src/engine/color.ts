/** RGBA color with components in 0..1. */
export type Rgba = [number, number, number, number]

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

export function parseColor(value: string): Rgba {
  const m = HEX.exec(value)
  if (!m) return [0, 0, 0, 1]
  let hex = m[1] as string
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('')
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255
  return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 1]
}

export function formatColor([r, g, b, a]: Rgba): string {
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a) : ''}`
}
