import { useEffect } from 'react'
import { shortcutFor, spaceGoesToControl } from './state/keymap.ts'
import { get } from './state/ui.ts'

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
    // Sliders take the arrow keys, Home and End for their value; shortcuts with Ctrl or Cmd, such as undo, pass.
    (node.getAttribute('role') === 'slider' && !mod)
  )
}

function isTextBox(el: EventTarget | null) {
  const node = el as HTMLElement | null
  return !!node && (node.isContentEditable || node.tagName === 'TEXTAREA')
}

// Open selects, menus and popovers handle their own keys (Esc closes them, arrows move, Space picks).
const LAYERS = '[role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]'

function inLayer(el: EventTarget | null) {
  return el instanceof Element && !!el.closest(LAYERS)
}

/** Global editor shortcuts from the shortcut table (state/keymap.ts). */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Radix layers (select, menu, popover, dialog) prevent the default of the keys they handle, such as Esc.
      if (e.defaultPrevented) return
      const shortcut = shortcutFor(e)
      if (!shortcut) return
      // Left to the browser without preventDefault, so the focused control is pressed.
      if (e.key === ' ' && spaceGoesToControl(e.target)) return
      if (!shortcut.anywhere) {
        const s = get()
        if (s.screen !== 'editor' || s.dialog || s.paletteOpen || s.guideStep !== null) return
        if (inLayer(e.target)) return
        const mod = e.metaKey || e.ctrlKey
        if (shortcut.inFields ? isTextBox(e.target) : isTyping(e.target, mod)) return
      }
      if (e.repeat && !shortcut.repeat) {
        e.preventDefault()
        return
      }
      // False leaves the key to the browser: Mod C with no clips selected copies selected text.
      if (shortcut.run() !== false) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
