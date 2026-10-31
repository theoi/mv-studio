import { AlertTriangle } from 'lucide-react'
import { Button } from '../../ds/Button.tsx'
import { useProject } from '../../state/project.ts'
import { resetStems, stemExportWarning, stemFixLabel, stemMix } from '../../state/stems.ts'
import styles from './StemsWarning.module.css'

/** Warns before exporting with stems muted or soloed, so a forgotten solo does not make a vocals-only video. */
export function StemsWarning() {
  const mix = stemMix(useProject())
  if (!mix) return null
  return (
    <div className={styles.warning} role="alert">
      <AlertTriangle className={styles.icon} />
      <span className={styles.text}>{stemExportWarning(mix)}</span>
      <Button size="sm" variant="secondary" onClick={resetStems}>
        {stemFixLabel(mix)}
      </Button>
    </div>
  )
}
