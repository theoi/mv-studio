import type { Id, Project } from '../../model/index.ts'
import { isBlankClip, quotedFileNames } from '../../vision/analysisData.ts'
import { formatTime } from '../format.ts'

/** Play times listed in full; more are counted instead. */
const MAX_TIMES = 3

const listed = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * Warns before export about clips on the timeline that show nothing, because footage analysis found every frame
 * black or fully transparent: "“clip08.webm” shows nothing: every frame is black or see-through. It plays at 0:15
 * and 2:18.", or "It plays 16 times, first at 0:16." Undefined when none do.
 */
export function blankClipWarning(project: Project): string | undefined {
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id))
  const uses = new Map<Id, number[]>()
  for (const clip of Object.values(project.clips)) {
    if (clip.type !== 'video' && clip.type !== 'image') continue
    if (!clip.enabled || hidden.has(clip.trackId) || !isBlankClip(project.analysis.visual[clip.assetId]))
      continue
    uses.set(clip.assetId, [...(uses.get(clip.assetId) ?? []), clip.start])
  }
  const clips = [...uses].map(([id, starts]) => {
    const times = starts.sort((a, b) => a - b).map((t) => formatTime(t))
    return {
      name: project.assets[id] ? quotedFileNames([project.assets[id].name]) : 'A clip',
      // A cut can place a clip dozens of times; the first time is enough to find it.
      counted: times.length > MAX_TIMES,
      when: times.length > MAX_TIMES ? `${times.length} times, first at ${times[0]}` : `at ${listed(times)}`,
    }
  })
  const [only] = clips
  if (!only) return undefined
  if (clips.length === 1)
    return `${only.name} shows nothing: every frame is black or see-through. It plays ${only.when}.`
  const each = clips.map((c) => `${c.name} ${c.counted ? `plays ${c.when}` : c.when}`)
  return `${clips.length} clips show nothing, as every frame is black or see-through: ${each.join('; ')}.`
}
