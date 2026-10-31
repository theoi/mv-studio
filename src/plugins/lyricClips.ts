/**
 * Text clips for lyric lines. lyricClipCommands() rebuilds a track's lyric clips for a lyrics doc, for example after
 * re-timing gives the lines new ids, keeping how the clips look and when they show around their sung lines; the
 * starter templates place their lyric clips with addLyricClipCommands().
 */
import type { EditCommand } from '../model/commands.ts'
import { createTextClip, newId } from '../model/factory.ts'
import type { AudioClip, Clip, Id, LyricLine, LyricsDoc, Project, Seconds, TextClip } from '../model/types.ts'
import { textStyleCommands } from './typography/styles.ts'

export interface LyricClipOptions {
  /** Track to rebuild; defaults to the track that holds the most lyric clips. */
  trackId?: Id
  /**
   * Clips whose look the new clips take: style, animation, karaoke, position, transitions, effects and the clip's
   * other settings. A line takes them from the clip of the same line, else the clip it overlaps most in time, else the
   * nearest one. Defaults to the lyric clips being replaced.
   */
  preserveStyleFrom?: readonly TextClip[]
  /** TEXT_STYLES id for the new clips when there is no clip to take the look from. */
  textStyleId?: string
  /**
   * Keep how long each replaced clip showed before and after its line was sung (default true): a re-timed line keeps
   * its lead-in and hold around its new sung times instead of showing exactly while it is sung. Offsets shrink where
   * they would make two lines overlap that did not overlap before.
   */
  keepLeadAndHold?: boolean
  /**
   * The lyrics the replaced clips were placed for, to measure their lead and hold. Defaults to the project's, so pass
   * the project as it was before the new lyrics were set.
   */
  previousDoc?: LyricsDoc
}

/** A clip's span and the sung span of its line, in timeline seconds: how long it shows before and after. */
export interface LyricClipTiming {
  lineId: Id
  start: Seconds
  end: Seconds
  sungStart: Seconds
  sungEnd: Seconds
}

const isLyricClip = (c: Clip): c is TextClip => c.type === 'text' && !!c.lyricLineId

/** Maps a time in the lyrics' audio asset to the timeline, through the first clip of that audio. */
function timelineOf(project: Project, audioAssetId: Id | undefined): (t: Seconds) => Seconds {
  const audio = Object.values(project.clips)
    .filter((c): c is AudioClip => c.type === 'audio' && c.assetId === audioAssetId)
    .sort((a, b) => a.start - b.start)[0]
  return (t) => (audio ? audio.start + (t - audio.sourceStart) / audio.playbackRate : t)
}

/** A line's sung span in its asset's time, when it is timed. */
function sungSpan(line: LyricLine): [Seconds, Seconds] | undefined {
  const start = line.start ?? line.words[0]?.start
  const end = line.end ?? line.words[line.words.length - 1]?.end
  return start !== undefined && end !== undefined && end > start ? [start, end] : undefined
}

function busiestLyricTrack(project: Project): Id | undefined {
  const counts = new Map<Id, number>()
  for (const c of Object.values(project.clips))
    if (isLyricClip(c)) counts.set(c.trackId, (counts.get(c.trackId) ?? 0) + 1)
  let best: Id | undefined
  for (const t of project.tracks) if ((counts.get(t.id) ?? 0) > (best ? counts.get(best)! : 0)) best = t.id
  return best
}

/**
 * Commands that replace the lyric clips (text clips linked to a lyric line) on a track with one clip per timed line of
 * `doc`, timed through the clip of the audio the lyrics were timed on. Other clips on the track, such as text the user
 * added, stay as they are. Returns no commands when there is no such track or it is locked.
 */
export function lyricClipCommands(
  project: Project,
  doc: LyricsDoc | undefined,
  options: LyricClipOptions = {},
): EditCommand[] {
  const trackId = options.trackId ?? busiestLyricTrack(project)
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track || track.kind !== 'visual' || track.locked) return []
  const replaced = Object.values(project.clips).filter(
    (c): c is TextClip => c.trackId === track.id && isLyricClip(c),
  )
  const remaining: Project = { ...project, clips: { ...project.clips } }
  for (const c of replaced) delete remaining.clips[c.id]
  const previous = options.previousDoc ?? project.lyrics
  const timing: LyricClipTiming[] = []
  if (options.keepLeadAndHold !== false && previous) {
    const lines = new Map(previous.lines.map((l) => [l.id, l]))
    const toTimeline = timelineOf(project, previous.audioAssetId ?? project.songAssetId)
    for (const clip of replaced) {
      const line = clip.lyricLineId ? lines.get(clip.lyricLineId) : undefined
      const sung = line && sungSpan(line)
      if (!line || !sung) continue
      const [sungStart, sungEnd] = sung.map(toTimeline) as [Seconds, Seconds]
      timing.push({ lineId: line.id, start: clip.start, end: clip.start + clip.duration, sungStart, sungEnd })
    }
  }
  return [
    ...(replaced.length ? [{ type: 'clip.remove' as const, clipIds: replaced.map((c) => c.id) }] : []),
    ...(doc
      ? addLyricClipCommands(remaining, doc, doc.lines, track.id, {
          sources: options.preserveStyleFrom ?? replaced,
          ...(options.textStyleId ? { textStyleId: options.textStyleId } : {}),
          timing,
        })
      : []),
  ]
}

