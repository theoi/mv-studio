import { Button } from '../../ds/Button.tsx'
import { Dialog } from '../../ds/Dialog.tsx'
import { answerLeaveDraft, leaveDraftText, useLeaveDraft } from '../../state/leaveDraft.ts'
import styles from './Common.module.css'

/** Asks before another project opens while the Director's draft still holds AI shots (see leaveDraft.ts). */
export function LeaveDraftDialog() {
  const ask = useLeaveDraft((s) => s.ask)
  const applying = useLeaveDraft((s) => s.applying)
  const text = ask && leaveDraftText(ask.held)
  return (
    <Dialog
      open={ask !== null}
      onOpenChange={(open) => {
        if (!open) void answerLeaveDraft('stay')
      }}
      title={text?.title ?? ''}
      width={460}
      footer={
        <>
          <Button variant="ghost" disabled={applying} onClick={() => void answerLeaveDraft('stay')}>
            Stay
          </Button>
          {/* Leaving is never the highlighted choice: it is the one that can cost money. */}
          <Button disabled={applying} onClick={() => void answerLeaveDraft('leave')}>
            Leave anyway
          </Button>
          {text?.apply && (
            <Button variant="primary" disabled={applying} onClick={() => void answerLeaveDraft('apply')}>
              {applying ? 'Applying…' : text.apply}
            </Button>
          )}
        </>
      }
    >
      {text && <p className={styles.leaveDraft}>{text.text}</p>}
    </Dialog>
  )
}
