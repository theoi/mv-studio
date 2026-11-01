/**
 * Copy, cut, paste, duplicate, delete and select-all for timeline clips (the clip menu and Mod C, X, V, D, A and
 * Delete). The clipboard lives in this tab and keeps the assets its clips use, so clips can also be pasted into another
 * project opened later.
 */
import {
  clipsOnTrack,
  createTrack,
  type Asset,
  type Clip,
  type EditCommand,
  type Project,
  type Track,
} from '../../model/index.ts'
import { plural } from '../format.ts'
import { undoAction } from './library.ts'
import { removeLyricLinesCommands } from './lyrics.ts'
import { dispatch, editor, isLookClip } from './project.ts'
import { revealClips } from './reveal.ts'
import { closeUpMoves } from './ripple.ts'
import { removeTransition } from './transitions.ts'
import { get, select, selectClips, selectedClipIds, toast, type Selection } from './ui.ts'

interface ClipboardContent {
  clips: Clip[]
  assets: Asset[]
  /** The tracks the clips came from: copies go back on them when they are free, or on a new track like them. */
  tracks: Track[]
}

let clipboard: ClipboardContent | null = null

/** Overlaps shorter than this (rounding) do not count. */
const EPS = 1e-3

/** Clips the timeline selects as clips: lyric lines are selected as lines, and audio clips are the song's lane. */
export function isSelectableClip(c: Clip): boolean {
  return c.type !== 'audio' && !(c.type === 'text' && c.lyricLineId)
}

/** A lyric line's clip (its chip on the timeline). */
export const isLyricClip = (c: Clip | undefined): boolean => c?.type === 'text' && !!c.lyricLineId

/**
 * The clips a selection stands for on the timeline: the selected clips, or a selected lyric line's clip (on `trackId`
 * when it has one there), so a lyric chip can join a selection that started on a line.
 */
export function timelineSelectionIds(p: Project, selection: Selection, trackId?: string): string[] {
  if (selection.type !== 'lyric') return selectedClipIds(selection)
  const clips = Object.values(p.clips).filter((c) => c.type === 'text' && c.lyricLineId === selection.id)
  const clip = clips.find((c) => c.trackId === trackId) ?? clips[0]
  return clip ? [clip.id] : []
}

/** Selects these clips; a lyric line's clip alone selects its line, as a click on its chip does. */
export function selectTimelineClips(p: Project, ids: readonly string[]): void {
  const [only] = ids
  const clip = ids.length === 1 && only !== undefined ? p.clips[only] : undefined
  if (clip?.type === 'text' && clip.lyricLineId) select({ type: 'lyric', id: clip.lyricLineId })
  else selectClips(ids)
}

function selectedClips(p: Project): Clip[] {
  return selectedClipIds(get().selection).flatMap((id) => {
    const c = p.clips[id]
    return c ? [c] : []
  })
}

const clipCount = (n: number) => (n === 1 ? 'clip' : `${n} clips`)
const lineCount = (n: number) => (n === 1 ? 'lyric line' : `${n} lyric lines`)

/** For toasts: "1 clip", "2 lyric lines", "1 clip and 2 lyric lines". Lyric chips are named as their lines. */
function clipsCounted(clips: Clip[]): string {
  const lines = clips.filter(isLyricClip).length
  const others = clips.length - lines
  return [others && plural(others, 'clip'), lines && plural(lines, 'lyric line')]
    .filter(Boolean)
    .join(' and ')
}

/** For undo labels: "clip", "2 clips", "2 lyric lines", "1 clip and 1 lyric line". */
function clipsNamed(clips: Clip[]): string {
  const lines = clips.filter(isLyricClip).length
  if (!lines) return clipCount(clips.length)
  return lines === clips.length ? lineCount(lines) : clipsCounted(clips)
}

export function hasClipboard(): boolean {
  return !!clipboard?.clips.length
}

