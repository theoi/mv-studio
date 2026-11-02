import { useState, type Ref } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { jobTitleOnly, useJobs } from '../../../state/jobs.ts'
import { showDraft } from '../../../state/leaveDraft.ts'
import {
  reloadAndRetry,
  reloadBlockers,
  useReloadDraftNote,
  type RetryTask,
} from '../../../state/reloadRetry.ts'
import styles from './Assist.module.css'

/** What helps after a task ran out of memory; `reload` when the footer offers Reload and try again. */
export function OutOfMemoryTips({ reload }: { reload: boolean }) {
  return (
    <>
      <div className={styles.groupLabelInset}>Things that help</div>
      <ul className={styles.tips}>
        <li>
          {reload
            ? 'Reload and try again: your project is saved first, and the reload frees memory held by earlier work in this tab'
            : 'Reload the page to free memory held by earlier work in this tab'}
        </li>
        <li>Close other browser tabs that play video</li>
      </ul>
    </>
  )
}

/**
 * The footer's Reload and try again, held back while a job a reload would stop is running, or while the Director's
 * draft holds AI shots a reload would drop. `ref` takes the focus a failed run gives its tool (useFocusOnFailure)
 * while the button can be used.
 */
export function ReloadAndRetryButton({ task, ref }: { task: RetryTask; ref?: Ref<HTMLButtonElement> }) {
  const blocker = reloadBlockers(useJobs())[0]
  const draftNote = useReloadDraftNote()
  const [saving, setSaving] = useState(false)
  return (
    <>
      {blocker ? (
        <p className={styles.footerNote}>
          Wait for “{jobTitleOnly(blocker.title)}” to finish: a reload would stop it.
        </p>
      ) : (
        draftNote && (
          <>
            <p className={styles.footerNote}>{draftNote}</p>
            <Button block onClick={showDraft}>
              Back to the draft
            </Button>
          </>
        )
      )}
      <Button
        ref={ref}
        variant="primary"
        block
        icon={<RefreshCw />}
        disabled={saving || !!blocker || !!draftNote}
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
