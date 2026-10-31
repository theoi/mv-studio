import styles from './Feedback.module.css'
import { keyName } from './keys.ts'

function formatKeys(keys: string): string[] {
  return keys.split(' ').map(keyName)
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