function copy(p: Project, clips: Clip[]): void {
  const assetIds = new Set(clips.flatMap((c) => ('assetId' in c ? [c.assetId] : [])))
  clipboard = {
    clips: structuredClone(clips),
    assets: [...assetIds].flatMap((id) => {
      const a = p.assets[id]
      return a ? [structuredClone(a)] : []
    }),
    tracks: p.tracks.filter((t) => clips.some((c) => c.trackId === t.id)).map((t) => ({ ...t })),
  }
}

/**
 * Removes the clips as one undo step. Lyric chips take their lines out of the lyrics too (removeLyricLinesCommands),
 * so no line is left without its clip. With `closeGaps`, their tracks close up behind them (ripple.ts).
 */
function remove(p: Project, clips: Clip[], verb: 'Cut' | 'Delete', closeGaps = false): boolean {
  const lineIds = [
    ...new Set(clips.flatMap((c) => (c.type === 'text' && c.lyricLineId ? [c.lyricLineId] : []))),
  ]
  const ids = new Set(clips.map((c) => c.id))
  const commands: EditCommand[] = []
  // One clip.remove at the end: the lines' edits can remove a selected clip too (a director's emphasized word).
  for (const cmd of lineIds.length ? removeLyricLinesCommands(p, lineIds) : []) {
    if (cmd.type === 'clip.remove') for (const id of cmd.clipIds) ids.add(id)
    else commands.push(cmd)
  }
  commands.push({ type: 'clip.remove', clipIds: [...ids] })
  const moves = closeGaps ? closeUpMoves(p, clips).filter((m) => !ids.has(m.clipId)) : []
  if (moves.length) commands.push({ type: 'clip.move', moves })
  const closed = moves.length ? ' and close the gap' : ''
  const label = `${verb} ${clipsNamed(clips)}${closed}`
  const ok = dispatch(commands, { label })
  if (!ok) return false
  selectClips([])
  if (verb === 'Delete')
    toast(`Deleted ${clipsCounted(clips)}${moves.length ? ' and closed the gap' : ''}`, undoAction(label))
  return true
}

/** Copies the selected clips; false when no clip is selected. */
export function copySelection(): boolean {
  const p = editor.getProject()
  const clips = selectedClips(p)
  if (!clips.length) return false
  copy(p, clips)
  toast(`Copied ${clipsCounted(clips)}`)
  return true
}

/** Copies the selected clips and removes them, as one undo step; false when no clip is selected. */
export function cutSelection(): boolean {
  const p = editor.getProject()
  const clips = selectedClips(p)
  if (!clips.length) return false
  const previous = clipboard
  copy(p, clips)
  if (!remove(p, clips, 'Cut')) clipboard = previous
  return true
}

/** Removes the selected clips, lyric line or transition; false when none is selected. */
export function deleteSelection(): boolean {
  const selection = get().selection
  if (selection.type === 'transition') {
    removeTransition(selection.id, selection.edge)
    return true
  }
  const p = editor.getProject()
  if (selection.type === 'lyric') {
    const commands = removeLyricLinesCommands(p, [selection.id])
    if (!commands.length) return false
    const label = 'Delete lyric line'
    if (dispatch(commands, { label })) {
      selectClips([])
      toast('Deleted 1 lyric line', undoAction(label))
    }
    return true
  }
  const clips = selectedClips(p)
  if (!clips.length) return false
  remove(p, clips, 'Delete')
  return true
}

/**
 * Removes the selected clips and closes the gaps they leave: the later clips on their tracks move left (Shift Delete).
 * A selected lyric line or transition is deleted as by Delete; lyric lines stay with the vocals.
 */
export function rippleDeleteSelection(): boolean {
  const p = editor.getProject()
  const clips = selectedClips(p)
  if (!clips.length) return deleteSelection()
  remove(p, clips, 'Delete', true)
  return true
}

