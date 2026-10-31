import styles from './Feedback.module.css'

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const glyphs: Record<string, string> = isMac
  ? { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃', Enter: '↩', Delete: '⌫', Esc: 'Esc' }
  : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl', Enter: 'Enter', Delete: 'Del', Esc: 'Esc' }

function formatKeys(keys: string): string[] {
  return keys.split(' ').map((k) => glyphs[k] ?? k)
}

/** Renders a shortcut such as "Mod K" or "Shift ←" with platform-correct key names. */
export function Kbd({ keys, tone = 'default' }: { keys: string; tone?: 'default' | 'onAccent' }) {
  return (
    <span className={[styles.kbdGroup, tone === 'onAccent' && styles.kbdOnAccent].filter(Boolean).join(' ')}>
      {formatKeys(keys).map((k, i) => (
        <kbd key={i} className={styles.kbd}>
          {k}
        </kbd>
      ))}
    </span>
  )
}
