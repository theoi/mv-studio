/**
 * Library items and what adding one does: the looks, effects, transitions, visuals, kinetic presets and text styles the
 * Library tabs list, where a clicked item lands, the one undoable edit it makes, and the toast that says so.
 */
import { pluginRegistry } from '../../engine/registry.ts'
import type { GeneratorDefinition, PluginCatalogEntry } from '../../engine/types.ts'
import {
  createTrack,
  type Clip,
  type EditCommand,
  type Id,
  type Project,
  type Seconds,
  type TextClip,
  type VisualClip,
} from '../../model/index.ts'
import { createEffectInstance, createGeneratorClip, createTransition } from '../../plugins/library.ts'
import {
  applyLookCommands,
  currentLook,
  lookPaletteParams,
  lookRegistry,
  ORIGINAL_LOOK,
  removeLookCommands,
} from '../../plugins/looks.ts'
import {
  TEXT_STYLES,
  textStyle,
  textStyleCommands,
  type TextStylePreset,
} from '../../plugins/typography/styles.ts'
import { formatTime, plural } from '../format.ts'
import { dispatch, editor, sectionAt, timelineDuration, viewOf } from './project.ts'
import { get, select, selectedClipIds, set, toast, type Selection } from './ui.ts'

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

/** A toast action that undoes the edit only while it is still the last one. */
export function undoAction(label: string) {
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

/** Opens Library › Effects with focus on the current look's tile, for the inspector's Change buttons. */
export function revealLooks(): void {
  set({ libraryTab: 'effects', libraryOpen: true })
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-look-tile][aria-pressed="true"]')?.focus(),
  )
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

/** Rows of tiles a library group shows until it is expanded. */
export const GROUP_ROWS = 2

/** Shows all of a library group's items, or only its first rows again. */
export function toggleLibraryGroup(group: string): void {
  set((s) => ({
    libraryExpanded: s.libraryExpanded.includes(group)
      ? s.libraryExpanded.filter((g) => g !== group)
      : [...s.libraryExpanded, group],
  }))
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
  kind: 'effect' | 'transition' | 'visual'
  id: string
}

/**
 * What a dragged library item would land on, for the timeline to show: a clip's span for an effect, a cut (start
 * equals end) for a transition, the span a visual would fill, or a locked track where nothing lands (`at` is where
 * to say so).
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
  if (dragging?.kind === 'visual') {
    const span = visualDrop(project, trackId, time)
    return span ? { trackId, start: span.start, end: span.start + span.duration } : null
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
  if (item.kind === 'visual' && def?.kind === 'generator') {
    const span = visualDrop(project, at.trackId, at.time)
    if (span) putVisual(project, def, { ...span, trackId: at.trackId })
    else toast(`Drop “${def.name}” on an empty part of a track`)
  }
}

/** Visualizers (bars, waveforms, particles) and shader visuals (scenes and backgrounds). */
export function visualItems(group: 'visualizers' | 'shaders'): PluginCatalogEntry[] {
  return pluginRegistry
    .catalog('generator')
    .filter((g) => (g.category === 'Visualizer') === (group === 'visualizers'))
}

/** Items that move with the music out of the box get the "reacts to the music" badge. */
export function isReactive(entry: PluginCatalogEntry): boolean {
  return !!entry.tags?.includes('reactive') || !!entry.defaultModulation
}

/** A visual added at the playhead lasts to the end of the song section there, or this long without sections. */
const VISUAL_SECONDS = 8

/**
 * Where a visual added at `time` goes: from `time` to the end of the song section there (at least 2 s, else 8 s), on
 * the first free unlocked track above the footage that holds neither lyrics nor the look, or a new Visuals track
 * right above the footage.
 */
