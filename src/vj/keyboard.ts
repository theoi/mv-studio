/**
 * Keyboard input for VJ mode. Listens in the capture phase so pad keys never reach the editor's shortcuts, leaves
 * every Ctrl, Cmd and Alt combination to the browser, ignores keys typed into text fields, and releases held pads
 * when the window loses focus (a key released in another window never sends keyup here).
 */

export interface KeyInput {
  /** Physical key (KeyboardEvent.code). */
  code: string
  shift: boolean
  down: boolean
  repeat: boolean
  /** KeyboardEvent.timeStamp: when the key event happened, in performance.now() milliseconds. */
  timeStamp: number
}

type KeyEventLike = Pick<
  KeyboardEvent,
  'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'timeStamp' | 'target'
>

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'])

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { type?: string }) | null
  if (!el || typeof el !== 'object' || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.has(el.type ?? 'text')
  const role = el.getAttribute?.('role')
  return role === 'textbox' || role === 'combobox'
}

/**
 * The VJ input for a key event, or null when it is not VJ mode's: a key-down with Ctrl, Cmd or Alt held, or typed
 * into a text field. Key-ups always pass, so a pad held when a modifier went down still releases.
 */
export function keyInput(e: KeyEventLike, down: boolean): KeyInput | null {
  if (!e.code) return null
  if (down && (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target))) return null
  return { code: e.code, shift: e.shiftKey, down, repeat: down && e.repeat, timeStamp: e.timeStamp }
}

/**
 * Sends key events from `target` (usually window) to `handle`, which returns true when VJ mode used the key; those
 * events get preventDefault and stopPropagation. `onFocusLost` runs on blur and when the page is hidden.
 */
export function attachKeyboard(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  handle: (input: KeyInput) => boolean,
  onFocusLost: () => void,
): () => void {
  const onKey = (down: boolean) => (event: Event) => {
    const input = keyInput(event as KeyboardEvent, down)
    if (input && handle(input)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const keydown = onKey(true)
  const keyup = onKey(false)
  const visibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onFocusLost()
  }
  target.addEventListener('keydown', keydown, { capture: true })
  target.addEventListener('keyup', keyup, { capture: true })
  target.addEventListener('blur', onFocusLost)
  target.addEventListener('visibilitychange', visibility)
  return () => {
    target.removeEventListener('keydown', keydown, { capture: true })
    target.removeEventListener('keyup', keyup, { capture: true })
    target.removeEventListener('blur', onFocusLost)
    target.removeEventListener('visibilitychange', visibility)
  }
}
