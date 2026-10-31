import { create } from 'zustand'
import { prefs } from './prefs.ts'

/*
 * UI-only state: which screen, panel, dialog and selection is showing, plus view settings such as zoom. Project
 * content lives in the ProjectEditor (./project.ts) and long tasks in the JobRunner (./jobs.ts).
 */

export type Screen = 'start' | 'setup' | 'editor' | 'vj'
export type Kind = 'lyric' | 'visualizer' | 'footage' | 'ai' | 'blank'
export type Selection =
  | { type: 'none' }
  /** `ids` lists every selected clip when there are several; `id` is the one picked last. */
  | { type: 'clip'; id: string; ids?: string[] }
  | { type: 'lyric'; id: string }
  | { type: 'section'; id: string }
export type RightTab = 'inspector' | 'assist'
export type AssistView =
  | 'home'
  | 'director'
  | 'autocut'
  | 'lyrics'
  | 'stems'
  | 'behind'
  | 'camera'
  | 'match'
  | 'generate'
  | 'analysis'
export type DialogName = null | 'export' | 'settings'
export type LibraryTab = 'media' | 'text' | 'visuals' | 'effects'
export type SettingsPage = 'general' | 'editing' | 'ai' | 'local' | 'shortcuts' | 'vj' | 'storage' | 'about'
export type ExportPhase = 'setup' | 'exporting'
export type TimelineTool = 'select' | 'split'
/** The preview fitted to its area, or at a fraction of the project's pixels (1 = 100%). */
export type PreviewZoom = 'fit' | number

export interface Toast {
  id: number
  message: string
  action?: { label: string; run: () => void }
  /** Selects what an automatic or AI tool just made. The toast stays, so Undo is still at hand. */
  show?: () => void
}

export interface UiState {
  screen: Screen
  kind: Kind
  selection: Selection
  rightTab: RightTab
  assistView: AssistView
  dialog: DialogName
  settingsPage: SettingsPage
  exportPhase: ExportPhase
  paletteOpen: boolean
  guideStep: number | null
  libraryTab: LibraryTab
  libraryOpen: boolean
  /** Library groups showing all their items instead of the first rows, for this session. */
  libraryExpanded: string[]
  playhead: number
  playing: boolean
  /** Play was pressed and the preview is still loading audio. */
  starting: boolean
  /** Playback repeats the section under the playhead (see loopRange in ./previewControls.ts). */
  loop: boolean
  previewZoom: PreviewZoom
  pxPerSec: number
  tool: TimelineTool
  snap: boolean
  beatSnap: boolean
  showEnergy: boolean
  review: boolean
  dismissed: string[]
  toasts: Toast[]
}

const LIBRARY_OPEN_KEY = 'mv-studio.library-open'

function storedLibraryOpen(): boolean {
  try {
    return localStorage.getItem(LIBRARY_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export const initialUi: UiState = {
  screen: 'start',
  kind: 'lyric',
  selection: { type: 'none' },
  rightTab: 'inspector',
  assistView: 'home',
  dialog: null,
  settingsPage: 'ai',
  exportPhase: 'setup',
  paletteOpen: false,
  guideStep: null,
  libraryTab: 'media',
  libraryOpen: storedLibraryOpen(),
  libraryExpanded: [],
  playhead: 73.6,
  playing: false,
  starting: false,
  loop: false,
  previewZoom: 'fit',
  pxPerSec: 12,
  tool: 'select',
  snap: true,
  beatSnap: prefs().beatSnap,
  showEnergy: true,
  review: false,
  dismissed: [],
  toasts: [],
}

export const useUi = create<UiState>(() => initialUi)

export const set = useUi.setState
export const get = useUi.getState

useUi.subscribe((s, prev) => {
  if (s.libraryOpen === prev.libraryOpen) return
  try {
    localStorage.setItem(LIBRARY_OPEN_KEY, s.libraryOpen ? '1' : '0')
  } catch {
    // Storage can be unavailable (private mode); the panel then just isn't remembered.
  }
})

const TOAST_MS = 5200
let toastId = 1
const toastTimers = new Map<number, number>()

export function toast(message: string, action?: Toast['action'], options: { show?: () => void } = {}) {
  const id = toastId++
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, action, show: options.show }] }))
  releaseToast(id)
}

export function dismissToast(id: number) {
  holdToast(id)
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** Keeps a toast open, while the pointer is on it or focus is in it. */
export function holdToast(id: number) {
  const timer = toastTimers.get(id)
  if (timer === undefined) return
  window.clearTimeout(timer)
  toastTimers.delete(id)
}

/** Gives a toast its full time again, counted from now. */
export function releaseToast(id: number) {
  holdToast(id)
  if (get().toasts.some((t) => t.id === id))
    toastTimers.set(
      id,
      window.setTimeout(() => dismissToast(id), TOAST_MS),
    )
}

export function select(selection: Selection) {
  set({ selection, rightTab: 'inspector' })
}

/** Every selected clip, in the order they were picked. */
export function selectedClipIds(selection: Selection): string[] {
  if (selection.type !== 'clip') return []
  return selection.ids && selection.ids.length > 1 ? selection.ids : [selection.id]
}

/** Selects these clips (the last is the one picked last); an empty list clears the selection. */
export function selectClips(ids: readonly string[]) {
  const last = ids[ids.length - 1]
  if (last === undefined) set({ selection: { type: 'none' } })
  else select(ids.length > 1 ? { type: 'clip', id: last, ids: [...ids] } : { type: 'clip', id: last })
}

export function openAssist(view: AssistView = 'home') {
  set({ rightTab: 'assist', assistView: view })
}

const GUIDE_SEEN_KEY = 'mv-studio.guide-seen'

/** The editor's workspace for a video kind: the library tab and the panel its next step is in. */
export function editorPreset(kind: Kind): Partial<UiState> {
  const preset: Partial<UiState> = {
    screen: 'editor',
    kind,
    selection: { type: 'none' },
    dialog: null,
    paletteOpen: false,
    playhead: 0,
    playing: false,
  }
  if (kind === 'lyric')
    Object.assign(preset, { libraryTab: 'text', rightTab: 'assist', assistView: 'lyrics' })
  if (kind === 'visualizer') Object.assign(preset, { libraryTab: 'visuals', rightTab: 'inspector' })
  if (kind === 'footage')
    Object.assign(preset, { libraryTab: 'media', rightTab: 'assist', assistView: 'autocut' })
  if (kind === 'ai')
    Object.assign(preset, { libraryTab: 'media', rightTab: 'assist', assistView: 'director' })
  if (kind === 'blank') Object.assign(preset, { libraryTab: 'media', rightTab: 'inspector' })
  return preset
}

export function maybeStartGuide() {
  try {
    if (localStorage.getItem(GUIDE_SEEN_KEY)) return
    localStorage.setItem(GUIDE_SEEN_KEY, '1')
  } catch {
    return
  }
  set({ guideStep: 0 })
}
