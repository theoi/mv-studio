import { Button } from '../../ds/Button.tsx'
import { Dialog } from '../../ds/Dialog.tsx'
import { editedAgo } from '../../format.ts'
import { chooseSameProject, usePersistence } from '../../state/persistence.ts'
import styles from './Common.module.css'

/** Asks what to open when a project file holds a project this browser already keeps. */
export function SameProjectDialog() {
  const question = usePersistence((s) => s.sameProject)
  const newer =
    question &&
    (question.fileAt > question.keptAt ? 'file' : question.fileAt < question.keptAt ? 'kept' : null)
  return (
    <Dialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) chooseSameProject(null)
      }}
      title={`“${question?.name}” is already in this browser`}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={() => chooseSameProject(null)}>
            Cancel
          </Button>
          <Button onClick={() => chooseSameProject('copy')}>Keep a copy</Button>
          <Button variant="primary" onClick={() => chooseSameProject('open')}>
            Open the one here
          </Button>
        </>
      }
    >
      {question && (
        <div className={styles.sameProject}>
          <p>
            {question.fileName} holds a project you already have here. Open the one here, or keep the file’s
            version too, as “{question.copyName}”.
          </p>
          <dl className={styles.sameProjectVersions}>
            <div>
              <dt>Here</dt>
              <dd>
                {editedAgo(question.keptAt)}
                {newer === 'kept' && ' · newer'}
              </dd>
            </div>
            <div>
              <dt>In the file</dt>
              <dd>
                {editedAgo(question.fileAt)}
                {newer === 'file' && ' · newer'}
                {newer === null && ' · same version'}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </Dialog>
  )
}
