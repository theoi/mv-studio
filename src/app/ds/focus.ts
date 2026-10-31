import { useRef } from 'react'

/** The control a dialog opened from: the trigger of the menu it was picked in, else what had focus. */
function focusOrigin(): HTMLElement | null {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body) return null
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
    onOpenAutoFocus: () => {
      origin.current = focusOrigin()
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