export function visualPlacement(
  project: Project,
  time: Seconds,
):
  | { start: Seconds; duration: Seconds; trackId: Id }
  | { start: Seconds; duration: Seconds; newTrackIndex: number } {
  const duration = visualDuration(project, time)
  const onTrack = (trackId: Id) => Object.values(project.clips).filter((c) => c.trackId === trackId)
  const footage = project.tracks.findIndex(
    (t) => t.kind === 'visual' && onTrack(t.id).some((c) => c.type === 'video' || c.type === 'image'),
  )
  const firstAudio = project.tracks.findIndex((t) => t.kind === 'audio')
  const below = footage >= 0 ? footage : firstAudio >= 0 ? firstAudio : project.tracks.length
  for (const [index, track] of project.tracks.entries()) {
    if (index >= below) break
    if (track.kind !== 'visual' || track.locked) continue
    const here = onTrack(track.id)
    const busy = here.some((c) => c.start < time + duration && c.start + c.duration > time)
    if (!holdsLyricsOrLook(here) && !busy) return { start: time, duration, trackId: track.id }
  }
  return { start: time, duration, newTrackIndex: below }
}

/** How long a visual added at `time` lasts: to the end of the song section there (at least 2 s), else 8 s. */
function visualDuration(project: Project, time: Seconds): Seconds {
  const section = sectionAt(project, time)
  const end = section && section.end - time >= 2 ? section.end : time + VISUAL_SECONDS
  return Math.max(1, Math.min(end, Math.max(timelineDuration(project), time + 1)) - time)
}

/** A track of lyric lines or of the look layer, which visuals stay off. */
const holdsLyricsOrLook = (clips: Clip[]) =>
  clips.length > 0 &&
  (clips.every((c) => c.type === 'text' && c.lyricLineId) || clips.every((c) => c.type === 'adjustment'))

/**
 * Where a visual dropped on a track at `time` goes: from `time`, as long as a click would make it but ending where
 * the next clip on the track starts, if at least a second is free there. Nothing on a clip, on an audio, lyrics or
 * look track, or on a locked one.
 */
function visualDrop(
  project: Project,
  trackId: Id,
  time: Seconds,
): { start: Seconds; duration: Seconds } | null {
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track || track.kind !== 'visual' || track.locked) return null
  const here = Object.values(project.clips).filter((c) => c.trackId === trackId)
  if (holdsLyricsOrLook(here) || here.some((c) => c.start <= time && c.start + c.duration > time)) return null
  const next = Math.min(...here.filter((c) => c.start > time).map((c) => c.start))
  const end = Math.min(time + visualDuration(project, time), next)
  return end - time >= 1 ? { start: time, duration: end - time } : null
}

/** Adds a visualizer or shader visual at the playhead in the colors of the video's look, as one undo step. */
export function addVisual(generatorId: string): void {
  const def = pluginRegistry.get(generatorId)
  if (def?.kind !== 'generator') return
  const project = editor.getProject()
  putVisual(project, def, visualPlacement(project, get().playhead))
}

function putVisual(
  project: Project,
  def: GeneratorDefinition,
  place: ReturnType<typeof visualPlacement>,
): void {
  const generatorId = def.id
  const commands: EditCommand[] = []
  let trackId: Id
  if ('trackId' in place) trackId = place.trackId
  else {
    const track = createTrack('visual', 'Visuals')
    commands.push({ type: 'track.add', track, index: place.newTrackIndex })
    trackId = track.id
  }
  const clip = {
    ...createGeneratorClip({ trackId, generatorId, start: place.start, duration: place.duration }),
    name: def.name,
  }
  const look = chosenLookId(project)
  const palette = look ? lookRegistry.get(look) : undefined
  if (palette)
    for (const [key, value] of Object.entries(lookPaletteParams(palette, def)))
      clip.params[key] = { ...clip.params[key], value }
  commands.push({ type: 'clip.add', clip })
  const label = `Add visual: ${def.name}`
  if (!dispatch(commands, { label })) return
  select({ type: 'clip', id: clip.id })
  toast(
    `“${def.name}” added from ${formatTime(place.start)} to ${formatTime(place.start + place.duration)}`,
    undoAction(label),
  )
}

