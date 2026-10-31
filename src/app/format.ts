export function formatTime(t: number, withTenths = false): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const whole = Math.floor(s)
  const base = `${m}:${String(whole).padStart(2, '0')}`
  return withTenths ? `${base}.${Math.floor((s - whole) * 10)}` : base
}

export function formatTimecode(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const cs = Math.floor((t % 1) * 100)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** Analyzed tempos are fractional (119.46); people read whole beats per minute. */
export function formatBpm(bpm: number): string {
  return `${Math.round(bpm)} BPM`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
