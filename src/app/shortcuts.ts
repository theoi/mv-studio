import { useEffect } from 'react'
import { jumpSection, stepPlayhead } from './state/playback.ts'
import { openImport } from './state/importer.ts'
import { saveNow } from './state/persistence.ts'
import {
  addTextAtPlayhead,
  editor,
  hasSong,
  redo,
  splitAtPlayhead,
  timelineDuration,
  undo,
} from './state/project.ts'
import { get, openAssist, set, toast } from './state/ui.ts'

function isTyping(el: EventTarget | null, mod: boolean) {
  const node = el as HTMLElement | null
  if (!node) return false
  // A color input takes no typing but keeps its keys (Space and Enter open the picker), so only shortcuts with
  // Ctrl or Cmd, such as undo, pass while it is focused.
  if (node.tagName === 'INPUT' && (node as HTMLInputElement).type === 'color') return !mod
  return (
    node.isContentEditable ||
    node.tagName === 'INPUT' ||
    node.tagName === 'TEXTAREA' ||
    node.getAttribute('role') === 'combobox' ||
    // Sliders take the arrow keys, Home and End for their value.
    node.getAttribute('role') === 'slider'
  )
}

/** Global editor shortcuts. Every entry also appears in the command palette and in Settings › Shortcuts. */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = get()
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      if (mod && key === 'k') {
        e.preventDefault()
        if (s.screen === 'editor') set({ paletteOpen: !s.paletteOpen })
        return
      }
      if (mod && key === ',') {
        e.preventDefault()
        set({ dialog: 'settings', settingsPage: 'general' })
        return
      }
      if (s.screen !== 'editor' || s.dialog || s.paletteOpen || s.guideStep !== null) return
      if (isTyping(e.target, mod)) return

      if (mod && key === 'e') {
        e.preventDefault()
        set({ dialog: 'export', exportPhase: 'setup' })
      } else if (mod && key === 'j') {
        e.preventDefault()
        openAssist('home')
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Assist for a change"]')
            ?.focus(),
        )
      } else if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        redo()
      } else if (mod && key === 's') {
        e.preventDefault()
        void saveNow()
      } else if (mod && key === 'b') {
        e.preventDefault()
        set({ libraryOpen: !s.libraryOpen })
      } else if (mod && key === 'i') {
        e.preventDefault()
        openImport()
      } else if (mod && (key === '=' || key === '+')) {
        e.preventDefault()
        set({ pxPerSec: Math.min(80, s.pxPerSec * 1.4) })
      } else if (mod && key === '-') {
        e.preventDefault()
        set({ pxPerSec: Math.max(3, s.pxPerSec / 1.4) })
      } else if (mod) {
        return
      } else if (e.key === ' ') {
        e.preventDefault()
        if (hasSong(editor.getProject())) set({ playing: !s.playing })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        jumpSection(-1)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        jumpSection(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        stepPlayhead(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey)
      } else if (e.key === 'Home') {
        set({ playhead: 0 })
      } else if (e.key === 'End') {
        set({ playhead: timelineDuration(editor.getProject()) - 0.01 })
      } else if (key === 's' && !e.shiftKey) {
        splitAtPlayhead()
      } else if (key === 'n') {
        if (e.shiftKey) {
          set({ beatSnap: !s.beatSnap })
          toast(s.beatSnap ? 'Beat snapping off' : 'Beat snapping on')
        } else {
          set({ snap: !s.snap })
          toast(s.snap ? 'Snapping off' : 'Snapping on')
        }
      } else if (key === 't') {
        addTextAtPlayhead()
      } else if (key === 'm') {
        toast('Marker added')
      } else if (key === 'v' && e.shiftKey) {
        set({ screen: 'vj' })
      } else if (e.key === '?') {
        set({ dialog: 'settings', settingsPage: 'shortcuts' })
      } else if (e.key === 'Escape') {
        set({ selection: { type: 'none' } })
      } else if (key === 'z' && e.shiftKey) {
        set({ pxPerSec: 6 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
