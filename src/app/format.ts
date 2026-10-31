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

/** When a project was last changed, as on its card: "Edited 5 minutes ago", "Edited yesterday", "Edited Oct 24". */
export function editedAgo(iso: string, now = Date.now()): string {
  const then = new Date(iso)
  const seconds = Math.max(0, (now - then.getTime()) / 1000)
  if (seconds < 60) return 'Edited just now'
  if (seconds < 3600) return `Edited ${plural(Math.floor(seconds / 60), 'minute')} ago`
  const today = new Date(now)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (seconds < 12 * 3600 || sameDay(then, today))
    return `Edited ${plural(Math.floor(seconds / 3600), 'hour')} ago`
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (sameDay(then, yesterday)) return 'Edited yesterday'
  const date = then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(then.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
  return `Edited ${date}`
}

/** Storage sizes as people read them: "83 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 0 && bytes < 1e6) return 'under 1 MB'
  return `${Math.round(bytes / 1e6)} MB`
}
