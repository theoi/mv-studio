import type { EditCommand } from '../../model/commands.ts'
import type {
  AudioClip,
  Clip,
  Id,
  LyricLine,
  LyricWord,
  Project,
  Seconds,
  TextClip,
} from '../../model/index.ts'
import { lyricTextCommands } from '../../director/retime.ts'
import { dispatch, editor } from './project.ts'
import { toast } from './ui.ts'

/*
 * Manual lyric timing: dragging a line or its word edges on the Lyrics track, nudging by frame, and the inspector's
 * start and end. A line's words are in the time of the audio the lyrics were timed on; the clips that show the line
 * are on the timeline. Moving a line edge moves the clip edge and the first or last word together, so the line keeps
 * how long it shows before and after it is sung.
 */

/** Shortest a word may become by dragging its edges. */
const MIN_WORD = 0.05
/** Shortest a line's clip may become. */
const MIN_CLIP = 0.1
/** Word edges closer than this are one boundary and move together. */
const TOUCHING = 0.002

export type LineEdge = 'start' | 'end' | 'move'
export type WordEdge = 'start' | 'end'

interface TimedLine {
  line: LyricLine
  words: LyricWord[]
  /** Clips linked to the line, earliest first; the first one bounds the edit. */
  clips: TextClip[]
  /** Audio seconds per timeline second. */
  rate: number
  /** Audio time at timeline time t. */
  audioAt: (t: Seconds) => Seconds
  /** Where the clip before and the clip after it on the same track leave room. */
  lower: Seconds
  upper: Seconds
}

const isLyricClip = (c: Clip, lineId: Id): c is TextClip => c.type === 'text' && c.lyricLineId === lineId

function timedLine(project: Project, lineId: Id): TimedLine | null {
  const line = project.lyrics?.lines.find((l) => l.id === lineId)
  if (!line || line.words.length === 0) return null
  const audioId = project.lyrics?.audioAssetId ?? project.songAssetId
  const audio = Object.values(project.clips)
    .filter((c): c is AudioClip => c.type === 'audio' && c.assetId === audioId)
    .sort((a, b) => a.start - b.start)[0]
  const rate = audio && audio.playbackRate > 0 ? audio.playbackRate : 1
  const audioAt = (t: Seconds) => (audio ? audio.sourceStart + (t - audio.start) * rate : t)
  const clips = Object.values(project.clips)
    .filter((c) => isLyricClip(c, lineId))
    .sort((a, b) => a.start - b.start)
  let lower = 0
  let upper = Infinity
  const first = clips[0]
  if (first) {
    const end = first.start + first.duration
    for (const c of Object.values(project.clips)) {
      if (c.trackId !== first.trackId || c.id === first.id) continue
      if (c.start + c.duration <= first.start + 1e-3) lower = Math.max(lower, c.start + c.duration)
      else if (c.start >= end - 1e-3) upper = Math.min(upper, c.start)
    }
  }
  return { line, words: line.words, clips, rate, audioAt, lower, upper }
}

/** Keeps 0 inside the range, so an edit that already breaks a limit can still be left as it is. */
function range(min: number, max: number): [number, number] {
  return [Math.min(min, 0), Math.max(max, 0)]
}

/** How far (timeline seconds) a line's start, end or the whole line can move, or null for a line without timing. */
export function lineDeltaRange(project: Project, lineId: Id, edge: LineEdge): [number, number] | null {
  const t = timedLine(project, lineId)
  if (!t) return null
  const first = t.words[0] as LyricWord
  const last = t.words[t.words.length - 1] as LyricWord
  const clip = t.clips[0]
  const clipStart = clip?.start ?? -Infinity
  const clipEnd = clip ? clip.start + clip.duration : Infinity
  const earliest = -Math.min(first.start, t.line.start ?? first.start) / t.rate
  if (edge === 'start')
    return range(
      Math.max(t.lower - clipStart, earliest),
      Math.min(clipEnd - MIN_CLIP - clipStart, (first.end - MIN_WORD - first.start) / t.rate),
    )
  if (edge === 'end')
    return range(
      Math.max(clipStart + MIN_CLIP - clipEnd, (last.start + MIN_WORD - last.end) / t.rate),
      t.upper - clipEnd,
    )
  return range(Math.max(t.lower - clipStart, earliest), t.upper - clipEnd)
}

const clampTo = (value: number, [min, max]: [number, number]) => Math.min(max, Math.max(min, value))

/**
 * Commands that move a line's start, end, or the whole line by `delta` timeline seconds (clamped to
 * lineDeltaRange), with the clips that show it. Absolute values from `project`, so a drag can send them again and
 * again from where it started. Null for a line without timing.
 */
export function lineTimingCommands(
  project: Project,
  lineId: Id,
  edge: LineEdge,
  delta: Seconds,
): EditCommand[] | null {
  const t = timedLine(project, lineId)
  const limits = lineDeltaRange(project, lineId, edge)
  if (!t || !limits) return null
  const d = clampTo(delta, limits)
  const da = d * t.rate
  const n = t.words.length
  const words = t.words.map((w, i) => ({
    ...w,
    start: edge === 'move' || (edge === 'start' && i === 0) ? w.start + da : w.start,
    end: edge === 'move' || (edge === 'end' && i === n - 1) ? w.end + da : w.end,
  }))
  const patch: Partial<LyricLine> = { words }
  if (edge !== 'end' && t.line.start !== undefined) patch.start = t.line.start + da
  if (edge !== 'start' && t.line.end !== undefined) patch.end = t.line.end + da
  const commands: EditCommand[] = [{ type: 'lyrics.updateLine', lineId, patch }]
  if (edge === 'move' && t.clips.length)
    commands.push({ type: 'clip.move', moves: t.clips.map((c) => ({ clipId: c.id, start: c.start + d })) })
  for (const c of edge === 'move' ? [] : t.clips)
    commands.push(
      edge === 'start'
        ? { type: 'clip.trim', clipId: c.id, start: c.start + d, duration: c.duration - d }
        : { type: 'clip.trim', clipId: c.id, start: c.start, duration: c.duration + d },
    )
  return commands
}

