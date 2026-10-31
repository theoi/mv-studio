import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, Check, RotateCcw } from 'lucide-react'
import { MIN_TAPS, TAP_RESET_SECONDS, tapTempo } from '../../../../analysis/beats/tap.ts'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBpm } from '../../../format.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { hasSong, sectionKind, sectionsOf, songAnalysis, useProject } from '../../../state/project.ts'
import { analyzeAgain, applyTappedTempo, setFirstBeat } from '../../../state/songAnalysis.ts'
import { get } from '../../../state/ui.ts'
import { pct, useJob } from './jobState.ts'
import { CancelButton, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

function FoundBadge({ count }: { count: number }) {
  if (!count) return <Badge>None found</Badge>
  return (
    <Badge tone="success" icon={<Check />}>
      {count} found
    </Badge>
  )
}

/** Taps on Tap tempo; a pause of TAP_RESET_SECONDS uses the tempo they give. */
function useTaps(): { taps: number[]; tap: () => void } {
  const [taps, setTaps] = useState<number[]>([])
  useEffect(() => {
    if (!taps.length) return
    const id = setTimeout(() => {
      const bpm = tapTempo(taps)
      setTaps([])
      if (bpm) void applyTappedTempo(bpm)
    }, TAP_RESET_SECONDS * 1000)
    return () => clearTimeout(id)
  }, [taps])
  return { taps, tap: () => setTaps((t) => [...t, performance.now() / 1000]) }
}

export function AnalysisView() {
  const project = useProject()
  const analysis = songAnalysis(project)
  const list = sectionsOf(project)
  const choruses = list.filter((s) => sectionKind(s) === 'chorus').length
  const name = project.songAssetId ? project.assets[project.songAssetId]?.name : undefined
  const { job, phase } = useJob(JOB_KINDS.analysis)
  const tempo = useJob(JOB_KINDS.tempo)
  const { taps, tap } = useTaps()
  const tapped = tapTempo(taps)
  const busy = phase === 'running' || tempo.phase === 'running'

  if (phase === 'failed') {
    return (
      <ToolView
        title="Song analysis"
        subtitle={name}
        footer={
          <Button variant="primary" block icon={<RotateCcw />} onClick={() => void analyzeAgain()}>
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
            <div className={styles.muted}>Your project is unchanged.</div>
          </div>
        </div>
      </ToolView>
    )
  }

  let tempoText = analysis?.tempo ? `${formatBpm(analysis.tempo.bpm)} · 4/4` : 'Not found'
  if (taps.length) tempoText = tapped ? `Tapping · ${formatBpm(tapped)}` : 'Tapping…'
  else if (tempo.phase === 'running') tempoText = `Following your tempo… ${pct(tempo.job)}%`

  return (
    <ToolView
      title="Song analysis"
      subtitle={name}
      footer={phase === 'running' ? <CancelButton job={job} /> : undefined}
    >
      {phase === 'running' && <RunCard job={job} label="Song analysis progress" />}
      <div className={styles.facts}>
        <div>
          <span>Tempo</span>
          <span className="tnum">{tempoText}</span>
        </div>
        <div>
          <span>Beats</span>
          <span>
            <FoundBadge count={analysis?.beats?.length ?? 0} />
          </span>
        </div>
        <div>
          <span>Bar starts</span>
          <span>
            <FoundBadge count={analysis?.downbeats?.length ?? 0} />
          </span>
        </div>
        <div>
          <span>Sections</span>
          <span>
            {list.length}
            {choruses > 1 ? `, chorus repeats ${choruses}×` : ''}
          </span>
        </div>
        <div>
          <span>Energy curve</span>
          <span>Shown in the song lane</span>
        </div>
      </div>
      <div className={styles.linkRow}>
        <Tooltip
          label="Tap tempo"
          description={`Play the song and tap along with the beat, at least ${MIN_TAPS} times. Stop for ${TAP_RESET_SECONDS} seconds to use the tempo.`}
        >
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity />}
            disabled={!analysis || busy}
            onClick={tap}
          >
            Tap tempo
          </Button>
        </Tooltip>
        <Tooltip label="Set first beat" description="Makes the beat nearest the playhead the start of a bar">
          <Button
            size="sm"
            variant="ghost"
            disabled={!analysis?.beats?.length || busy}
            onClick={() => setFirstBeat(get().playhead)}
          >
            Set first beat
          </Button>
        </Tooltip>
        <Tooltip
          label="Analyze again"
          description="Finds the beats, bars and sections again. Undo brings back your corrections."
        >
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasSong(project) || busy}
            onClick={() => void analyzeAgain()}
          >
            Analyze again
          </Button>
        </Tooltip>
      </div>
      <p className={styles.muted}>
        Section names are best guesses. Rename them by double-clicking on the timeline.
      </p>
    </ToolView>
  )
}