/** Pastes the clipboard with its first clip at the playhead, keeping the clips' spacing and tracks. */
export function paste(): void {
  if (!clipboard?.clips.length) {
    toast('Copy a clip first, then paste it at the playhead')
    return
  }
  const first = Math.min(...clipboard.clips.map((c) => c.start))
  place(clipboard, 'Paste', Math.max(get().playhead, 0) - first)
}

/**
 * Where "Paste here" at `time` on a track puts the copied clips, from the placement the paste makes: 'here' on that
 * track; otherwise by the usual paste rules, all back on their own tracks ('own'), all on one new track ('new') or on
 * several ('new-tracks'), or a mix ('mixed'). Null when nothing is copied.
 */
export type PasteHereOutcome = 'here' | 'own' | 'new' | 'new-tracks' | 'mixed'

export function pasteHereOutcome(p: Project, trackId: string, time: number): PasteHereOutcome | null {
  if (!clipboard?.clips.length) return null
  const { landings } = plan(p, clipboard, ...pasteHereArgs(p, clipboard, trackId, time))
  const [only] = landings
  if (!only || landings.some((l) => l !== only)) return 'mixed'
  return only === 'new' && landings.length > 1 ? 'new-tracks' : only
}

/** Pastes the clipboard with its first clip at `time`, on `trackId` when it can take them (see pasteHereOutcome). */
export function pasteAt(trackId: string, time: number): void {
  if (!clipboard?.clips.length) return
  place(clipboard, 'Paste', ...pasteHereArgs(editor.getProject(), clipboard, trackId, time))
}

function pasteHereArgs(p: Project, source: ClipboardContent, trackId: string, time: number) {
  const first = Math.min(...source.clips.map((c) => c.start))
  const at = Math.max(0, time)
  return [at - first, hereTrack(p, source.clips, trackId, at)] as const
}

/** The lyrics lane: a track named Lyrics, or one that holds lyric lines. */
const isLyricLane = (p: Project, track: Track) =>
  track.name === 'Lyrics' || clipsOnTrack(p, track.id).some(isLyricClip)

/** The track at `trackId` when all `clips` come from one track, it holds clips like them and is free for them at `time`. */
function hereTrack(p: Project, clips: Clip[], trackId: string, time: number): Track | undefined {
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track || track.locked || new Set(clips.map((c) => c.trackId)).size !== 1) return undefined
  if (track.kind !== (clips[0]?.type === 'audio' ? 'audio' : 'visual')) return undefined
  const there = clipsOnTrack(p, track.id)
  // Not the lyrics lane, and a look lane only for looks.
  if (isLyricLane(p, track)) return undefined
  const looks = clips.every(isLookClip)
  if (there.length ? there.every(isLookClip) !== looks : looks) return undefined
  const first = Math.min(...clips.map((c) => c.start))
  const end = time + Math.max(...clips.map((c) => c.start + c.duration)) - first
  const free = !there.some((c) => c.start < end - EPS && c.start + c.duration > time + EPS)
  return free ? track : undefined
}

/** Copies the selected clips to right after the last of them; false when no clip is selected. */
export function duplicateSelection(): boolean {
  const p = editor.getProject()
  const clips = selectedClips(p)
  if (!clips.length) return false
  const start = Math.min(...clips.map((c) => c.start))
  const end = Math.max(...clips.map((c) => c.start + c.duration))
  place({ clips, assets: [], tracks: p.tracks }, 'Duplicate', end - start)
  return true
}

/**
 * Adds copies of the clips moved by `offset` seconds (see plan), as one undo step, and selects them. Copies of lyric
 * chips are plain text clips, and the toast says so.
 */
function place(source: ClipboardContent, verb: 'Paste' | 'Duplicate', offset: number, onto?: Track): void {
  const { commands, ids } = plan(editor.getProject(), source, offset, onto)
  if (!dispatch(commands, { label: `${verb} ${clipCount(ids.length)}` })) return
  selectClips(ids)
  revealClips(ids)
  const lines = source.clips.filter(isLyricClip).length
  if (!lines) return
  toast(`${verb === 'Paste' ? 'Pasted' : 'Duplicated'} ${clipsCounted(source.clips)} as text`)
}