/** Clips that show or play a file from the library. */
export function clipsUsing(project: Project, assetId: Id): Clip[] {
  return Object.values(project.clips).filter((c) => 'assetId' in c && c.assetId === assetId)
}

/** How many clips "Remove from project" takes off the timeline with the file, or why it can't remove it. */
export function mediaRemoval(project: Project, assetId: Id): { clips: number } | { why: string } {
  const clips = clipsUsing(project, assetId)
  const locked = lockedTracks(project)
  if (clips.some((c) => locked.has(c.trackId)))
    return {
      why: clips.length === 1 ? 'Its clip is on a locked track' : 'Some of its clips are on a locked track',
    }
  return { clips: clips.length }
}

/**
 * Removes a file from the project with every clip that uses it, as one undo step. The song is not removed this way.
 * The stored file stays in the browser, so Undo can bring it back. False when nothing was removed.
 */
export function removeMedia(assetId: Id): boolean {
  const project = editor.getProject()
  const asset = project.assets[assetId]
  if (!asset || assetId === project.songAssetId) return false
  const removal = mediaRemoval(project, assetId)
  if ('why' in removal) {
    toast(`${removal.why}. Unlock it to remove this file.`)
    return false
  }
  const name = asset.name.replace(/\.[^.]+$/, '')
  const label = `Remove ${name}`
  if (!dispatch({ type: 'asset.remove', assetId }, { label })) return false
  const selection = get().selection
  if (selection.type === 'clip' && !editor.getProject().clips[selection.id])
    set({ selection: { type: 'none' } })
  toast(
    `Removed “${name}”${removal.clips ? ` and its ${plural(removal.clips, 'clip')}` : ''}`,
    undoAction(label),
  )
  return true
}

export function textAnimationItems(): PluginCatalogEntry[] {
  return pluginRegistry.catalog('text-animation')
}

/** Text styles, or the karaoke styles: the ones that light words up as they are sung. */
export function textStyleItems(group: 'styles' | 'karaoke'): TextStylePreset[] {
  return TEXT_STYLES.filter((s) => !!s.karaoke === (group === 'karaoke'))
}

/** Where a clicked kinetic preset or text style goes, or why it can go nowhere. */
export type TextTargets =
  | {
      clipIds: Id[]
      /** Names them for the toast and the note: "“Title”", "this lyric line", "3 texts", "2 lyric lines". */
      what: string
      /**
       * The selected text clip, the selected lyric line, the texts among several selected clips, or every lyric line
       * (nothing is selected).
       */
      scope: 'text' | 'line' | 'several' | 'lyrics'
    }
  | { why: string }

const NO_TEXT = 'Select a text or lyric line, or add text first'
const NOT_TEXT = 'Select a text or lyric line first'
const LOCKED_TEXT = 'That track is locked. Unlock it to restyle this text.'
const LOCKED_TEXTS = 'Their tracks are locked. Unlock them to restyle these texts.'
const LOCKED_LYRICS = 'The Lyrics track is locked. Unlock it to restyle the lyrics.'

const one = (clip: TextClip): TextTargets =>
  clip.lyricLineId
    ? { clipIds: [clip.id], what: 'this lyric line', scope: 'line' }
    : { clipIds: [clip.id], what: `“${clip.name ?? clip.text}”`, scope: 'text' }

/**
 * The text clips a clicked kinetic preset or text style goes on: the selected text clip or lyric line, the texts
 * among several selected clips (skipping those on locked tracks), or every lyric line when nothing is selected
 * (skipping lines on locked tracks). Anything else selected, or selected text only on locked tracks, changes nothing,
 * and `why` says what to do.
 */
