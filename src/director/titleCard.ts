/**
 * Keeps a director title card laid out after the user retypes its title or artist: the edited row is broken into rows
 * and sized as a draft would (growing back toward the size it was laid out from), and while the card's rows are where
 * its last layout put them, or the user moved them together, they are stacked again about the same center, so a title
 * that now takes two rows no longer runs into the artist below it. A row the user placed apart stays where it is, and
 * then only the edited row is laid out, about its own center. Only rows that record their layout (`titleLayout`) take
 * part: cards drafted before they did stay as they are.
 */
import type { EditCommand } from '../model/commands.ts'
import type { Clip, Id, Project, TextClip } from '../model/types.ts'
import { DIRECTOR_META_KEY, directorMeta, type DirectorClipMeta } from './meta.ts'
import { blockHeight, stackTitleCard, TITLE_GAP } from './typography.ts'

interface TitleRow {
  clip: TextClip
  meta: DirectorClipMeta
  layout: NonNullable<DirectorClipMeta['titleLayout']>
}

function titleRow(clip: Clip | undefined): TitleRow | undefined {
  const meta = clip?.type === 'text' ? directorMeta(clip) : undefined
  return clip?.type === 'text' && meta?.titleLayout ? { clip, meta, layout: meta.titleLayout } : undefined
}

/** The size to lay a row out from: the one it was laid out from, unless the user has set another since. */
const baseSize = ({ clip, layout }: TitleRow) =>
  layout.fitted === clip.style.fontSize ? layout.base : clip.style.fontSize

const rowCount = (text: string) => text.split('\n').length

/**
 * Commands that lay out again the director title card `clipId` belongs to, after its text changed. Empty for any
 * other clip, and for a card with a row on a locked track.
 */
export function titleCardCommands(project: Project, clipId: Id): EditCommand[] {
  const edited = titleRow(project.clips[clipId])
  if (!edited) return []
  const { start, duration } = edited.clip
  // One clip per row, the edited one taking its own: a pasted copy of the card can share its rows.
  const byRow = new Map<number, TitleRow>()
  for (const row of [edited, ...Object.values(project.clips).map(titleRow)]) {
    if (!row || row.meta.planId !== edited.meta.planId) continue
    if (row.clip.start >= start + duration || row.clip.start + row.clip.duration <= start) continue
    if (!byRow.has(row.meta.titleRow ?? 0)) byRow.set(row.meta.titleRow ?? 0, row)
  }
  const rows = [...byRow.entries()].sort(([a], [b]) => a - b).map(([, row]) => row)
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  if (rows.some((row) => locked.has(row.clip.trackId))) return []

  const moved = (row: TitleRow) => row.clip.transform.y.value - row.layout.y
  const together = rows.every((row) => Math.abs(moved(row) - moved(edited)) < 0.002)
  const card = together ? rows : [edited]
  // The center the card was stacked about, from the edited row's place and the other rows' heights (the edited row's
  // old height went with its old text, and drops out of the sum).
  const at = card.indexOf(edited)
  const span = (list: TitleRow[]) =>
    list.reduce((sum, { clip }) => sum + blockHeight(rowCount(clip.text), clip.style) + TITLE_GAP, 0)
  const center = edited.clip.transform.y.value + (span(card.slice(at + 1)) - span(card.slice(0, at))) / 2
  const laid = stackTitleCard(
    card.map((row) => ({
      text: row.clip.text,
      style: {
        ...row.clip.style,
        fontSize: baseSize(row),
        uppercase: row.clip.style.textTransform === 'uppercase',
      },
      under: (row.meta.titleRow ?? 0) > 0,
    })),
    project.settings.aspect,
    center,
  )
  const commands: EditCommand[] = []
  card.forEach((row, i) => {
    const { clip, layout } = row
    const next = laid[i] as (typeof laid)[number]
    const set = (path: string[], value: unknown) =>
      commands.push({ type: 'clip.set', clipId: clip.id, path, value })
    if (next.text !== clip.text) set(['text'], next.text)
    if (next.fontSize !== clip.style.fontSize) set(['style', 'fontSize'], next.fontSize)
    // Positions are rounded to 0.001, so the center found again can be off by that much: a row whose place changes
    // by no more than that stays put, and an unchanged card is left as it is.
    const moves = Math.abs(next.y - clip.transform.y.value) > 0.0015
    if (moves) set(['transform', 'y', 'value'], next.y)
    const base = baseSize(row)
    const y = moves ? next.y : layout.y
    if (base !== layout.base || next.fontSize !== layout.fitted || y !== layout.y)
      set(['meta', DIRECTOR_META_KEY, 'titleLayout'], { base, fitted: next.fontSize, y })
  })
  return commands
}
