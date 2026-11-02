/**
 * Keeps lyric text clips in step with edited lyrics: the director's unlinked text with a re-timed lyrics doc, and the
 * words every clip shows with a retyped line. Emphasized words and next-line previews are text clips of their own, not
 * linked to the lyrics (see compile.ts), so re-timing the line clips (src/plugins lyricClipCommands) leaves them where
 * they were.
 */
import type { EditCommand } from '../model/commands.ts'
import type {
  Animatable,
  AspectPreset,
  Id,
  LyricLine,
  LyricsDoc,
  Project,
  Seconds,
  TextClip,
} from '../model/types.ts'
import { assetTimeToTimeline } from '../engine/text.ts'
import { DIRECTOR_META_KEY, directorMeta } from './meta.ts'
import { wordTime } from './timing.ts'
import { balancedRows, blockHeight, frameWidth, layoutLine, textWidth, TITLE_SAFE } from './typography.ts'

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

/** Space a retyped clip keeps from the text next to it, as drafts leave, as a fraction of the frame height. */
const TEXT_GAP = 0.012
/** Text this close to a retyped clip (a fraction of the frame height) is beside it: the clip grows away from it. */
const BESIDE = 0.05

const settled = (a: Animatable) => a.keyframes?.at(-1)?.value ?? a.value
// Finer than a draft's 0.001: a clip retyped and then retyped back keeps the edge it grew from, so it comes back to
// the very place it had.
const roundPlace = (v: number) => Math.round(v * 1e6) / 1e6

/** Where a text clip's rows are once its entrance has settled, as fractions of the frame. */
function textBox(clip: TextClip, text: string, fontSize: number, aspect: AspectPreset) {
  const style = { ...clip.style, fontSize, uppercase: clip.style.textTransform === 'uppercase' }
  const [x, y] = [settled(clip.transform.x), settled(clip.transform.y)]
  const rows = text.split('\n')
  const height = blockHeight(rows.length, style) * settled(clip.transform.scaleY)
  const widest = Math.max(...rows.map((row) => textWidth(row, style))) / frameWidth(aspect)
  // The renderer centers the widest row on the clip's place.
  const width = Math.min(style.maxWidth ?? 1, widest) * settled(clip.transform.scaleX)
  return { top: y - height / 2, bottom: y + height / 2, left: x - width / 2, right: x + width / 2 }
}

/**
 * Where `clip` goes with `text` at `fontSize` in place of its own: about where it was, keeping its edge facing the
 * nearest text on screen beside it (so it grows away from that text, and back when retyped shorter), clear of text
 * on screen above and below it and inside the title-safe area, in smaller type where that leaves too little room. The
 * space it had stays its own.
 */
function placeRetyped(
  project: Project,
  clip: TextClip,
  text: string,
  fontSize: number,
  skip: ReadonlySet<Id>,
): { fontSize: number; y: number } {
  const aspect = project.settings.aspect
  const old = textBox(clip, clip.text, clip.style.fontSize, aspect)
  const next = textBox(clip, text, fontSize, aspect)
  const [left, right] = [Math.min(old.left, next.left), Math.max(old.right, next.right)]
  let top = TITLE_SAFE.top
  let bottom = TITLE_SAFE.bottom
  let beside: { gap: number; above: boolean } | undefined
  const end = clip.start + clip.duration
  for (const other of Object.values(project.clips)) {
    if (other.type !== 'text' || other.id === clip.id || skip.has(other.id)) continue
    if (other.start >= end || clip.start >= other.start + other.duration) continue
    const box = textBox(other, other.text, other.style.fontSize, aspect)
    if (box.right <= left || right <= box.left) continue
    const above = box.top + box.bottom < old.top + old.bottom
    if (above) top = Math.max(top, box.bottom + TEXT_GAP)
    else bottom = Math.min(bottom, box.top - TEXT_GAP)
    const gap = above ? old.top - box.bottom : box.top - old.bottom
    if (gap < BESIDE && (!beside || gap < beside.gap)) beside = { gap, above }
  }
  top = Math.min(top, old.top)
  bottom = Math.max(bottom, old.bottom)
  const tall = next.bottom - next.top
  const size = tall > bottom - top ? Math.max(8, Math.floor((fontSize * (bottom - top)) / tall)) : fontSize
  const height = (tall * size) / fontSize
  const y = !beside
    ? (old.top + old.bottom) / 2
    : beside.above
      ? old.top + height / 2
      : old.bottom - height / 2
  return { fontSize: size, y: roundPlace(Math.min(bottom - height / 2, Math.max(top + height / 2, y))) }
}

