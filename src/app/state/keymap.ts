import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  hasClipboard,
  paste,
  rippleDeleteSelection,
  selectAll,
} from './clipboard.ts'
import { focusedWithRing } from './focusRing.ts'
import { openImport } from './importer.ts'
import { saveNow } from './persistence.ts'
import { nudgeLine } from './lyricEdits.ts'
import { addMarkerAtPlayhead } from './markers.ts'
import { jumpSection, stepPlayhead } from './playback.ts'
import { toggleFullscreen, toggleLoop } from './previewControls.ts'
import {
  addTextAtPlayhead,
  editor,
  hasSong,
  redo,
  splitAtPlayhead,
  timelineDuration,
  undo,
} from './project.ts'
import { shuttle, stopShuttle } from './shuttle.ts'
import { get, openAssist, set, setSnap, toast } from './ui.ts'
import { enterVj } from './vj.ts'
import { fitTimeline, zoomBy } from './zoom.ts'

/*
 * The editor's keyboard shortcuts: one table that the key handler (../shortcuts.ts), Settings › Shortcuts and the
 * command palette's key hints all read, so every key listed does what it says.
 */

export type ShortcutGroup = 'General' | 'Playback' | 'Timeline'

export interface Shortcut {
  id: string
  label: string
  group: ShortcutGroup
  /** Kbd notation ("Mod Shift Z", "Shift ←"). The first is the one tooltips and the palette show. */
  keys: readonly string[]
  /** False when it did nothing, so the browser keeps the key (Mod C copies selected text, Backspace deletes). */
  run: () => boolean | void
  /** Works on every screen, over dialogs and the palette, and while typing. */
  anywhere?: boolean
  /** Works while a field or slider in the editor has focus. */
  inFields?: boolean
  /** Runs again while the key is held. */
  repeat?: boolean
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['General', 'Playback', 'Timeline']

const ASK_BOX = 'textarea[aria-label="Ask Assist for a change"]'

function togglePlay() {
  if (stopShuttle()) return
  if (hasSong(editor.getProject())) set((s) => ({ playing: !s.playing }))
}

/** Alt ← →: nudges the selected lyric line by a frame; with no lyric line selected, steps the playhead. */
function nudgeSelectedLine(frames: -1 | 1) {
  const { selection } = get()
  if (selection.type === 'lyric') nudgeLine(selection.id, frames)
  else stepPlayhead(frames, false)
}

/** Mod J: Assist with its Ask box focused. */
export function askAssist() {
  openAssist('home')
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(ASK_BOX)?.focus())
}

/** Alt K: presses the keyframe diamond of the Inspector row that has focus. */
function keyframeFocusedProperty() {
  const row = (document.activeElement as HTMLElement | null)?.closest('[data-field-row]')
  const diamond = row?.querySelector<HTMLButtonElement>(
    'button[data-keyframe], button[aria-label^="Add keyframe:"]',
  )
  if (diamond && !diamond.disabled) diamond.click()
  else toast('Click a value in the Inspector, then press Alt K to keyframe it')
}