export function textTargets(project: Project, selection: Selection): TextTargets {
  const locked = lockedTracks(project)
  const texts = Object.values(project.clips).filter((c): c is TextClip => c.type === 'text')
  const picked = selectedClipIds(selection)
  if (picked.length > 1) {
    const chosen = picked.flatMap((id) => texts.filter((c) => c.id === id))
    if (!chosen.length) return { why: NOT_TEXT }
    const open = chosen.filter((c) => !locked.has(c.trackId))
    if (!open.length) return { why: chosen.length > 1 ? LOCKED_TEXTS : LOCKED_TEXT }
    const [first] = open
    if (open.length === 1 && first) return one(first)
    const lines = open.every((c) => c.lyricLineId)
    return {
      clipIds: open.map((c) => c.id),
      what: plural(open.length, lines ? 'lyric line' : 'text'),
      scope: 'several',
    }
  }
  if (selection.type === 'clip' || selection.type === 'lyric') {
    const selected = texts.find((c) =>
      selection.type === 'clip' ? c.id === selection.id : c.lyricLineId === selection.id,
    )
    if (!selected) return { why: NOT_TEXT }
    if (locked.has(selected.trackId)) return { why: LOCKED_TEXT }
    return one(selected)
  }
  if (selection.type !== 'none') return { why: NOT_TEXT }
  const lines = texts.filter((c) => c.lyricLineId)
  if (!lines.length) return { why: NO_TEXT }
  const open = lines.filter((c) => !locked.has(c.trackId))
  if (!open.length) return { why: LOCKED_LYRICS }
  return { clipIds: open.map((c) => c.id), what: plural(open.length, 'lyric line'), scope: 'lyrics' }
}

/** The note under Add text: where a clicked style would go with this selection, before the click. */
export function textTargetHint(project: Project, selection: Selection): string {
  const t = textTargets(project, selection)
  if ('why' in t) return t.why === NOT_TEXT ? 'Select a text or lyric line to restyle it' : t.why
  if (t.scope === 'lyrics') return 'Click a style to use it on every lyric line'
  return `Click a style to use it on ${t.what}`
}

/** Gives the text targets a kinetic preset as one undo step. */
export function applyTextAnimation(presetId: string): void {
  const def = pluginRegistry.get(presetId)
  if (def?.kind !== 'text-animation') return
  const targets = textTargets(editor.getProject(), get().selection)
  if ('why' in targets) {
    toast(targets.why)
    return
  }
  const label = `Text animation: ${def.name}`
  const commands: EditCommand[] = targets.clipIds.map((clipId) => ({
    type: 'clip.set',
    clipId,
    path: ['animation'],
    value: { presetId, params: {} },
  }))
  if (dispatch(commands, { label })) toast(`“${def.name}” on ${targets.what}`, undoAction(label))
}

/** Whether every one of the clips is a lyric line without word timings, so word karaoke has nothing to light up. */
function wordsUntimed(project: Project, clipIds: Id[]): boolean {
  const lines = new Map((project.lyrics?.lines ?? []).map((l) => [l.id, l]))
  return clipIds.every((id) => {
    const clip = project.clips[id]
    const line = clip?.type === 'text' && clip.lyricLineId ? lines.get(clip.lyricLineId) : undefined
    return clip?.type === 'text' && !!clip.lyricLineId && (line?.start === undefined || !line.words.length)
  })
}

/** Gives the text targets a text style (with its kinetic preset and karaoke, if any) as one undo step. */
export function applyLibraryTextStyle(styleId: string): void {
  const preset = textStyle(styleId)
  if (!preset) return
  const project = editor.getProject()
  const targets = textTargets(project, get().selection)
  if ('why' in targets) {
    toast(targets.why)
    return
  }
  const label = `Text style: ${preset.name}`
  const untimed = preset.karaoke?.mode === 'word' && wordsUntimed(project, targets.clipIds)
  if (dispatch(textStyleCommands(project, targets.clipIds, styleId), { label }))
    toast(
      `“${preset.name}” on ${targets.what}${untimed ? ' · Time the words to see it' : ''}`,
      undoAction(label),
    )
}