/**
 * The edits that add copies of the clips moved by `offset` seconds, and where each source track's clips land. They go
 * back on that track when it is unlocked and free over their span ('own'), else on a new track of the same kind and
 * name added above it ('new'). `onto`, already checked by hereTrack, takes the clips of a single source track ('here').
 * Copies of lyric chips are text clips not linked to a line, so they never go back on a lane of lyric lines: a new
 * "Text" track takes them.
 */
function plan(
  p: Project,
  source: ClipboardContent,
  offset: number,
  onto?: Track,
): { commands: EditCommand[]; ids: string[]; landings: ('here' | 'own' | 'new')[] } {
  const commands: EditCommand[] = source.assets
    .filter((a) => !p.assets[a.id])
    .map((asset) => ({ type: 'asset.add', asset }))
  const groups = new Map<string, Clip[]>()
  for (const c of source.clips) groups.set(c.trackId, [...(groups.get(c.trackId) ?? []), c])
  const tracks = [...p.tracks]
  const ids: string[] = []
  const landings: ('here' | 'own' | 'new')[] = []
  for (const [trackId, group] of groups) {
    const start = Math.min(...group.map((c) => c.start)) + offset
    const end = Math.max(...group.map((c) => c.start + c.duration)) + offset
    const own = p.tracks.find((t) => t.id === trackId)
    const lyrics = group.some(isLyricClip)
    const free =
      own &&
      !own.locked &&
      !(lyrics && isLyricLane(p, own)) &&
      !clipsOnTrack(p, own.id).some((c) => c.start < end - EPS && c.start + c.duration > start + EPS)
    let target = onto ?? (free ? own : undefined)
    landings.push(onto ? 'here' : target ? 'own' : 'new')
    if (!target) {
      const like = own ?? source.tracks.find((t) => t.id === trackId)
      const kind = like?.kind ?? (group[0]?.type === 'audio' ? 'audio' : 'visual')
      const name = lyrics ? 'Text' : (like?.name ?? (kind === 'audio' ? 'Audio' : 'Video'))
      target = createTrack(kind, numberedName(tracks, name))
      const at = tracks.findIndex((t) => t.id === trackId)
      const index = at >= 0 ? at : kind === 'audio' ? tracks.length : 0
      tracks.splice(index, 0, target)
      commands.push({ type: 'track.add', track: target, index })
    }
    for (const c of group) {
      const copy: Clip = {
        ...structuredClone(c),
        id: crypto.randomUUID(),
        trackId: target.id,
        start: Math.max(0, c.start + offset),
      }
      if (copy.type === 'text') delete copy.lyricLineId
      ids.push(copy.id)
      commands.push({ type: 'clip.add', clip: copy })
    }
  }
  return { commands, ids, landings }
}

/**
 * "Video 2", "Video 3": a name the other tracks don't have, so a new track can be told apart in the headers. Next to a
 * numbered "Video 1", a new "Video" is numbered too (a track number, 1 to 99, not a name like "Video 2024").
 */
export function numberedName(tracks: readonly Track[], name: string): string {
  const names = new Set(tracks.map((t) => t.name))
  const isNumbered = (n: string) => n.startsWith(`${name} `) && /^[1-9]\d?$/.test(n.slice(name.length + 1))
  if (!names.has(name) && !tracks.some((t) => isNumbered(t.name))) return name
  const base = name.replace(/ \d+$/, '')
  let n = 2
  while (names.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Mod A: every clip on the selected clip's track, or every clip in the project when no clip is selected. */
export function selectAll(): void {
  const p = editor.getProject()
  const { selection } = get()
  const picked = selection.type === 'clip' ? p.clips[selection.id] : undefined
  const clips = Object.values(p.clips)
    .filter((c) => isSelectableClip(c) && (!picked || c.trackId === picked.trackId))
    .sort((a, b) => a.start - b.start)
  selectClips(clips.map((c) => c.id))
}
