import { useSyncExternalStore } from 'react'
import {
  EditError,
  ProjectEditor,
  clipsAt,
  createProject,
  createTextClip,
  createTrack,
  projectDuration,
  type AudioAnalysis,
  type Clip,
  type DispatchOptions,
  type EditCommand,
  type LyricLine,
  type Project,
  type SongSection,
} from '../../model/index.ts'
import { TRACK_IDS, buildDemoProject, sceneOf } from '../mock/demoProject.ts'
import type { SceneId } from '../mock/art.ts'
import { editorPreset, get, maybeStartGuide, select, set, toast, type Kind } from './ui.ts'

/** The app's single editor. The design preview starts it with the demo project. */
export const editor = new ProjectEditor(buildDemoProject())

export function useProject(): Project {
  return useSyncExternalStore(editor.subscribe, editor.getProject)
}

export function loadDemoProject() {
  editor.load(buildDemoProject())
}

export function loadEmptyProject() {
  editor.load(createProject({ name: 'Untitled video' }))
}

/** Replaces an empty project with the sample project, keeping the current workspace. */
export function loadSample() {
  loadDemoProject()
  set({ playhead: 0, playing: false, selection: { type: 'none' } })
  toast(`Sample project loaded: “${editor.getProject().name}”`)
}

/** Opens the editor for a video kind with the demo project (or an empty one) and its workspace preset. */
export function openEditor(kind: Kind, empty = false) {
  if (empty) loadEmptyProject()
  else loadDemoProject()
  set({ ...editorPreset(kind), ...(empty ? { playhead: 0 } : {}) })
  maybeStartGuide()
}

/** Dispatches through the editor and turns rejected edits (locked track, invalid input) into a toast. */
export function dispatch(commands: EditCommand | EditCommand[], options?: DispatchOptions): boolean {
  try {
    editor.dispatch(commands, options)
    return true
  } catch (error) {
    if (error instanceof EditError) {
      toast(error.code === 'locked' ? 'That track is locked. Unlock it to edit.' : error.message)
      return false
    }
    throw error
  }
}

export function undo() {
  const label = editor.undoLabel()
  if (editor.undo()) toast(`Undid: ${label}`)
  else toast('Nothing to undo')
}

export function redo() {
  const label = editor.redoLabel()
  if (editor.redo()) toast(`Redid: ${label}`)
  else toast('Nothing to redo')
}

/** Splits the selected clip, or the video clip under the playhead, at the playhead. */
export function splitAtPlayhead() {
  const p = editor.getProject()
  const { playhead: t, selection } = get()
  const inside = (c: Clip) => t > c.start + 0.02 && t < c.start + c.duration - 0.02
  const selected = selection.type === 'clip' ? p.clips[selection.id] : undefined
  const target =
    selected && inside(selected)
      ? selected
      : clipsAt(p, t).find((c) => (c.type === 'video' || c.type === 'image') && inside(c))
  if (!target) {
    toast('Move the playhead over a clip to split it')
    return
  }
  dispatch(
    { type: 'clip.split', clipId: target.id, time: t, newClipId: crypto.randomUUID() },
    { label: 'Split clip' },
  )
}

/** Adds a text clip at the playhead on the first free overlay track, adding a Text track when none is free. */
export function addTextAtPlayhead() {
  const p = editor.getProject()
  const start = get().playhead
  const duration = 4
  const busy = (trackId: string) =>
    Object.values(p.clips).some(
      (c) => c.trackId === trackId && c.start < start + duration && c.start + c.duration > start,
    )
  const candidates = p.tracks.filter((tr) => tr.kind === 'visual' && !tr.locked && tr.id !== TRACK_IDS.lyrics)
  let track = candidates.find((tr) => !busy(tr.id))
  const commands: EditCommand[] = []
  if (!track) {
    track = createTrack('visual', 'Text')
    const lyricsIndex = p.tracks.findIndex((tr) => tr.id === TRACK_IDS.lyrics)
    commands.push({ type: 'track.add', track, index: lyricsIndex + 1 })
  }
  const clip = { ...createTextClip({ trackId: track.id, text: 'Your text', start, duration }), name: 'Text' }
  commands.push({ type: 'clip.add', clip })
  if (dispatch(commands, { label: 'Add text' })) select({ type: 'clip', id: clip.id })
}