export const SHORTCUTS = [
  {
    id: 'palette',
    label: 'Command palette',
    group: 'General',
    keys: ['Mod K'],
    anywhere: true,
    run: () => {
      const s = get()
      if (s.screen === 'editor') set({ paletteOpen: !s.paletteOpen })
    },
  },
  {
    id: 'ask',
    label: 'Ask Assist',
    group: 'General',
    keys: ['Mod J'],
    run: askAssist,
  },
  { id: 'undo', label: 'Undo', group: 'General', keys: ['Mod Z'], repeat: true, run: undo },
  { id: 'redo', label: 'Redo', group: 'General', keys: ['Mod Shift Z', 'Mod Y'], repeat: true, run: redo },
  {
    id: 'save',
    label: 'Save now',
    group: 'General',
    keys: ['Mod S'],
    run: () => void saveNow(),
  },
  { id: 'import', label: 'Import media', group: 'General', keys: ['Mod I'], run: () => openImport() },
  {
    id: 'export',
    label: 'Export',
    group: 'General',
    keys: ['Mod E'],
    run: () => set({ dialog: 'export', exportPhase: 'setup' }),
  },
  {
    id: 'settings',
    label: 'Settings',
    group: 'General',
    keys: ['Mod ,'],
    anywhere: true,
    run: () => set({ dialog: 'settings', settingsPage: 'general' }),
  },
  {
    id: 'library',
    label: 'Show or hide the library',
    group: 'General',
    keys: ['Mod B'],
    run: () => set((s) => ({ libraryOpen: !s.libraryOpen })),
  },
  { id: 'vj', label: 'VJ mode', group: 'General', keys: ['Shift V'], run: enterVj },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    group: 'General',
    keys: ['?'],
    run: () => set({ dialog: 'settings', settingsPage: 'shortcuts' }),
  },
  {
    id: 'escape',
    label: 'Close, cancel, deselect',
    group: 'General',
    keys: ['Esc'],
    run: () => {
      if (document.fullscreenElement) {
        void document.exitFullscreen()
        return
      }
      stopShuttle()
      // With the split tool in hand, Esc puts it down first; the next Esc deselects.
      if (get().tool === 'split') set({ tool: 'select' })
      else set({ selection: { type: 'none' } })
    },
  },

  { id: 'play', label: 'Play / pause', group: 'Playback', keys: ['Space', 'K'], run: togglePlay },
  { id: 'shuttleBack', label: 'Shuttle back', group: 'Playback', keys: ['J'], run: () => shuttle(-1) },
  { id: 'shuttleForward', label: 'Shuttle forward', group: 'Playback', keys: ['L'], run: () => shuttle(1) },
  {
    id: 'frameBack',
    label: 'Frame back',
    group: 'Playback',
    keys: ['←'],
    repeat: true,
    run: () => stepPlayhead(-1, false),
  },
  {
    id: 'frameForward',
    label: 'Frame forward',
    group: 'Playback',
    keys: ['→'],
    repeat: true,
    run: () => stepPlayhead(1, false),
  },
  {
    id: 'beatBack',
    label: 'Previous beat',
    group: 'Playback',
    keys: ['Shift ←'],
    repeat: true,
    run: () => stepPlayhead(-1, true),
  },
  {
    id: 'beatForward',
    label: 'Next beat',
    group: 'Playback',
    keys: ['Shift →'],
    repeat: true,
    run: () => stepPlayhead(1, true),
  },
  {
    id: 'sectionBack',
    label: 'Previous section',
    group: 'Playback',
    keys: ['↑'],
    repeat: true,
    run: () => jumpSection(-1),
  },
  {
    id: 'sectionForward',
    label: 'Next section',
    group: 'Playback',
    keys: ['↓'],
    repeat: true,
    run: () => jumpSection(1),
  },
  {
    id: 'start',
    label: 'Go to the start',
    group: 'Playback',
    keys: ['Home'],
    run: () => set({ playhead: 0 }),
  },
  {
    id: 'end',
    label: 'Go to the end',
    group: 'Playback',
    keys: ['End'],
    run: () => set({ playhead: timelineDuration(editor.getProject()) - 0.01 }),
  },
  { id: 'loop', label: 'Loop playback', group: 'Playback', keys: ['Mod L'], run: toggleLoop },
  { id: 'fullscreen', label: 'Full-screen preview', group: 'Playback', keys: ['F'], run: toggleFullscreen },

  { id: 'split', label: 'Split at playhead', group: 'Timeline', keys: ['S'], run: splitAtPlayhead },
  {
    id: 'selectTool',
    label: 'Select tool',
    group: 'Timeline',
    keys: ['V'],
    run: () => set({ tool: 'select' }),
  },
  {
    id: 'snap',
    label: 'Snapping',
    group: 'Timeline',
    keys: ['N'],
    run: () => setSnap('snap', !get().snap),
  },
  {
    id: 'beatSnap',
    label: 'Beat snapping',
    group: 'Timeline',
    keys: ['Shift N'],
    run: () => setSnap('beatSnap', !get().beatSnap),
  },
  { id: 'copy', label: 'Copy', group: 'Timeline', keys: ['Mod C'], run: copySelection },
  { id: 'cut', label: 'Cut', group: 'Timeline', keys: ['Mod X'], run: cutSelection },
  {
    id: 'paste',
    label: 'Paste at playhead',
    group: 'Timeline',
    keys: ['Mod V'],
    run: () => {
      if (!hasClipboard()) return false
      paste()
    },
  },
  // Mod D and Mod A always stay in the editor: the browser would bookmark the page or select its text.
  {
    id: 'duplicate',
    label: 'Duplicate',
    group: 'Timeline',
    keys: ['Mod D'],
    run: () => void duplicateSelection(),
  },
  { id: 'delete', label: 'Delete', group: 'Timeline', keys: ['Delete', 'Backspace'], run: deleteSelection },
  {
    id: 'rippleDelete',
    label: 'Delete and close gap',
    group: 'Timeline',
    keys: ['Shift Delete', 'Shift Backspace'],
    run: rippleDeleteSelection,
  },
  { id: 'selectAll', label: 'Select all on the track', group: 'Timeline', keys: ['Mod A'], run: selectAll },
  { id: 'text', label: 'Add text', group: 'Timeline', keys: ['T'], run: addTextAtPlayhead },
  {
    id: 'marker',
    label: 'Add marker',
    group: 'Timeline',
    keys: ['M'],
    run: () => void addMarkerAtPlayhead(),
  },
  {
    id: 'keyframe',
    label: 'Add or remove a keyframe on the focused property',
    group: 'Timeline',
    keys: ['Alt K'],
    inFields: true,
    run: keyframeFocusedProperty,
  },
  {
    id: 'nudgeEarlier',
    label: 'Nudge lyric line a frame earlier',
    group: 'Timeline',
    keys: ['Alt ←'],
    repeat: true,
    run: () => nudgeSelectedLine(-1),
  },
  {
    id: 'nudgeLater',
    label: 'Nudge lyric line a frame later',
    group: 'Timeline',
    keys: ['Alt →'],
    repeat: true,
    run: () => nudgeSelectedLine(1),
  },
  {
    id: 'zoomIn',
    label: 'Zoom in',
    group: 'Timeline',
    keys: ['Mod +'],
    repeat: true,
    run: () => zoomBy(1.4),
  },
  {
    id: 'zoomOut',
    label: 'Zoom out',
    group: 'Timeline',
    keys: ['Mod −'],
    repeat: true,
    run: () => zoomBy(1 / 1.4),
  },
  { id: 'zoomFit', label: 'Zoom to fit', group: 'Timeline', keys: ['Shift Z'], run: fitTimeline },
] as const satisfies readonly Shortcut[]

