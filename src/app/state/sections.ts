/**
 * Moving section edges. Sections that touch share their boundary, so dragging it lengthens one and shortens the
 * other; an edge with a gap beside it moves alone, up to the neighbor.
 */
import type { EditCommand, Project, SongSection } from '../../model/index.ts'
import { setAutoCutChoices } from './autocut.ts'
import { isSelectableClip } from './clipboard.ts'
import { dispatch, editor, songAnalysis, timelineDuration } from './project.ts'
import { openAssist, set } from './ui.ts'

/** Sections closer than this share a boundary. */
const TOUCH = 0.05
/** The shortest a section can be made by moving its edges, in seconds. */
export const MIN_SECTION = 1

export interface SectionBoundary {
  t: number
  /** The section that ends here, if any. */
  before?: SongSection
  /** The section that starts here, if any. */
  after?: SongSection
  /** How far the boundary can move: not past a neighbor, and no section shorter than MIN_SECTION. */
  min: number
  max: number
}

const range = (t: number, min: number, max: number) => (min <= max ? { min, max } : { min: t, max: t })

/** The edges of the song's sections, left to right, with a boundary two touching sections share listed once. */
export function sectionBoundaries(sections: readonly SongSection[], end: number): SectionBoundary[] {
  const sorted = [...sections].sort((a, b) => a.start - b.start)
  const out: SectionBoundary[] = []
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    if (prev && Math.abs(prev.end - s.start) < TOUCH)
      out.push({
        t: s.start,
        before: prev,
        after: s,
        ...range(s.start, prev.start + MIN_SECTION, s.end - MIN_SECTION),
      })
    else out.push({ t: s.start, after: s, ...range(s.start, prev ? prev.end : 0, s.end - MIN_SECTION) })
    if (!next || Math.abs(s.end - next.start) >= TOUCH)
      out.push({
        t: s.end,
        before: s,
        ...range(s.end, s.start + MIN_SECTION, next ? next.start : Math.max(end, s.end)),
      })
  })
  return out
}

/** The edits that move a boundary to t, kept within its range. */
export function moveBoundaryCommands(assetId: string, b: SectionBoundary, t: number): EditCommand[] {
  const at = Math.min(b.max, Math.max(b.min, t))
  const commands: EditCommand[] = []
  if (b.before)
    commands.push({ type: 'analysis.updateSection', assetId, sectionId: b.before.id, patch: { end: at } })
  if (b.after)
    commands.push({ type: 'analysis.updateSection', assetId, sectionId: b.after.id, patch: { start: at } })
  return commands
}

/** The boundary at a section's start or end. */
export function sectionEdge(p: Project, id: string, edge: 'start' | 'end'): SectionBoundary | undefined {
  return sectionBoundaries(songAnalysis(p)?.sections ?? [], timelineDuration(p)).find(
    (b) => (edge === 'start' ? b.after : b.before)?.id === id,
  )
}

/** Moves a boundary to t. Pass the same coalesceKey for every step of a drag so it is one undo step. */
export function moveBoundary(b: SectionBoundary, t: number, coalesceKey?: string): boolean {
  const a = songAnalysis(editor.getProject())
  if (!a) return false
  return dispatch(moveBoundaryCommands(a.assetId, b, t), {
    label: 'Move section edge',
    ...(coalesceKey ? { coalesceKey } : {}),
  })
}

/**
 * The clips "Select its clips" picks: those that play during the section, left to right. Adjustment layers such as a
 * look that run past the section are left out, since they belong to more than this section.
 */
export function sectionClipIds(p: Project, s: SongSection): string[] {
  return Object.values(p.clips)
    .filter((c) => isSelectableClip(c) && c.start < s.end - TOUCH && c.start + c.duration > s.start + TOUCH)
    .filter(
      (c) => c.type !== 'adjustment' || (c.start >= s.start - TOUCH && c.start + c.duration <= s.end + TOUCH),
    )
    .sort((a, b) => a.start - b.start)
    .map((c) => c.id)
}

/** Opens Assist › Auto-cut set to cut this section only. */
export function cutClipsToSection(id: string): void {
  set({ selection: { type: 'section', id } })
  setAutoCutChoices({ range: 'section' })
  openAssist('autocut')
}
