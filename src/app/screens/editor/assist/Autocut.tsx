import { useState } from 'react'
import { Check, Scissors, Undo2 } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Segmented, Select, Switch } from '../../../ds/Fields.tsx'
import { startAutocut } from '../../../mock/actions.ts'
import { media } from '../../../mock/media.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { toast } from '../../../state/ui.ts'
import { dismiss, useJob } from './jobState.ts'
import { Field, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

export function AutocutView() {
  const { job, phase } = useJob(JOB_KINDS.autocut)
  const [pace, setPace] = useState('bar')
  const [follow, setFollow] = useState(true)
  const [match, setMatch] = useState(true)
  return (
    <ToolView
      title="Auto-cut"
      subtitle="Cut your clips to the music"
      footer={
        phase === 'running' ? (
          <RunCard job={job} label="Cutting to the beat" />
        ) : phase === 'done' ? (
          <div className={styles.footerRow}>
            <Button
              variant="secondary"
              icon={<Undo2 />}
              onClick={() => {
                dismiss(job)
                toast('Cuts removed')
              }}
            >
              Undo
            </Button>
            <Button variant="primary" className={styles.grow} icon={<Check />} onClick={() => dismiss(job)}>
              Keep 72 cuts
            </Button>
          </div>
        ) : (
          <Button variant="primary" block icon={<Scissors />} onClick={() => startAutocut()}>
            Cut to the beat
          </Button>
        )
      }
    >
      <Field label="Cut every">
        <Segmented
          block
          value={pace}
          onChange={setPace}
          ariaLabel="Cut pace"
          options={[
            { value: 'beat', label: 'Beat' },
            { value: '2', label: '2 beats' },
            { value: 'bar', label: 'Bar' },
            { value: 'phrase', label: 'Phrase' },
          ]}
        />
      </Field>
      <label className={styles.switchRow}>
        <span>
          <span className={styles.switchTitle}>Follow the song’s energy</span>
          <span className={styles.fieldHint}>Faster cuts in choruses, slower in verses</span>
        </span>
        <Switch checked={follow} onCheckedChange={setFollow} ariaLabel="Follow the song’s energy" />
      </label>
      <label className={styles.switchRow}>
        <span>
          <span className={styles.switchTitle}>Match clips to the mood</span>
          <span className={styles.fieldHint}>Uses footage tags, like “crowd” for choruses</span>
        </span>
        <Switch checked={match} onCheckedChange={setMatch} ariaLabel="Match clips to the mood" />
      </label>
      <Field label="Range">
        <Select
          value="all"
          onChange={() => undefined}
          ariaLabel="Range"
          options={[
            { value: 'all', label: 'Whole song' },
            { value: 'sel', label: 'Selected section' },
          ]}
        />
      </Field>
      <Field label="Clips">
        <Select
          value="all"
          onChange={() => undefined}
          ariaLabel="Clips to use"
          options={[
            { value: 'all', label: `All ${media.length} clips in the library` },
            { value: 'sel', label: 'Selected clips' },
          ]}
        />
      </Field>
    </ToolView>
  )
}
