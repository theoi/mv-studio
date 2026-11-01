import { useEffect, useState } from 'react'
import { AlertTriangle, Lock, RotateCcw } from 'lucide-react'
import { MODEL_TITLES } from '../../../../analysis/models.ts'
import { theModel } from '../../../../shared/models.ts'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { aboutMinutes, formatBytes } from '../../../format.ts'
import { JOB_KINDS, runningJobs, useJobs } from '../../../state/jobs.ts'
import { hasSong, songAnalysis, useProject } from '../../../state/project.ts'
import {
  estimateStems,
  songStemTrack,
  startStems,
  stemBars,
  stemFallbackNote,
  stemMix,
  stemNoteText,
  toggleStem,
  useUnplayableStem,
} from '../../../state/stems.ts'
import { pct, useJob } from './jobState.ts'
import { CancelButton, RunCard, Steps, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

const STEMS = [
  { name: 'vocals', label: 'Vocals' },
  { name: 'drums', label: 'Drums' },
  { name: 'bass', label: 'Bass' },
  { name: 'other', label: 'Other' },
] as const

/** Below this peak loudness (relative to the mix) a stem's waveform is a flat line, so the row says why. */
const ALMOST_SILENT = 0.05

/** Status on the Stems row of Assist's tool list. */
export function StemsBadge() {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.stems)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  if (songAnalysis(project)?.stems) return <Badge tone="success">Ready</Badge>
  return null
}

/** The step a job stage belongs to: getting the model (after reading the song), separating, saving. */
function stepOf(stage: string | undefined): number {
  if (!stage || stage === 'decode' || stage === 'download') return 0
  if (stage === 'encode' || stage === 'save') return 2
  return 1
}

export function StemsView() {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.stems)
  const analysis = songAnalysis(project)
  const ready = !!analysis?.stems
  const unplayable = useUnplayableStem(project)
  // Timing lyrics separates the stems itself when the song has none; a second separation would double the memory.
  const jobs = useJobs()
  const lyricsSeparating = !ready && runningJobs(jobs).some((j) => j.kind === JOB_KINDS.lyrics)
  const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof estimateStems>>>(null)
  useEffect(() => {
    let live = true
    estimateStems().then(
      (value) => live && setEstimate(value),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [project.songAssetId, ready, phase])
  const download = estimate?.downloadBytes ?? 0

  if (phase === 'running') {
    // The progress card says what is happening; the subtitle names the song, as Song analysis does.
    return (
      <ToolView
        title="Stems"
        subtitle={project.songAssetId ? project.assets[project.songAssetId]?.name : undefined}
        footer={<CancelButton job={job} />}
      >
        <RunCard job={job} label="Stem separation progress" />
        <Steps
          steps={[
            download
              ? `Download ${theModel(MODEL_TITLES.stems)} (${formatBytes(download)}, once)`
              : `Load ${theModel(MODEL_TITLES.stems)}`,
            'Separate the song',
            'Save stems with the project',
          ]}
          active={stepOf(job?.progress.stage)}
        />
        <p className={styles.muted}>
          Keep editing; you’ll get a notice when the stems are ready. Precise lyric timing and stem-driven
          effects unlock afterwards.
        </p>
      </ToolView>
    )
  }
  if (phase === 'failed') {
    const memory = job?.error?.code === 'out-of-memory'
    return (
      <ToolView
        title="Stems"
        subtitle="Separation stopped"
        footer={
          <Button variant="primary" block icon={<RotateCcw />} onClick={() => void startStems()}>
            Try again
          </Button>
        }
      >
        <div className={styles.failure} role="alert">
          <span className={styles.failureIcon}>
            <AlertTriangle />
          </span>
          <div>
            <div className={styles.successTitle}>{job?.error?.message ?? 'Something went wrong.'}</div>
            <div className={styles.muted}>
              Your project is unchanged. Trying again starts from the beginning.
            </div>
          </div>
        </div>
        {memory && (
          <>
            <div className={styles.groupLabelInset}>Things that help</div>
            <ul className={styles.tips}>
              <li>Close other browser tabs that play video</li>
            </ul>
          </>
        )}
      </ToolView>
    )
  }
  if (ready) {
    const flags = songStemTrack(project)?.stems
    const mix = stemMix(project)
    return (
      <ToolView title="Stems" subtitle="Ready · shown under the song track">
        {STEMS.filter((s) => analysis?.stems?.[s.name]).map((s) => {
          const bars = stemBars(analysis?.stemFeatures?.[s.name], 36)
          const soloed = !!flags?.[s.name]?.solo
          return (
            <div key={s.name} className={styles.stemRow}>
              <span className={styles.stemName}>{s.label}</span>
              <span className={styles.stemWave} aria-hidden>
                {bars.map((v, k) => (
                  <i key={k} style={{ height: `${10 + v * 90}%` }} />
                ))}
              </span>
              {Math.max(...bars) < ALMOST_SILENT && <span className={styles.muted}>Almost silent</span>}
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={soloed}
                onClick={() => toggleStem(s.name, 'solo')}
              >
                {soloed ? 'Unsolo' : 'Solo'}
              </Button>
            </div>
          )
        })}
        {mix && (
          <p className={styles.stemMixNote} role="status">
            {unplayable ? stemFallbackNote(unplayable) : stemNoteText(mix)}
          </p>
        )}
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
          <Button
            variant="primary"
            block
            disabled={!hasSong(project) || lyricsSeparating}
            onClick={() => void startStems()}
          >
            Separate stems
          </Button>
          <div className={styles.costLine}>
            <Lock />{' '}
            {lyricsSeparating ? 'Lyrics timing is separating the stems now' : 'Runs on this device · free'}
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
          <span>{estimate ? `${aboutMinutes(estimate.seconds)} on this device` : 'Working it out…'}</span>
        </div>
        <div>
          <span>Download</span>
          <span>
            {!estimate
              ? 'Working it out…'
              : download
                ? `${formatBytes(download)} once, then offline`
                : 'Already on this device'}
          </span>
        </div>
        <div>
          <span>Memory</span>
          <span>
            {estimate ? `Needs about ${Math.ceil(estimate.memoryBytes / 1e9)} GB free` : 'Working it out…'}
          </span>
        </div>
      </div>
    </ToolView>
  )
}
