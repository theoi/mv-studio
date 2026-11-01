import { AlertTriangle } from 'lucide-react'
import { exportStoppedMessage, useStoppedExport } from '../../state/exports.ts'
import { useProject } from '../../state/project.ts'
import styles from './StemsWarning.module.css'

/** Says in the Export dialog that the project's last export didn't finish, until the next export starts. */
export function StoppedExportNote() {
  const stopped = useStoppedExport((s) => s.stopped)
  const project = useProject()
  if (!stopped || (stopped.project && stopped.project.id !== project.id)) return null
  return (
    <div className={styles.warning} role="alert">
      <AlertTriangle className={styles.icon} />
      <span className={styles.text}>
        {exportStoppedMessage(stopped.resolution, undefined, stopped.files)}
      </span>
    </div>
  )
}
