import { useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, TextArea } from '../../../ds/Fields.tsx'
import { lyricLines, useProject } from '../../../state/project.ts'
import { set, toast } from '../../../state/ui.ts'
import { Field, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Lyrics row of Assist's tool list. */
export function LyricsBadge() {
  const project = useProject()
  return lyricLines(project).length ? <Badge tone="success">Timed</Badge> : null
}

export function LyricsView() {
  const project = useProject()
  const lines = lyricLines(project)
  const [mode, setMode] = useState('paste')
  const firstChorusLine = lines.find((l) => l.id.startsWith('l-c1'))
  return (
    <ToolView
      title="Lyrics"
      subtitle={lines.length ? `${lines.length} lines · every word timed` : 'Not added yet'}
      footer={
        <>
          <Button variant="primary" block onClick={() => toast('Words re-timed to the vocals')}>
            Time words to the vocals
          </Button>
          <div className={styles.costLine}>
            <Info /> Uses the vocals stem for precise timing
          </div>
        </>
      }
    >
      <Segmented
        block
        value={mode}
        onChange={setMode}
        ariaLabel="Lyrics source"
        options={[
          { value: 'paste', label: 'Paste lyrics' },
          { value: 'draft', label: 'Draft from vocals' },
        ]}
      />
      {mode === 'paste' ? (
        <Field label="Lyrics" hint="Each line becomes a lyric line on the Lyrics track.">
          <TextArea rows={8} aria-label="Lyrics" defaultValue={lines.map((l) => l.text).join('\n')} />
        </Field>
      ) : (
        <div className={styles.callout}>
          <Info />
          <div>
            A draft is written from the vocals on this device. Sung lyrics are tricky, so check each line
            before timing.
          </div>
        </div>
      )}
      <Field label="Look of the lyrics">
        <div className={styles.linkRow}>
          <Button size="sm" variant="ghost" onClick={() => set({ libraryTab: 'text' })}>
            Kinetic presets
          </Button>
          {firstChorusLine && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ selection: { type: 'lyric', id: firstChorusLine.id } })}
            >
              Karaoke highlight
            </Button>
          )}
        </div>
      </Field>
    </ToolView>
  )
}