export type ShortcutId = (typeof SHORTCUTS)[number]['id']

/** Keys held during a pointer gesture: listed in Settings › Shortcuts, never matched by the key handler. */
export interface GestureShortcut {
  id: string
  label: string
  group: ShortcutGroup
  keys: readonly string[]
}

export const GESTURES: readonly GestureShortcut[] = [
  { id: 'insertDrag', label: 'Insert while dragging a clip (hold)', group: 'Timeline', keys: ['Mod'] },
]

/** The keys tooltips and the palette show for a shortcut. */
export function keysOf(id: ShortcutId): string {
  return SHORTCUTS.find((s) => s.id === id)?.keys[0] ?? ''
}

export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

const NAMED_KEYS: Record<string, string> = {
  '←': 'arrowleft',
  '→': 'arrowright',
  '↑': 'arrowup',
  '↓': 'arrowdown',
  '−': '-',
  Space: ' ',
  Esc: 'escape',
  Home: 'home',
  End: 'end',
  Delete: 'delete',
  Backspace: 'backspace',
}

/** True when a key press is the given keys in Kbd notation. Mod is Ctrl or ⌘. */
export function matchesKeys(keys: string, e: KeyLike): boolean {
  const parts = keys.split(' ')
  const last = parts[parts.length - 1] ?? ''
  const key = NAMED_KEYS[last] ?? last.toLowerCase()
  const alt = parts.includes('Alt')
  if ((e.metaKey || e.ctrlKey) !== parts.includes('Mod') || e.altKey !== alt) return false
  // Typed with Shift on most layouts, so Shift is not part of these keys.
  if (key === '?') return e.key === '?'
  if (key === '+') return e.key === '+' || e.key === '='
  if (e.shiftKey !== parts.includes('Shift')) return false
  // With Alt, macOS types another character (Alt K types ˚), so a letter is matched by its physical key.
  if (alt && /^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`
  return e.key.toLowerCase() === key
}

/** Controls that Space presses when they have focus. */
const SPACE_CONTROLS = [
  'button',
  'a[href]',
  ...[
    'button',
    'checkbox',
    'switch',
    'tab',
    'menuitem',
    'menuitemradio',
    'menuitemcheckbox',
    'option',
    'radio',
  ].map((role) => `[role="${role}"]`),
].join(', ')

/**
 * True when Space belongs to the focused control rather than to play / pause: the control was reached with the
 * keyboard (it got its focus ring), so Space presses it as on any page. After a click on a control, Space plays or
 * pauses, and so it does on elements marked `data-space-plays` (timeline clips, where Enter selects).
 */
export function spaceGoesToControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    focusedWithRing(target) &&
    target.matches(SPACE_CONTROLS) &&
    !target.closest('[data-space-plays]')
  )
}

/** The shortcut a key press triggers, if any. */
export function shortcutFor(e: KeyLike): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.keys.some((k) => matchesKeys(k, e)))
}
