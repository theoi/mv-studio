import styles from './Common.module.css'

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={styles.logoMark}>
      <rect width="24" height="24" rx="7" fill="var(--accent)" />
      <rect x="6" y="9" width="2.4" height="6" rx="1.2" fill="#fff" opacity="0.75" />
      <rect x="10.8" y="5.5" width="2.4" height="13" rx="1.2" fill="#fff" />
      <rect x="15.6" y="8" width="2.4" height="8" rx="1.2" fill="#fff" opacity="0.85" />
    </svg>
  )
}

export function Logo() {
  return (
    <span className={styles.logo}>
      <LogoMark />
      <span className={styles.wordmark}>MV Studio</span>
    </span>
  )
}
