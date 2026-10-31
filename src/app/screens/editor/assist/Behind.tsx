import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { sceneThumb } from '../../../mock/art.ts'
import { FEATURED_CLIP_ID } from '../../../mock/demoProject.ts'
import { media } from '../../../mock/media.ts'
import { putBehind, suitableClips } from '../../../state/behind.ts'
import { editor } from '../../../state/project.ts'
import { set, toast } from '../../../state/ui.ts'
import { ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

export function BehindView() {
  const byId = Object.fromEntries(media.map((m) => [m.id, m]))
  const rows = [
    { m: byId['m-singer'], ok: true, note: 'Person fills the frame' },
    { m: byId['m-dancer'], ok: true, note: 'Person found' },
    { m: byId['m-crowd'], ok: false, note: 'People are too small in this wide shot' },
  ].filter((r) => r.m)
  return (
    <ToolView
      title="Behind the subject"
      subtitle="Text sits between the person and the background"
      footer={
        <Button
          variant="primary"
          block
          onClick={() => {
            const count = putBehind(suitableClips(editor.getProject()))
            set({ selection: { type: 'clip', id: FEATURED_CLIP_ID }, playhead: 66.6 })
            toast(
              count
                ? `Lyrics now sit behind the person on ${count} clips`
                : 'Lyrics already sit behind the person on every suitable clip',
            )
          }}
        >
          Apply to suitable clips
        </Button>
      }
    >
      <p className={styles.lede}>
        People are cut out automatically on this device. For other objects, click them in the preview.
      </p>
      <div className={styles.groupLabelInset}>Clips on the timeline</div>
      {rows.map(({ m, ok, note }) =>
        m ? (
          <div key={m.id} className={styles.suitRow}>
            <span className={styles.suitThumb} style={{ backgroundImage: `url(${sceneThumb(m.scene)})` }} />
            <span className={styles.suitText}>
              <span className={styles.toolTitle}>{m.name}</span>
              <span className={ok ? styles.okText : styles.warnText}>{note}</span>
            </span>
            {ok ? <Badge tone="success">Suitable</Badge> : <Badge tone="warning">Not suitable</Badge>}
          </div>
        ) : null,
      )}
    </ToolView>
  )
}