/**
 * How far (timeline seconds) one edge of a word can move: not past its other edge, the next word or the clip. Edges
 * of touching words move together. Null when the line or word has no timing.
 */
export function wordEdgeRange(
  project: Project,
  lineId: Id,
  index: number,
  edge: WordEdge,
): [number, number] | null {
  const t = timedLine(project, lineId)
  const w = t?.words[index]
  if (!t || !w) return null
  const clip = t.clips[0]
  if (edge === 'end') {
    const next = t.words[index + 1]
    const touching = next && Math.abs(next.start - w.end) < TOUCHING
    const max = next
      ? touching
        ? next.end - MIN_WORD
        : next.start
      : clip
        ? t.audioAt(clip.start + clip.duration)
        : Infinity
    return range((w.start + MIN_WORD - w.end) / t.rate, (max - w.end) / t.rate)
  }
  const prev = t.words[index - 1]
  const touching = prev && Math.abs(w.start - prev.end) < TOUCHING
  const min = prev
    ? touching
      ? prev.start + MIN_WORD
      : prev.end
    : Math.max(0, clip ? t.audioAt(clip.start) : 0)
  return range((min - w.start) / t.rate, (w.end - MIN_WORD - w.start) / t.rate)
}

/** Commands that move one edge of a word by `delta` timeline seconds (clamped to wordEdgeRange), from `project`. */
export function wordEdgeCommands(
  project: Project,
  lineId: Id,
  index: number,
  edge: WordEdge,
  delta: Seconds,
): EditCommand[] | null {
  const t = timedLine(project, lineId)
  const limits = wordEdgeRange(project, lineId, index, edge)
  const w = t?.words[index]
  if (!t || !limits || !w) return null
  const da = clampTo(delta, limits) * t.rate
  const words = t.words.map((x) => ({ ...x }))
  const n = words.length
  if (edge === 'end') {
    const next = t.words[index + 1]
    ;(words[index] as LyricWord).end = w.end + da
    if (next && Math.abs(next.start - w.end) < TOUCHING)
      (words[index + 1] as LyricWord).start = next.start + da
  } else {
    const prev = t.words[index - 1]
    ;(words[index] as LyricWord).start = w.start + da
    if (prev && Math.abs(w.start - prev.end) < TOUCHING) (words[index - 1] as LyricWord).end = prev.end + da
  }
  const patch: Partial<LyricLine> = { words }
  if (t.line.start !== undefined && edge === 'start' && index === 0)
    patch.start = (words[0] as LyricWord).start
  if (t.line.end !== undefined && edge === 'end' && index === n - 1)
    patch.end = (words[n - 1] as LyricWord).end
  return [{ type: 'lyrics.updateLine', lineId, patch }]
}

export const MOVE_LABEL = 'Move lyric line'
export const TIMING_LABEL = 'Adjust lyric timing'

/** Moves a timed line by whole frames of the project's frame rate, as one undo step. */
export function nudgeLine(lineId: Id, frames: number): boolean {
  const project = editor.getProject()
  const commands = lineTimingCommands(project, lineId, 'move', frames / project.settings.fps)
  if (!commands) {
    toast('Time this line first, then nudge it.')
    return false
  }
  return dispatch(commands, { label: 'Nudge lyric line' })
}

/**
 * Sets where a line starts or ends (seconds in the lyrics' audio, as the inspector shows them). A timed line moves
 * its first or last word and its clips with it; an untimed line only stores the time.
 */
export function setLineEdge(lineId: Id, edge: WordEdge, value: Seconds, coalesceKey: string): boolean {
  const project = editor.getProject()
  const t = timedLine(project, lineId)
  if (!t) return dispatch({ type: 'lyrics.updateLine', lineId, patch: { [edge]: value } }, { coalesceKey })
  const current =
    edge === 'start'
      ? (t.line.start ?? (t.words[0] as LyricWord).start)
      : (t.line.end ?? (t.words[t.words.length - 1] as LyricWord).end)
  const commands = lineTimingCommands(project, lineId, edge, (value - current) / t.rate)
  return !!commands && dispatch(commands, { coalesceKey, label: TIMING_LABEL })
}

/** Lines being retyped in the inspector: the words each had when the typing began, which its clips still show. */
const retyping = new Map<Id, string>()

/** Retypes a line as the inspector's Words field changes; the typing is one undo step (`coalesceKey`). */
export function typeLineText(lineId: Id, text: string, coalesceKey: string): void {
  const line = editor.getProject().lyrics?.lines.find((l) => l.id === lineId)
  if (!line) return
  if (!retyping.has(lineId)) retyping.set(lineId, line.text)
  dispatch({ type: 'lyrics.updateLine', lineId, patch: { text } }, { coalesceKey })
}

/**
 * Ends the typing: the clips that show the line get its new words (lyricTextCommands), in the typing's undo step.
 * Done once typing ends rather than per key, so a word half typed on the way to another does not cost the line the
 * director's emphasized word.
 */
export function finishLineText(lineId: Id, coalesceKey: string): void {
  const from = retyping.get(lineId)
  retyping.delete(lineId)
  const project = editor.getProject()
  const text = project.lyrics?.lines.find((l) => l.id === lineId)?.text
  if (from !== undefined && text !== undefined) {
    const commands = lyricTextCommands(project, lineId, text, from)
    if (commands.length) dispatch(commands, { coalesceKey })
  }
  editor.endGesture()
}
