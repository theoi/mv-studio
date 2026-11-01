import { EyeOff } from 'lucide-react'
import { blankClipWarning } from '../../state/blankClips.ts'
import { useProject } from '../../state/project.ts'
import styles from './StemsWarning.module.css'

/** Warns before exporting clips that show nothing, so a clip whose frames are all transparent does not export black. */
export function BlankClipsWarning() {
  const warning = blankClipWarning(useProject())
  if (!warning) return null
  return (
    <div className={styles.warning} role="status">
      <EyeOff className={styles.icon} />
      <span className={styles.text}>{warning}</span>
    </div>
  )
}
