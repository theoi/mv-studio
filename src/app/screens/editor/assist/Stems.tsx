import { AlertTriangle, Lock, RotateCcw } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { startStems } from '../../../mock/actions.ts'
import { peaks } from '../../../mock/song.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { songAnalysis, useProject } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import { pct, useJob } from './jobState.ts'
import { CancelButton, RunCard, Steps, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Stems row of Assist's tool list. */
export function StemsBadge() {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.stems)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  if (songAnalysis(project)?.stems) return <Badge tone="success">Ready</Badge>
  return null
}

export function StemsView() {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.stems)
  const ready = !!songAnalysis(project)?.stems
  if (phase === 'running') {
    const stage = job?.progress.stage
    const active = stage === 'download' ? 0 : stage === 'save' ? 2 : 1
    return (
      <ToolView
        title="Stems"
        subtitle="Separating vocals, drums, bass and other"
        footer={<CancelButton job={job} />}
      >
        <RunCard job={job} label="Stem separation progress" />
        <Steps
          steps={['Download the model (180 MB, once)', 'Separate the song', 'Save stems with the project']}
          active={active}
        />
        <p className={styles.muted}>
          Keep editing; you’ll get a notice when the stems are ready. Precise lyric timing and stem-driven
          effects unlock afterwards.
        </p>
      </ToolView>
    )
  }
  if (phase === 'failed') {
    return (
      <ToolView
        title="Stems"
        subtitle="Separation stopped"
        footer={
          <div className={styles.footerRow}>
            <Button variant="secondary" onClick={() => set({ dialog: 'settings', settingsPage: 'local' })}>
              Device settings
            </Button>
            <Button
              variant="primary"
              icon={<RotateCcw />}
              className={styles.grow}
              onClick={() => startStems(job?.progress.fraction ?? 0)}
            >
              Try again
            </Button>
          </div>
        }
      >
        <div className={styles.failure} role="alert">
          <span className={styles.failureIcon}>
            <AlertTriangle />
          </span>
          <div>
            <div className={styles.successTitle}>{job?.error?.message ?? 'Something went wrong.'}</div>
            <div className={styles.muted}>
              Your project is unchanged. The part already separated is kept, so trying again picks up at{' '}
              {pct(job)}%.
            </div>
          </div>
        </div>
        <div className={styles.groupLabelInset}>Things that help</div>
        <ul className={styles.tips}>
          <li>Close other browser tabs that play video</li>
          <li>Use fewer threads in Settings › This device</li>
          <li>Or separate stems with Replicate, about $0.02 per song</li>
        </ul>
      </ToolView>
    )
  }
  if (ready) {
    return (
      <ToolView title="Stems" subtitle="Ready · shown under the song track">
        {['Vocals', 'Drums', 'Bass', 'Other'].map((s, i) => (
          <div key={s} className={styles.stemRow}>
            <span className={styles.stemName}>{s}</span>
            <span className={styles.stemWave} aria-hidden>
              {Array.from({ length: 36 }, (_, k) => (
                <i
                  key={k}
                  style={{ height: `${10 + (peaks[(k * 280 + i * 977) % peaks.length] ?? 0) * 90}%` }}
                />
              ))}
            </span>
            <Button size="sm" variant="ghost">
              Solo
            </Button>
          </div>
        ))}
        <p className={styles.muted}>
          Effects and visualizers can now react to one stem, like the kick in Drums.
        </p>
      </ToolView>
    )
  }
  return (
    <ToolView
      title="Stems"
      subtitle="Split the song into four parts"
      footer={
        <>
          <Button variant="primary" block onClick={() => startStems()}>
            Separate stems
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device · free
          </div>
        </>
      }
    >
      <p className={styles.lede}>
        Vocals, drums, bass and other become separate lanes under the song. Effects can react to a single
        stem, and lyrics can be timed precisely to the vocals.
      </p>
      <div className={styles.facts}>
        <div>
          <span>Time</span>
          <span>About 3–5 min on this computer</span>
        </div>
        <div>
          <span>Download</span>
          <span>180 MB once, then offline</span>
        </div>
        <div>
          <span>Memory</span>
          <span>Up to 4 GB while running</span>
        </div>
      </div>
    </ToolView>
  )
}
