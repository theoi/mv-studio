/**
 * Library items and what adding one does: the looks, effects and transitions the Library tabs list, where a clicked
 * item lands, the one undoable edit it makes, and the toast that says so.
 */
import { pluginRegistry } from '../../engine/registry.ts'
import type { PluginCatalogEntry } from '../../engine/types.ts'
import type { Clip, Project, Seconds, VisualClip } from '../../model/index.ts'
import { createEffectInstance, createTransition } from '../../plugins/library.ts'
import {
  applyLookCommands,
  currentLook,
  lookRegistry,
  ORIGINAL_LOOK,
  removeLookCommands,
} from '../../plugins/looks.ts'
import { formatTime } from '../format.ts'
import { dispatch, editor, viewOf } from './project.ts'
import { get, select, toast, type Selection } from './ui.ts'

/** Anything the library search can match: names, categories, descriptions and tags. */
export interface Searchable {
  name: string
  category?: string
  description?: string
  tags?: readonly string[]
}

/** True when every word of the query appears in the item's name, category, description or tags. */
export function matchesQuery(query: string, item: Searchable): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [item.name, item.category, item.description, ...(item.tags ?? [])].join(' ').toLowerCase()
  return words.every((w) => text.includes(w))
}

export interface LookItem extends Searchable {
  id: string
  thumbnail?: string
}

/** Original (no look) first, then every registered look. */
export function lookItems(): LookItem[] {
  return [{ ...ORIGINAL_LOOK, tags: ['none', 'no look', 'plain', 'reset'] }, ...lookRegistry.list()]
}

/**
 * The look a picker shows as chosen: its id, ORIGINAL_LOOK.id when the video has no look layer, or undefined when the
 * look layer did not come from a registered look (a director draft's grade).
 */
export function chosenLookId(project: Project): string | undefined {
  const current = currentLook(project)
  return current ? current.lookId : ORIGINAL_LOOK.id
}

function undoAction(label: string) {
  return {
    label: 'Undo',
    run: () => {
      if (editor.undoLabel() === label) editor.undo()
    },
  }
}

/** Applies a look to the whole video, or removes the look for Original, as one undo step. */
export function chooseLook(id: string): void {
  const project = editor.getProject()
  if (chosenLookId(project) === id) return
  if (id === ORIGINAL_LOOK.id) {
    const label = 'Remove look'
    if (dispatch(removeLookCommands(project), { label }))
      toast('Look removed: the video shows its own colors', undoAction(label))
    return
  }
  const look = lookRegistry.get(id)
  if (!look) return
  const label = `Apply look: ${look.name}`
  if (dispatch(applyLookCommands(project, id), { label }))
    toast(`Look “${look.name}” applied to the whole video`, undoAction(label))
}

/** Color and texture effects are listed as filters. */
const FILTER_CATEGORIES = new Set(['Color', 'Texture'])

/** Effects that need a depth map are added by Assist › 3D camera, which makes one. */
function needsDepth(entry: PluginCatalogEntry): boolean {
  return entry.params.some((p) => p.type === 'image' && p.key === 'depth')
}

export function effectItems(group: 'effects' | 'filters'): PluginCatalogEntry[] {
  return pluginRegistry
    .catalog('effect')
    .filter((e) => !needsDepth(e) && FILTER_CATEGORIES.has(e.category) === (group === 'filters'))
}

export function transitionItems(): PluginCatalogEntry[] {
  return pluginRegistry.catalog('transition')
}

function isPicture(clip: Clip | undefined): clip is VisualClip {
  return !!clip && clip.type !== 'audio'
}

function lockedTracks(project: Project): Set<string> {
  return new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
}

/**
 * The clip a clicked effect goes on: the selected clip or lyric line, else the topmost video or image clip under the
 * playhead, else a visualizer there.
 */
export function effectTarget(
  project: Project,
  selection: Selection,
  playhead: Seconds,
): VisualClip | undefined {
  if (selection.type === 'clip') {
    const clip = project.clips[selection.id]
    if (isPicture(clip)) return clip
  }
  if (selection.type === 'lyric') {
    const line = Object.values(project.clips).find((c) => c.type === 'text' && c.lyricLineId === selection.id)
    if (isPicture(line)) return line
  }
  const locked = lockedTracks(project)
  const order = new Map(project.tracks.map((t, i) => [t.id, i]))
  const under = Object.values(project.clips)
    .filter(
      (c): c is VisualClip =>
        isPicture(c) &&
        c.enabled &&
        !locked.has(c.trackId) &&
        playhead >= c.start &&
        playhead < c.start + c.duration,
    )
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
  return (
    under.find((c) => c.type === 'video' || c.type === 'image') ?? under.find((c) => c.type === 'generator')
  )
}