export function songAnalysis(p: Project): AudioAnalysis | undefined {
  return p.songAssetId ? p.analysis.audio[p.songAssetId] : undefined
}

export function hasSong(p: Project): boolean {
  return !!p.songAssetId
}

export function timelineDuration(p: Project): number {
  return Math.max(projectDuration(p), 1)
}

export type SectionKind = 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'outro'

/** Color family for a section, from its label. Repeat groups say nothing about the kind: verses repeat too. */
export function sectionKind(s: SongSection): SectionKind {
  const l = s.label.toLowerCase()
  if (l.includes('pre')) return 'pre'
  if (l.includes('chorus') || l.includes('hook')) return 'chorus'
  if (l.includes('bridge')) return 'bridge'
  if (l.includes('intro')) return 'intro'
  if (l.includes('outro') || l.includes('end')) return 'outro'
  return 'verse'
}

export const sectionColor: Record<SectionKind, string> = {
  intro: 'var(--section-intro)',
  verse: 'var(--section-verse)',
  pre: 'var(--section-pre)',
  chorus: 'var(--section-chorus)',
  bridge: 'var(--section-bridge)',
  outro: 'var(--section-outro)',
}

export function sectionsOf(p: Project): SongSection[] {
  return songAnalysis(p)?.sections ?? []
}

export function sectionAt(p: Project, t: number): SongSection | undefined {
  const list = sectionsOf(p)
  return list.find((s) => t >= s.start && t < s.end) ?? list[list.length - 1]
}

export function energyAt(a: AudioAnalysis | undefined, t: number): number {
  const e = a?.energy
  if (!e || !e.values.length) return 0.4
  return e.values[Math.max(0, Math.min(e.values.length - 1, Math.floor(t * e.rate)))] ?? 0.4
}

export function bpmOf(p: Project): number | undefined {
  return songAnalysis(p)?.tempo?.bpm
}

export function lyricLines(p: Project): LyricLine[] {
  return p.lyrics?.lines ?? []
}

export function lyricAt(p: Project, t: number): LyricLine | undefined {
  return lyricLines(p).find(
    (l) => l.start !== undefined && l.end !== undefined && t >= l.start - 0.15 && t < l.end + 0.35,
  )
}

export type ClipKindView = 'video' | 'image' | 'text' | 'lyric' | 'visualizer' | 'audio' | 'other'

export interface ClipView {
  id: string
  trackId: string
  kind: ClipKindView
  name: string
  start: number
  end: number
  scene?: SceneId
  lyricLineId?: string
}

export function viewOf(p: Project, c: Clip): ClipView {
  const base = { id: c.id, trackId: c.trackId, start: c.start, end: c.start + c.duration }
  switch (c.type) {
    case 'video':
    case 'image': {
      const a = p.assets[c.assetId]
      return { ...base, kind: c.type, name: c.name ?? a?.name ?? 'Clip', scene: sceneOf(a) }
    }
    case 'text':
      return c.lyricLineId
        ? { ...base, kind: 'lyric', name: c.text, lyricLineId: c.lyricLineId }
        : { ...base, kind: 'text', name: c.name ?? c.text }
    case 'generator':
      return { ...base, kind: 'visualizer', name: c.name ?? c.generatorId }
    case 'audio':
      return { ...base, kind: 'audio', name: c.name ?? p.assets[c.assetId]?.name ?? 'Audio' }
    default:
      return { ...base, kind: 'other', name: c.name ?? c.type }
  }
}
