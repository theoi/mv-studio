/**
 * Keeps lyric text clips in step with edited lyrics: the director's unlinked text with a re-timed lyrics doc, and the
 * words every clip shows with a retyped line. Emphasized words and next-line previews are text clips of their own, not
 * linked to the lyrics (see compile.ts), so re-timing the line clips (src/plugins lyricClipCommands) leaves them where
 * they were.
 */
import type { EditCommand } from '../model/commands.ts'
import type { Id, LyricLine, LyricsDoc, Project, Seconds, TextClip } from '../model/types.ts'
import { assetTimeToTimeline } from '../engine/text.ts'
import { directorMeta } from './meta.ts'
import { wordTime } from './timing.ts'
import { balancedRows } from './typography.ts'

const words = (text: string) => text.split(/\s+/).filter(Boolean)
const key = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
const sameWords = (a: string[], b: string[]) =>
  a.length === b.length && a.every((w, i) => key(w) === key(b[i] ?? ''))

/** A line's sung span in its asset's time, when it is timed. */
function sung(line: LyricLine | undefined): { line: LyricLine; start: Seconds; end: Seconds } | undefined {
  const start = line?.start ?? line?.words[0]?.start
  const end = line?.end ?? line?.words[line.words.length - 1]?.end
  return line && start !== undefined && end !== undefined && end > start ? { line, start, end } : undefined
}

/** Shortest re-placed clip; shorter, it would only flash. */
const MIN_SHOWN = 0.3

/**
 * Commands that move the director's emphasized words (meta textRole 'emphasis') and next-line previews ('preview')
 * to the timing of `doc`, keeping their look and their offsets from their line: an emphasized word still enters as
 * its word is sung and leaves as long after the line as before; a preview still waits through the line before its
 * own. A clip whose line is gone, untimed, or no longer ends with (for a preview: no longer has) the clip's words is
 * removed. Dispatch them with the line clips' re-timing (lyricClipCommands) in one step. Clips on locked tracks stay.
 */
export function retimeDirectorLyricCommands(project: Project, doc: LyricsDoc): EditCommand[] {
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const before = new Map((project.lyrics?.lines ?? []).map((l) => [l.id, l]))
  const after = new Map(doc.lines.map((l) => [l.id, l]))
  const oldTime = (t: Seconds) =>
    assetTimeToTimeline(project, project.lyrics?.audioAssetId ?? project.songAssetId, t)
  const newTime = (t: Seconds) => assetTimeToTimeline(project, doc.audioAssetId ?? project.songAssetId, t)
  const order = doc.lines
    .map((l) => sung(l))
    .filter((l) => l !== undefined)
    .sort((a, b) => a.start - b.start)
  const removed: Id[] = []
  const moves: EditCommand[] = []
  const place = (clip: TextClip, start: Seconds, end: Seconds) => {
    const s = Math.max(0, start)
    if (end - s < MIN_SHOWN) removed.push(clip.id)
    else if (Math.abs(s - clip.start) > 1e-3 || Math.abs(end - s - clip.duration) > 1e-3)
      moves.push({ type: 'clip.trim', clipId: clip.id, start: s, duration: end - s })
  }

  for (const clip of Object.values(project.clips)) {
    if (clip.type !== 'text' || locked.has(clip.trackId)) continue
    const meta = directorMeta(clip)
    if (!meta?.lyricLineId || (meta.textRole !== 'emphasis' && meta.textRole !== 'preview')) continue
    const next = sung(after.get(meta.lyricLineId))
    const prev = sung(before.get(meta.lyricLineId))
    const clipWords = words(clip.text)
    const lineWords = next ? words(next.line.text) : []
    const end = clip.start + clip.duration

    if (meta.textRole === 'emphasis') {
      const at = lineWords.length - clipWords.length
      if (!next || at < 1 || !sameWords(lineWords.slice(at), clipWords)) {
        removed.push(clip.id)
        continue
      }
      // Offsets from the word and from the line's end, as placed; new clips with no old timing get the defaults.
      const oldWords = prev ? words(prev.line.text) : []
      const oldAt = oldWords.length - clipWords.length
      const lead = prev && oldAt >= 1 ? clip.start - oldTime(wordTime(prev, oldWords, oldAt)) : -0.06
      const hold = prev ? Math.max(0, end - oldTime(prev.end)) : 0
      place(clip, newTime(wordTime(next, lineWords, at)) + lead, newTime(next.end) + hold)
      continue
    }

    if (!next || !sameWords(lineWords, clipWords)) {
      removed.push(clip.id)
      continue
    }
    // A preview waits from the start of the line before it until its own line's turn: both edges follow those lines.
    const index = order.findIndex((l) => l.line.id === next.line.id)
    const previous = order[index - 1]
    const oldPrevious = previous ? sung(before.get(previous.line.id)) : undefined
    const shiftEnd = prev ? newTime(next.start) - oldTime(prev.start) : 0
    const shiftStart =
      previous && oldPrevious ? newTime(previous.start) - oldTime(oldPrevious.start) : shiftEnd
    place(clip, clip.start + shiftStart, end + shiftEnd)
  }
  return [...(removed.length ? [{ type: 'clip.remove' as const, clipIds: removed }] : []), ...moves]
}

