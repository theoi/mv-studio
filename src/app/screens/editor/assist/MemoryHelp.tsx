import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { useJobs } from '../../../state/jobs.ts'
import { reloadAndRetry, reloadBlockers, type RetryTask } from '../../../state/reloadRetry.ts'
import styles from './Assist.module.css'

/** What helps after a task ran out of memory; `reload` when the footer offers Reload and try again. */
export function OutOfMemoryTips({ reload }: { reload: boolean }) {
  return (
    <>
      <div className={styles.groupLabelInset}>Things that help</div>
      <ul className={styles.tips}>
        <li>
          {reload
            ? 'Reload and try again: your project is saved, then the reload frees memory that earlier work in this tab still holds'
            : 'Reload the page to free memory that earlier work in this tab still holds'}
        </li>
        <li>Close other browser tabs that play video</li>
      </ul>
    </>
  )
}

/** The footer's Reload and try again, held back while a job a reload would stop is running. */
export function ReloadAndRetryButton({ task }: { task: RetryTask }) {
  const blocker = reloadBlockers(useJobs())[0]
  const [saving, setSaving] = useState(false)
  return (
    <>
      {blocker && (
        <p className={styles.footerNote}>Wait for “{blocker.title}” to finish: a reload would stop it.</p>
      )}
      <Button
        variant="primary"
        block
        icon={<RefreshCw />}
        disabled={saving || !!blocker}
        onClick={() => {
          setSaving(true)
          void reloadAndRetry(task).finally(() => setSaving(false))
        }}
      >
        Reload and try again
      </Button>
    </>
  )
}
