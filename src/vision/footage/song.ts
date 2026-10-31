/** Song facts that footage matching uses: energy over a range and the times of lyric lines. */
import { meanOver, songInfoFromProject } from '../../director/inputs.ts'
import type { LyricLine, Project, Seconds } from '../../model/types.ts'
import type { TimeRange } from '../types.ts'

/** Song energy over a range, 0..1 between the song's 10th and 90th percentile; undefined without an energy curve. */
export function songEnergyScale(
  project: Project,
): ((start: Seconds, end: Seconds) => number | undefined) | undefined {
  const series = songInfoFromProject(project).energy
  if (!series?.values.length) return undefined
  const sorted = [...series.values].sort((a, b) => a - b)
  const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const hi = sorted[Math.floor(sorted.length * 0.9)] ?? 1
  if (!(hi - lo > 1e-9)) return undefined
  return (start, end) => {
    const v = meanOver(series, start, end)
    return v === undefined ? undefined : Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  }
}

/** When a lyric line is sung, from its own times or its words; undefined for untimed lines. */
export function lineSpan(line: LyricLine): TimeRange | undefined {
  const start = line.start ?? line.words[0]?.start
  const end = line.end ?? line.words[line.words.length - 1]?.end
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined
}
