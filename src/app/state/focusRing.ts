/*
 * Whether the focused element got its focus ring, read when it receives focus. Chrome turns on :focus-visible for the
 * focused element as soon as any key is pressed, so reading it in a keydown handler always says "keyboard".
 */
let ringed: Element | null = null

if (typeof document !== 'undefined')
  document.addEventListener(
    'focusin',
    (e) => {
      ringed = e.target instanceof Element && e.target.matches(':focus-visible') ? e.target : null
    },
    true,
  )

/** True when `el` has focus and was reached with the keyboard (it showed its focus ring when it got focus). */
export function focusedWithRing(el: EventTarget | null): boolean {
  return el !== null && el === ringed && el === document.activeElement
}
