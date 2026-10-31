const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const names: Record<string, string> = isMac
  ? { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃', Enter: '↩', Delete: '⌫', Esc: 'Esc' }
  : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl', Enter: 'Enter', Delete: 'Del', Esc: 'Esc' }

/** The platform's name or symbol for a key of a shortcut such as "Mod K": "Mod" is ⌘ on a Mac and Ctrl elsewhere. */
export function keyName(key: string): string {
  return names[key] ?? key
}