/**
 * Commands that put a lyric line's new words (`text`) in the text clips that show its words before the edit (`from`,
 * by default its current text), to dispatch with the `lyrics.updateLine` that retypes it: clips draw their own text, so retyping the line alone changes nothing on
 * screen. A clip with the whole line gets the new one in as many rows. The director's line clip whose last words are
 * emphasized below it keeps that split while the line still ends with those words; otherwise it shows the whole line
 * and the emphasized clip is removed. Timing is left alone. Clips whose words were changed by hand, and clips on
 * locked tracks, stay as they are.
 */
export function lyricTextCommands(
  project: Project,
  lineId: Id,
  text: string,
  from = project.lyrics?.lines.find((l) => l.id === lineId)?.text,
): EditCommand[] {
  if (from === undefined || from === text) return []
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const oldWords = words(from)
  const newWords = words(text)
  const shown = Object.values(project.clips).filter(
    (c): c is TextClip =>
      c.type === 'text' &&
      !locked.has(c.trackId) &&
      (c.lyricLineId ?? directorMeta(c)?.lyricLineId) === lineId,
  )
  const isEmphasis = (c: TextClip) => !c.lyricLineId && directorMeta(c)?.textRole === 'emphasis'
  const emphasis = shown.filter(isEmphasis)
  const sets: EditCommand[] = []
  const removed: Id[] = []
  const setText = (clip: TextClip, value: string) => {
    if (value !== clip.text) sets.push({ type: 'clip.set', clipId: clip.id, path: ['text'], value })
  }
  const reflow = (clip: TextClip, shownWords: string[]) =>
    balancedRows(shownWords, clip.text.split('\n').length)

  // Where each kept emphasized clip's words start in the new line.
  const kept = new Map<Id, number>()
  for (const e of emphasis) {
    const tail = words(e.text)
    const at = newWords.length - tail.length
    if (at >= 1 && sameWords(newWords.slice(at), tail)) {
      kept.set(e.id, at)
      setText(e, newWords.slice(at).join(' '))
    } else removed.push(e.id)
  }
  for (const clip of shown) {
    if (isEmphasis(clip)) continue
    const clipWords = words(clip.text)
    if (sameWords(clipWords, oldWords)) {
      setText(clip, reflow(clip, newWords))
      continue
    }
    // The director's line clip showing the words before its emphasized ones.
    const split = clip.lyricLineId
      ? emphasis.find((e) => sameWords([...clipWords, ...words(e.text)], oldWords))
      : undefined
    if (!split) continue
    const at = kept.get(split.id)
    setText(clip, reflow(clip, at === undefined ? newWords : newWords.slice(0, at)))
  }
  return [...sets, ...(removed.length ? [{ type: 'clip.remove' as const, clipIds: removed }] : [])]
}