const effectNamed = (def: { id: string; name: string }) => ({ id: def.id, name: def.name })

/** Adds an effect with its default audio mappings to a clip as one undo step, selecting the clip if asked. */
function putEffect(
  project: Project,
  clip: VisualClip,
  def: { id: string; name: string },
  selectClip: boolean,
) {
  const label = `Add effect: ${def.name}`
  const effect = createEffectInstance(def.id)
  if (!dispatch({ type: 'effect.add', clipId: clip.id, effect }, { label })) return
  if (selectClip) select({ type: 'clip', id: clip.id })
  toast(`“${def.name}” added to ${viewOf(project, clip).name}`, undoAction(label))
}

/** Adds an effect to the effect target, with the effect's default audio mappings, as one undo step. */
export function addEffect(effectId: string): void {
  const def = pluginRegistry.get(effectId)
  if (def?.kind !== 'effect') return
  const project = editor.getProject()
  const { selection, playhead } = get()
  const clip = effectTarget(project, selection, playhead)
  if (!clip) toast(`Select a clip to add “${def.name}” to it`)
  else putEffect(project, clip, effectNamed(def), selection.type === 'none')
}

/** Same tolerance as the compositor's, so a transition put on a cut blends from the clip before it. */
const CUT_TOLERANCE = 1e-3

function clipBefore(project: Project, clip: Clip): Clip | undefined {
  return Object.values(project.clips).find(
    (c) =>
      c.id !== clip.id &&
      c.trackId === clip.trackId &&
      isPicture(c) &&
      c.type !== 'adjustment' &&
      Math.abs(c.start + c.duration - clip.start) < CUT_TOLERANCE,
  )
}

/**
 * Where a clicked transition goes: the start of the selected clip, else the cut nearest the playhead (a video or image
 * clip that directly follows another on its track). `cut` says whether a clip comes right before it.
 */
export function transitionTarget(
  project: Project,
  selection: Selection,
  playhead: Seconds,
): { clip: VisualClip; cut: boolean } | undefined {
  if (selection.type === 'clip') {
    const clip = project.clips[selection.id]
    if (isPicture(clip) && clip.type !== 'adjustment') return { clip, cut: !!clipBefore(project, clip) }
  }
  const locked = lockedTracks(project)
  let best: { clip: VisualClip; distance: number } | undefined
  for (const clip of Object.values(project.clips)) {
    if (clip.type !== 'video' && clip.type !== 'image') continue
    if (!clip.enabled || locked.has(clip.trackId)) continue
    const distance = Math.abs(clip.start - playhead)
    if (best && distance >= best.distance) continue
    if (clipBefore(project, clip)) best = { clip, distance }
  }
  return best && { clip: best.clip, cut: true }
}

/** Puts a transition on the transition target as one undo step. */
export function addTransition(kind: string): void {
  const def = pluginRegistry.get(kind)
  if (def?.kind !== 'transition') return
  const project = editor.getProject()
  const target = transitionTarget(project, get().selection, get().playhead)
  if (!target) toast(`Select a clip to add “${def.name}” to it`)
  else putTransition(project, target, effectNamed(def))
}

/**
 * Puts a transition on a clip's start as one undo step. A transition already there keeps its duration and easing; a
 * new one gets the transition's suggested duration, at most half the clip.
 */
function putTransition(
  project: Project,
  { clip, cut }: { clip: VisualClip; cut: boolean },
  def: { id: string; name: string },
) {
  const fresh = createTransition(def.id)
  const existing = clip.transitionIn
  const value = existing
    ? { ...fresh, duration: existing.duration, easing: existing.easing }
    : { ...fresh, duration: Math.min(fresh.duration, clip.duration / 2) }
  const label = `Add transition: ${def.name}`
  if (!dispatch({ type: 'clip.set', clipId: clip.id, path: ['transitionIn'], value }, { label })) return
  toast(
    cut
      ? `“${def.name}” added to the cut at ${formatTime(clip.start, true)}`
      : `“${def.name}” added to the start of ${viewOf(project, clip).name}`,
    undoAction(label),
  )
}

