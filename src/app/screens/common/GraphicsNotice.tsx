import { MonitorX } from 'lucide-react'
import { NO_GRAPHICS } from '../../state/graphics.ts'
import { webgl2Available } from '../../../shared/capabilities.ts'
import styles from './GraphicsNotice.module.css'

/** Says that this browser can't show or export videos, where it can't; nothing where it can. */
export function GraphicsNotice({ className }: { className?: string }) {
  if (webgl2Available()) return null
  return (
    <div className={[styles.notice, className].filter(Boolean).join(' ')} role="alert">
      <MonitorX className={styles.icon} />
      <span>{NO_GRAPHICS}</span>
    </div>
  )
}
