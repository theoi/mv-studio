import { useState } from 'react'
import { Check, Clapperboard, Cpu, KeyRound, Lock, Undo2 } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, TextArea } from '../../../ds/Fields.tsx'
import { startDirector } from '../../../mock/actions.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { set, toast } from '../../../state/ui.ts'
import { dismiss, pct, useJob } from './jobState.ts'
import { CancelButton, Field, RunCard, Steps, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Director row of Assist's tool list. */
export function DirectorBadge() {
  const { job, phase } = useJob(JOB_KINDS.director)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'done') return <Badge tone="success">Done</Badge>
  return null
}

const directorSteps = [
  'Read the song’s structure',
  'Match your clips to sections',
  'Write the creative plan',
  'Place shots and lyrics',
  'Apply looks and effects',
]

export function DirectorView() {
  const { job, phase } = useJob(JOB_KINDS.director)
  const [shots, setShots] = useState('mine')
  if (phase === 'running') {
    const active = Math.min(
      directorSteps.length - 1,
      Math.floor((job?.progress.fraction ?? 0) * directorSteps.length),
    )
    return (
      <ToolView title="Director" subtitle="Drafting your video" footer={<CancelButton job={job} />}>
        <RunCard job={job} label="Drafting progress" />
        <Steps steps={directorSteps} active={active} />
        <p className={styles.muted}>
          You can keep editing while this runs. Nothing changes on the timeline until the draft is ready.
        </p>
      </ToolView>
    )
  }
  if (phase === 'done') {
    const plan = [
      { s: 'Intro', d: 'Slow drift over the night city, title fades in' },
      { s: 'Verse 1', d: 'Singer close-ups, cuts every 2 bars, lyrics lower third' },
      { s: 'Pre-chorus', d: 'Cuts tighten to every bar, energy builds' },
      { s: 'Chorus', d: 'Crowd and neon on every beat, spectrum overlay, kick-driven zoom' },
      { s: 'Bridge', d: 'Aurora and sunset stills with 3D camera, lyrics behind the singer' },
      { s: 'Outro', d: 'Back to the city, slow fade to black' },
    ]
    return (
      <ToolView
        title="Director"
        subtitle="Draft ready"
        footer={
          <div className={styles.footerRow}>
            <Button
              variant="secondary"
              icon={<Undo2 />}
              onClick={() => {
                dismiss(job)
                toast('Draft removed from the timeline')
              }}
            >
              Undo draft
            </Button>
            <Button
              variant="primary"
              onClick={() => set({ selection: { type: 'none' }, playhead: 0, playing: true })}
              className={styles.grow}
            >
              Play the draft
            </Button>
          </div>
        }
      >
        <div className={styles.success}>
          <span className={styles.successIcon}>
            <Check />
          </span>
          <div>
            <div className={styles.successTitle}>Placed 64 clips, 31 lyric lines and 3 looks</div>
            <div className={styles.muted}>
              All of it is normal content on the timeline. Change anything by hand.
            </div>
          </div>
        </div>
        <div className={styles.groupLabelInset}>The plan</div>
        <ol className={styles.plan}>
          {plan.map((p) => (
            <li key={p.s}>
              <span className={styles.planSection}>{p.s}</span>
              <span className={styles.planDesc}>{p.d}</span>
            </li>
          ))}
        </ol>
        <Field label="Refine the draft">
          <TextArea
            rows={2}
            placeholder="For example: fewer crowd shots, more of the singer in verse 2"
            aria-label="Refine the draft"
          />
        </Field>
      </ToolView>
    )
  }
  return (
    <ToolView
      title="Director"
      subtitle="Drafts a complete, editable video"
      footer={
        <>
          <Button variant="primary" block icon={<Clapperboard />} onClick={() => startDirector()}>
            Draft video
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device with your clips · free
          </div>
        </>
      }
    >
      <Field label="Idea" hint="Optional. Without one, the director follows the song’s mood and your clips.">
        <TextArea
          rows={3}
          defaultValue="A dreamy night drive through a neon city that ends at sunrise"
          aria-label="Idea for the video"
        />
      </Field>
      <Field label="Shots">
        <Segmented
          block
          value={shots}
          onChange={setShots}
          ariaLabel="Where shots come from"
          options={[
            { value: 'mine', label: 'My clips' },
            { value: 'mix', label: 'Mix' },
            { value: 'gen', label: 'Generate' },
          ]}
        />
      </Field>
      {shots !== 'mine' && (
        <div className={styles.callout}>
          <KeyRound />
          <div>
            <div>Generating shots needs a fal.ai key.</div>
            <Button
              size="sm"
              variant="ghost"
              className={styles.calloutBtn}
              onClick={() => set({ dialog: 'settings', settingsPage: 'ai' })}
            >
              Connect fal.ai
            </Button>
          </div>
        </div>
      )}
      <Field label="Planner">
        <div className={styles.plannerRow}>
          <Cpu />
          <span>Ollama · llama3.2 writes the creative plan</span>
        </div>
      </Field>
    </ToolView>
  )
}