/** What a library drag carries. */
export interface LibraryItem {
  kind: 'effect' | 'transition'
  id: string
}

/**
 * What a dragged library item would land on, for the timeline to show: a clip's span for an effect, a cut (start
 * equals end) for a transition, or a locked track where nothing lands (`at` is where to say so).
 */
export type LibraryDropHint =
  { trackId: string; start: Seconds; end: Seconds } | { trackId: string; locked: true; at: Seconds }

const isLocked = (project: Project, trackId: string) => !!project.tracks.find((t) => t.id === trackId)?.locked

/** Drag data type of library items; drop targets check for it while dragging, when the data itself is not readable. */
export const LIBRARY_DRAG_TYPE = 'application/x-mv-studio-library'

let dragging: LibraryItem | null = null

export function startLibraryDrag(e: { dataTransfer: DataTransfer | null }, item: LibraryItem): void {
  e.dataTransfer?.setData(LIBRARY_DRAG_TYPE, JSON.stringify(item))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  dragging = item
}

export function endLibraryDrag(): void {
  dragging = null
}

export function isLibraryDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer?.types.includes(LIBRARY_DRAG_TYPE)
}

/** The item a drop carries, if it came from the library. */
export function droppedLibraryItem(e: { dataTransfer: DataTransfer | null }): LibraryItem | null {
  try {
    const item = JSON.parse(e.dataTransfer?.getData(LIBRARY_DRAG_TYPE) || 'null') as LibraryItem | null
    return item && typeof item.id === 'string' ? item : null
  } catch {
    return null
  }
}

/** The clip on a track at `time` that an effect dropped there goes on. */
function clipAt(project: Project, trackId: string, time: Seconds): VisualClip | undefined {
  return Object.values(project.clips).find(
    (c): c is VisualClip =>
      isPicture(c) && c.trackId === trackId && time >= c.start && time < c.start + c.duration,
  )
}

/**
 * Where a transition dropped on a track at `time` goes: the cut at the start or the end of the clip there, whichever
 * is nearer, else that clip's start. Nothing when no clip is there.
 */
function cutAt(
  project: Project,
  trackId: string,
  time: Seconds,
): { clip: VisualClip; cut: boolean } | undefined {
  const under = clipAt(project, trackId, time)
  if (!under || under.type === 'adjustment') return undefined
  const next = Object.values(project.clips).find(
    (c): c is VisualClip =>
      isPicture(c) && c.type !== 'adjustment' && clipBefore(project, c)?.id === under.id,
  )
  const cuts = [clipBefore(project, under) ? under : undefined, next].filter((c) => c !== undefined)
  const nearest = cuts.sort((a, b) => Math.abs(a.start - time) - Math.abs(b.start - time))[0]
  return nearest ? { clip: nearest, cut: true } : { clip: under, cut: false }
}

/** What the item being dragged would land on at `time` on a track. Null when it would land nowhere there. */
export function libraryDropHint(trackId: string, time: Seconds): LibraryDropHint | null {
  const project = editor.getProject()
  if (dragging && isLocked(project, trackId)) return { trackId, locked: true, at: Math.floor(time) }
  if (dragging?.kind === 'effect') {
    const clip = clipAt(project, trackId, time)
    return clip ? { trackId, start: clip.start, end: clip.start + clip.duration } : null
  }
  if (dragging?.kind === 'transition') {
    const target = cutAt(project, trackId, time)
    return target ? { trackId, start: target.clip.start, end: target.clip.start } : null
  }
  return null
}

/** Adds a dropped library item where it was dropped on the timeline, as one undo step. */
export function dropLibraryItem(item: LibraryItem, at: { trackId: string; time: Seconds }): void {
  const project = editor.getProject()
  if (isLocked(project, at.trackId)) {
    toast('Track is locked')
    return
  }
  const def = pluginRegistry.get(item.id)
  if (item.kind === 'effect' && def?.kind === 'effect') {
    const clip = clipAt(project, at.trackId, at.time)
    if (clip) putEffect(project, clip, effectNamed(def), true)
    else toast(`Drop “${def.name}” on a clip`)
  }
  if (item.kind === 'transition' && def?.kind === 'transition') {
    const target = cutAt(project, at.trackId, at.time)
    if (target) putTransition(project, target, effectNamed(def))
    else toast(`Drop “${def.name}” on a cut between two clips`)
  }
}
