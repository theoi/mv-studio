/** Song facts that footage matching uses: energy over a range and the times of lyric lines. */
import { energyScale, songInfoFromProject, type EnergyAt } from '../../director/inputs.ts'
import type { LyricLine, Project } from '../../model/types.ts'
import type { TimeRange } from '../types.ts'

/** Song energy over a range, 0..1 between the song's 10th and 90th percentile; undefined without an energy curve. */
export function songEnergyScale(project: Project): EnergyAt | undefined {
  return energyScale(songInfoFromProject(project))
}

/** When a lyric line is sung, from its own times or its words; undefined for untimed lines. */
export function lineSpan(line: LyricLine): TimeRange | undefined {
  const start = line.start ?? line.words[0]?.start
  const end = line.end ?? line.words[line.words.length - 1]?.end
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined
}
