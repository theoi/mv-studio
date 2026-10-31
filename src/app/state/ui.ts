import { create } from 'zustand'

/*
 * UI-only state: which screen, panel, dialog and selection is showing, plus view settings such as zoom. Project
 * content lives in the ProjectEditor (./project.ts) and long tasks in the JobRunner (./jobs.ts).
 */

export type Screen = 'start' | 'setup' | 'editor' | 'vj'
export type Kind = 'lyric' | 'visualizer' | 'footage' | 'ai' | 'blank'
export type Selection =
  | { type: 'none' }
  | { type: 'clip'; id: string }
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

export interface Toast {
  id: number
  message: string
  action?: { label: string; run: () => void }
}

export interface UiState {
  screen: Screen
  kind: Kind
  setupSong: boolean
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
  playhead: number
  playing: boolean
  pxPerSec: number
  snap: boolean
  beatSnap: boolean
  showEnergy: boolean
  review: boolean
  dismissed: string[]
  /** Mock of a matte on the lyric clips; the real feature writes Matte data to the project. */
  behindSubject: boolean
  toasts: Toast[]
}

export const initialUi: UiState = {
  screen: 'start',
  kind: 'lyric',
  setupSong: false,
  selection: { type: 'none' },
  rightTab: 'inspector',
  assistView: 'home',
  dialog: null,
  settingsPage: 'ai',
  exportPhase: 'setup',
  paletteOpen: false,
  guideStep: null,
  libraryTab: 'media',
  libraryOpen: true,
  playhead: 73.6,
  playing: false,
  pxPerSec: 12,
  snap: true,
  beatSnap: true,
  showEnergy: true,
  review: true,
  dismissed: [],
  behindSubject: false,
  toasts: [],
}

export const useUi = create<UiState>(() => initialUi)

export const set = useUi.setState
export const get = useUi.getState

let toastId = 1
export function toast(message: string, action?: Toast['action']) {
  const id = toastId++
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, action }] }))
  window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5200)
}

export function select(selection: Selection) {
  set({ selection, rightTab: 'inspector' })
}

export function openAssist(view: AssistView = 'home') {
  set({ rightTab: 'assist', assistView: view })
}

const GUIDE_SEEN_KEY = 'mv-studio.guide-seen'

/** Opens the editor with the workspace preset for a video kind; first-time users get the guide. */
export function editorPreset(kind: Kind): Partial<UiState> {
  const preset: Partial<UiState> = {
    screen: 'editor',
    kind,
    selection: { type: 'none' },
    dialog: null,
    paletteOpen: false,
    playhead: 73.6,
  }
  if (kind === 'lyric')
    Object.assign(preset, { libraryTab: 'text', rightTab: 'assist', assistView: 'lyrics' })
  if (kind === 'visualizer')
    Object.assign(preset, {
      libraryTab: 'visuals',
      rightTab: 'inspector',
      selection: { type: 'clip', id: 'o-spec1' },
      playhead: 86.3,
    })
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
