import type { ParamSpec } from '../engine/types.ts'

export function formatTime(t: number, withTenths = false): string {
  // Times land a hair under the tenth they were set at (3.4 - 3 is 0.3999…, 1 + 2.8 is 3.7999…), so count tenths
  // with a little slack instead of flooring the fraction.
  const tenths = Math.floor(t * 10 + 1e-6)
  const m = Math.floor(tenths / 600)
  const whole = Math.floor((tenths - m * 600) / 10)
  const base = `${m}:${String(whole).padStart(2, '0')}`
  return withTenths ? `${base}.${tenths % 10}` : base
}

export function formatTimecode(t: number): string {
  // Hundredths with the same slack as formatTime's tenths: 3.8 is 379.999… hundredths.
  const hundredths = Math.floor(t * 100 + 1e-6)
  const m = Math.floor(hundredths / 6000)
  const s = Math.floor((hundredths - m * 6000) / 100)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(m)}:${pad(s)}.${pad(hundredths % 100)}`
}

/** Analyzed tempos are fractional (119.46); people read whole beats per minute. */
export function formatBpm(bpm: number): string {
  return `${Math.round(bpm)} BPM`
}

/** `text` as a sentence: with a period at the end unless it already ends with one, or with ? ! or …. */
export const sentence = (text: string) => (/[.?!…]$/.test(text) ? text : `${text}.`)

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** A phrase made to start a sentence: "under $0.01" → "Under $0.01". */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** `name`, or the first of "name (2)", "name (3)"... that `taken` doesn't have. */
export function distinctName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(name)) return name
  let n = 2
  while (used.has(`${name} (${n})`)) n++
  return `${name} (${n})`
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

/**
 * When two versions of a project were last changed, told apart: as editedAgo() says, unless that reads the same for
 * both ("Edited just now"), then as clock times: "Edited 2:59 PM", with the date when it isn't today and the seconds
 * when the minute is the same too.
 */
export function editedTimes(a: string, b: string, now = Date.now()): [string, string] {
  const ago: [string, string] = [editedAgo(a, now), editedAgo(b, now)]
  if (ago[0] !== ago[1] || a === b) return ago
  const today = new Date(now)
  const clock = (iso: string, seconds: boolean) => {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    const time = `${d.getHours() % 12 || 12}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''} ${d.getHours() < 12 ? 'AM' : 'PM'}`
    if (d.toDateString() === today.toDateString()) return `Edited ${time}`
    const date = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    })
    return `Edited ${date}, ${time}`
  }
  const minutes: [string, string] = [clock(a, false), clock(b, false)]
  return minutes[0] !== minutes[1] ? minutes : [clock(a, true), clock(b, true)]
}
/** A wait shown before it starts, in minutes rounded up so it never reads shorter than estimated: "About 6 min". */
export function aboutMinutes(seconds: number): string {
  return seconds < 60 ? 'Under a minute' : `About ${Math.ceil(seconds / 60)} min`
}

/** The time left in a running job: "About 6 min left". */
export function timeLeft(seconds: number): string {
  return seconds < 50 ? 'Less than a minute left' : `About ${Math.round(seconds / 60)} min left`
}

/** Storage sizes as people read them: "83 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 0 && bytes < 1e6) return 'under 1 MB'
  return `${Math.round(bytes / 1e6)} MB`
}

/**
 * A number setting's value as the Inspector shows it: with its unit when it has one; an amount within -1..1 as a
 * percentage, like Opacity; a factor up to 4 (Speed, Reactivity) as a multiplier; anything else as the number.
 */
export function formatParam(spec: Extract<ParamSpec, { type: 'number' }>, n: number): string {
  const step = spec.step ?? (spec.max - spec.min) / 100
  const text = n.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2)
  if (spec.unit) return spec.unit.startsWith('°') ? `${text}${spec.unit}` : `${text} ${spec.unit}`
  if (spec.min >= -1 && spec.max <= 1) return `${Math.round(n * 100)}%`
  if (spec.min >= 0 && spec.max <= 4 && step < 1) return `${n.toFixed(1)}×`
  return text
}

/**
 * An undo label as the Undo and Redo tooltips say it: "Remove Night city" → "Undo remove Night city". Only a leading
 * verb is lowered: names keep their case ("VJ take 2"), and so do features naming their step ("Director: Rain run",
 * "Ask: Made the lyrics bigger", "Auto-cut: 12 cuts").
 */
export function undoAction(label: string): string {
  return /^[A-Z][a-z]/.test(label) && !/^\S+:/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label
}

/** The note for a search that finds nothing, such as "No matching action. Try fewer words.". */
export function noMatch(what: string): (search: string) => string {
  // Fewer words can't help a search of one word.
  return (search) =>
    `No matching ${what}. ${search.trim().split(/\s+/).length > 1 ? 'Try fewer words.' : 'Try another word.'}`
}