/** The timing a line takes its lead and hold from: the same line's, else the one whose sung span overlaps it most. */
function timingSource(timing: readonly LyricClipTiming[], lineId: Id, sungStart: Seconds, sungEnd: Seconds) {
  const same = timing.find((t) => t.lineId === lineId)
  if (same) return same
  let best: LyricClipTiming | undefined
  let bestOverlap = 0
  for (const t of timing) {
    const overlap = Math.min(sungEnd, t.sungEnd) - Math.max(sungStart, t.sungStart)
    if (overlap > bestOverlap) {
      best = t
      bestOverlap = overlap
    }
  }
  return best
}

/** Shortest span a lead and hold may leave a line; shorter, the line shows exactly while it is sung. */
const MIN_SHOWN = 0.1

interface Placement {
  start: Seconds
  end: Seconds
  sungStart: Seconds
  sungEnd: Seconds
  source?: LyricClipTiming
}

/**
 * Shrinks leads and holds where two lines would overlap that did not overlap before (a couplet shown together keeps
 * its overlap). Never cuts into a sung span, so lines sung over each other still overlap as sung.
 */
function separate(placements: Placement[]): void {
  const order = [...placements].sort((a, b) => a.sungStart - b.sungStart)
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1] as Placement
    const b = order[i] as Placement
    const before =
      a.source && b.source && a.source !== b.source ? a.source.end > b.source.start + 1e-3 : false
    if (before || a.end <= b.start) continue
    const cut = Math.min(Math.max(b.start, a.sungEnd), Math.max(b.sungStart, a.sungEnd))
    a.end = Math.max(a.sungEnd, Math.min(a.end, cut))
    b.start = Math.min(b.sungStart, Math.max(b.start, cut))
  }
}

/** The source clip a new clip for a line spanning start..end takes its look from. */
function lookSource(sources: readonly TextClip[], lineId: Id, start: Seconds, end: Seconds) {
  const same = sources.find((s) => s.lyricLineId === lineId)
  if (same) return same
  let best: TextClip | undefined
  let bestOverlap = -Infinity
  for (const s of sources) {
    // Negative when apart: minus the gap between them.
    const overlap = Math.min(end, s.start + s.duration) - Math.max(start, s.start)
    if (overlap > bestOverlap) {
      best = s
      bestOverlap = overlap
    }
  }
  return best
}

/**
 * Commands that add a clip on `trackId` for each timed line of `lines` (lines of `doc`), looking like the closest of
 * `sources` (see LyricClipOptions), or in text style `textStyleId` when there are none. A clip shows while its line
 * is sung, plus the lead and hold of its line's entry in `timing` (see LyricClipOptions.keepLeadAndHold).
 */
export function addLyricClipCommands(
  project: Project,
  doc: LyricsDoc,
  lines: readonly LyricLine[],
  trackId: Id,
  options: { sources?: readonly TextClip[]; textStyleId?: string; timing?: readonly LyricClipTiming[] } = {},
): EditCommand[] {
  const toTimeline = timelineOf(project, doc.audioAssetId ?? project.songAssetId)
  const timed: { line: LyricLine; at: Placement }[] = []
  for (const line of lines) {
    const sung = sungSpan(line)
    if (!line.text.trim() || !sung) continue
    const [sungStart, sungEnd] = sung.map(toTimeline) as [Seconds, Seconds]
    const source = timingSource(options.timing ?? [], line.id, sungStart, sungEnd)
    let start = Math.max(0, sungStart - (source ? source.sungStart - source.start : 0))
    let end = sungEnd + (source ? source.end - source.sungEnd : 0)
    if (end - start < MIN_SHOWN) [start, end] = [sungStart, sungEnd]
    timed.push({ line, at: { start, end, sungStart, sungEnd, ...(source ? { source } : {}) } })
  }
  separate(timed.map((t) => t.at))
  const added: TextClip[] = []
  const unstyled: Id[] = []
  for (const { line, at } of timed) {
    const start = at.start
    const duration = at.end - at.start
    const source = lookSource(options.sources ?? [], line.id, at.sungStart, at.sungEnd)
    if (source) {
      const {
        id: _id,
        name: _name,
        start: _start,
        duration: _duration,
        text: _text,
        lyricLineId: _line,
        ...look
      } = structuredClone(source)
      added.push({
        ...look,
        id: newId(),
        trackId,
        start,
        duration,
        text: line.text,
        lyricLineId: line.id,
        effects: look.effects.map((e) => ({ ...e, id: newId() })),
      })
    } else {
      const clip = createTextClip({ trackId, text: line.text, start, duration })
      clip.lyricLineId = line.id
      added.push(clip)
      unstyled.push(clip.id)
    }
  }
  const commands: EditCommand[] = added.map((clip) => ({ type: 'clip.add', clip }))
  if (options.textStyleId && unstyled.length) {
    const withAdded = {
      ...project,
      clips: { ...project.clips, ...Object.fromEntries(added.map((c) => [c.id, c])) },
    }
    commands.push(...textStyleCommands(withAdded, unstyled, options.textStyleId))
  }
  return commands
}