/**
 * Commands that put a lyric line's new words (`text`) in the text clips that show its words before the edit (`from`,
 * by default its current text), to dispatch with the `lyrics.updateLine` that retypes it: clips draw their own text, so
 * retyping the line alone changes nothing on screen. A clip with the whole line gets the new one in as many rows; the
 * director's clips are laid out again as a draft lays out a line (see placeRetyped for where they go). The director's
 * line clip whose last words are emphasized below it keeps that split while the line still ends with those words, no
 * bigger than they are; otherwise it shows the whole line and the emphasized clip is removed. Timing is left alone.
 * Clips whose words were changed by hand, and clips on locked tracks, stay as they are.
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
  // The settled place of the line's preview before and after: the line rolls up into place from there.
  let previewMoved: { from: number; to: number } | undefined
  // Laid out from the size the draft laid the clip out from (or the size the user has set since), and from no
  // bigger than `most`.
  const reflow = (clip: TextClip, shownWords: string[], most = Infinity) => {
    const meta = directorMeta(clip)
    if (!meta) return balancedRows(shownWords, clip.text.split('\n').length)
    const size = clip.style.fontSize
    const base = meta.lineLayout?.fitted === size ? meta.lineLayout.base : size
    const style = {
      ...clip.style,
      fontSize: Math.min(base, most),
      uppercase: clip.style.textTransform === 'uppercase',
    }
    const laid = layoutLine(shownWords.join(' '), style, project.settings.aspect)
    const placed = placeRetyped(project, clip, laid.text, laid.fontSize, new Set(removed))
    const set = (path: string[], value: unknown) =>
      sets.push({ type: 'clip.set', clipId: clip.id, path, value })
    if (placed.fontSize !== size) set(['style', 'fontSize'], placed.fontSize)
    const y = clip.transform.y
    const by = placed.y - settled(y)
    if (meta.textRole === 'preview') previewMoved = { from: settled(y), to: placed.y }
    const keyframes = y.keyframes?.map((k, i) =>
      i > 0
        ? { ...k, value: roundPlace(k.value + by) }
        : previewMoved && Math.abs(k.value - previewMoved.from) < 0.002
          ? { ...k, value: previewMoved.to }
          : k,
    )
    if (keyframes?.length) {
      if (keyframes.some((k, i) => k.value !== y.keyframes?.[i]?.value))
        set(['transform', 'y'], {
          ...y,
          value: (keyframes[0] as (typeof keyframes)[number]).value,
          keyframes,
        })
    } else if (by !== 0) set(['transform', 'y', 'value'], placed.y)
    if (meta.lineLayout?.base !== base || meta.lineLayout.fitted !== placed.fontSize)
      set(['meta', DIRECTOR_META_KEY, 'lineLayout'], { base, fitted: placed.fontSize })
    return laid.text
  }

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
  // Previews first: a line that rolls up from its preview starts from where the preview now is.
  const isPreview = (c: TextClip) => directorMeta(c)?.textRole === 'preview'
  for (const clip of [...shown.filter(isPreview), ...shown.filter((c) => !isPreview(c))]) {
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
    if (at === undefined) setText(clip, reflow(clip, newWords))
    else setText(clip, reflow(clip, newWords.slice(0, at), split.style.fontSize))
  }
  return [...sets, ...(removed.length ? [{ type: 'clip.remove' as const, clipIds: removed }] : [])]
}
