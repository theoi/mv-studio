/** A file name longer than `max`, shortened in the middle so its start and extension stay readable. */
export function shortFileName(name: string, max = 23): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 6 ? name.length - dot : 0
  const end = Math.max(ext + 3, 7)
  return `${name.slice(0, max - 1 - end)}…${name.slice(-end)}`
}
