import { useRef } from 'react'

/**
 * Escape presses that closed a tooltip. Radix gives Escape only to the topmost layer, and a showing tooltip (a focused
 * button's) is one, so the dialog under it would need a second press; `Dialog` closes on these presses too.
 */
const tooltipEscapes = new WeakSet<KeyboardEvent>()

export const tooltipTookEscape = (e: KeyboardEvent) => void tooltipEscapes.add(e)

export const escapeClosedTooltip = (e: KeyboardEvent) => tooltipEscapes.has(e)

/** What opened each open dialog, so a dialog opened from inside another one can go back past it. */
const openedFrom = new WeakMap<Element, HTMLElement>()

/**
 * The control a dialog or the guide was opened from: what had focus, or the trigger of the menu it was picked in.
 * When it was picked inside another dialog (an action run from the command palette), that dialog closes as this one
 * opens, so it is the control that opened that dialog.
 */
export function focusOrigin(): HTMLElement | null {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body) return null
  const dialog = el.closest('[role="dialog"]')
  const before = dialog ? openedFrom.get(dialog) : undefined
  if (before) return before
  const menu = el.closest('[role="menu"]')
  const trigger = menu?.id ? document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`) : null
  return trigger instanceof HTMLElement ? trigger : el
}

/**
 * Radix gives focus back only to a Dialog.Trigger, and these dialogs open from app state, so closing one would leave
 * focus on the page body. This gives it back to the control that opened the dialog, unless something else (a dialog
 * or guide opened in its place) has taken focus by then.
 */
export function useReturnFocus() {
  const origin = useRef<HTMLElement | null>(null)
  return {
    onOpenAutoFocus: (e: Event) => {
      origin.current = focusOrigin()
      if (origin.current && e.currentTarget instanceof Element)
        openedFrom.set(e.currentTarget, origin.current)
    },
    onCloseAutoFocus: (e: Event) => {
      const el = origin.current
      origin.current = null
      const active = document.activeElement
      if (!el?.isConnected || (active && active !== document.body)) return
      e.preventDefault()
      el.focus({ preventScroll: true })
    },
  }
}
