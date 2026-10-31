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

/** Storage sizes as people read them: "83 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 0 && bytes < 1e6) return 'under 1 MB'
  return `${Math.round(bytes / 1e6)} MB`
}
