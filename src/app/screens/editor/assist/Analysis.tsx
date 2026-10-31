import { useEffect, useId, useRef, useState } from 'react'
import { Activity, AlertTriangle, Check, RotateCcw } from 'lucide-react'
import { MIN_TAPS, TAP_RESET_SECONDS, tapTempo } from '../../../../analysis/beats/tap.ts'
import { BARS_NOTES } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBpm } from '../../../format.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { bpmOf, hasSong, sectionKind, sectionsOf, songAnalysis, useProject } from '../../../state/project.ts'
import {
  analyzeAgain,
  applyTappedTempo,
  setFirstBeat,
  setTempoLevel,
  SONG_STATE_TEXT,
  TEMPO_LEVEL_RANGE,
  useBars,
} from '../../../state/songAnalysis.ts'
import { get } from '../../../state/ui.ts'
import { dismiss, pct, useJob, useSongState } from './jobState.ts'
import { CancelButton, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

const FINDING = 'Finding…'

function FoundBadge({ count }: { count: number }) {
  if (!count) return <Badge>None found</Badge>
  return (
    <Badge tone="success" icon={<Check />}>
      {count} found
    </Badge>
  )
}

/** Status on the song row of Assist's home: the analysis job's progress or failure. */
export function AnalysisBadge() {
  const { job, phase } = useJob(JOB_KINDS.analysis)
  const tempo = useJob(JOB_KINDS.tempo)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (tempo.phase === 'running') return <Badge tone="accent">{pct(tempo.job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  return null
}

/**
 * Half or Double next to the tempo: the beat level at half or twice the speed, with what it becomes. Past the tempo
 * range it stays focusable (`aria-disabled`), so focus stays on it when a press reaches the limit and its tooltip can
 * say why.
 */
function TempoLevelButton({ factor, bpm, disabled }: { factor: 2 | 0.5; bpm: number; disabled: boolean }) {
  const next = bpm * factor
  const tooFast = next > TEMPO_LEVEL_RANGE.max
  const allowed = next >= TEMPO_LEVEL_RANGE.min && !tooFast
  const name = factor === 2 ? 'Double tempo' : 'Half tempo'
  let description = tooFast
    ? `${formatBpm(next)} is too fast to be the beat. Tempos go up to ${formatBpm(TEMPO_LEVEL_RANGE.max)}.`
    : `${formatBpm(next)} is too slow to be the beat. Tempos go down to ${formatBpm(TEMPO_LEVEL_RANGE.min)}.`
  if (allowed)
    description =
      factor === 2
        ? `For a beat felt twice as fast: adds a beat between every two beats (${formatBpm(next)})`
        : `For a beat felt half as fast: keeps every other beat (${formatBpm(next)})`
  return (
    <Tooltip label={name} description={description}>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${factor === 2 ? 'Double' : 'Half'} tempo, ${formatBpm(next)}`}
        disabled={disabled}
        aria-disabled={allowed ? undefined : true}
        onClick={() => {
          if (allowed) setTempoLevel(factor)
        }}
      >
        {factor === 2 ? 'Double' : 'Half'}
      </Button>
    </Tooltip>
  )
}
const TAP_KEYS = new Set([' ', 'Enter', 't', 'T'])

/**
 * Taps on Tap tempo, timed by the event (pointer down, or Space, Enter or T while focused); a pause of
 * TAP_RESET_SECONDS uses the tempo they give.
 */
function useTaps(): { taps: number[]; tap: (timeStamp: number) => void } {
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
  return { taps, tap: (timeStamp) => setTaps((t) => [...t, timeStamp / 1000]) }
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
  const bars = useBars()
  const tapped = tapTempo(taps)
  const busy = phase === 'running' || tempo.phase === 'running'
  const state = useSongState()
  // Also while the song file loads before the first analysis starts (no job yet).
  const analyzing = phase === 'running' || state === 'analyzing'
  const finding = state === 'analyzing'
  const statusId = useId()
  // The button that starts a run is hidden while it runs, so focus moves to the progress card at the top, not to
  // Cancel, where a second Enter would stop the run. When a run started or cancelled here ends, focus goes to what
  // comes next (Analyze again, Analyze or Try again) if nothing else took it meanwhile.
  const focusCard = useRef(false)
  const returnFocus = useRef(false)
  const nextAction = useRef<HTMLButtonElement>(null)
  const wasAnalyzing = useRef(analyzing)
  useEffect(() => {
    const ended = wasAnalyzing.current && !analyzing
    wasAnalyzing.current = analyzing
    if (!ended || !returnFocus.current) return
    returnFocus.current = false
    if (!document.activeElement || document.activeElement === document.body) nextAction.current?.focus()
  }, [analyzing])
  const start = () => {
    focusCard.current = true
    returnFocus.current = true
    void analyzeAgain().finally(() => {
      focusCard.current = false
    })
  }
  const focusOnMount = (el: HTMLElement | null) => {
    if (!el || !focusCard.current) return
    focusCard.current = false
    el.focus()
  }
  const keepSpace = (className: string, hidden: boolean) =>
    hidden ? `${className} ${styles.keepSpace}` : className

  if (phase === 'failed') {
    return (
      <ToolView
        title="Song analysis"
        subtitle={name}
        footer={
          <div className={styles.footerRow}>
            <Button variant="secondary" onClick={() => dismiss(job)}>
              Back
            </Button>
            <Button
              ref={nextAction}
              variant="primary"
              icon={<RotateCcw />}
              className={styles.grow}
              onClick={start}
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
            <div className={styles.muted}>Your project is unchanged.</div>
          </div>
        </div>
      </ToolView>
    )
  }

  if (state === 'not-analyzed')
    return (
      <ToolView
        title="Song analysis"
        subtitle={name}
        footer={
          <Button ref={nextAction} variant="primary" block disabled={!hasSong(project)} onClick={start}>
            Analyze
          </Button>
        }
      >
        <div className={styles.facts}>
          <div>
            <span>Song</span>
            <span>{SONG_STATE_TEXT[state]}</span>
          </div>
        </div>
        <p className={styles.muted}>Finds the beats, bars, sections and energy, on this device.</p>
      </ToolView>
    )

  const bpm = bpmOf(project)
  let tempoText = bpm ? `${formatBpm(bpm)} · 4/4` : finding ? FINDING : 'No beat found'
  if (taps.length)
    tempoText = tapped ? `Tapping · ${formatBpm(tapped)}` : `Tapping… ${taps.length} of ${MIN_TAPS}`
  else if (tempo.phase === 'running') tempoText = `Following your tempo… ${pct(tempo.job)}%`
  const running = phase === 'running' ? job : tempo.phase === 'running' ? tempo.job : undefined

  return (
    <ToolView
      title="Song analysis"
      subtitle={name}
      footer={
        running ? <CancelButton job={running} onCancel={() => (returnFocus.current = true)} /> : undefined
      }
    >
      {analyzing && (
        <div
          ref={focusOnMount}
          tabIndex={-1}
          role="group"
          aria-labelledby={statusId}
          className={styles.analysisRun}
        >
          <RunCard
            job={phase === 'running' ? job : undefined}
            label="Song analysis progress"
            placeholder="Reading the song"
          />
        </div>
      )}
      <div className={styles.facts}>
        <div>
          <span>Tempo</span>
          <span className={styles.tempoValue}>
            <span className="tnum">{tempoText}</span>
            {bpm && analysis?.beats?.length && !taps.length && tempo.phase !== 'running' ? (
              <span className={keepSpace(styles.tempoLevel, analyzing)}>
                <TempoLevelButton factor={0.5} bpm={bpm} disabled={busy} />
                <TempoLevelButton factor={2} bpm={bpm} disabled={busy} />
              </span>
            ) : null}
          </span>
        </div>
        <div>
          <span>Beats</span>
          <span>{finding ? FINDING : <FoundBadge count={analysis?.beats?.length ?? 0} />}</span>
        </div>
        <div>
          <span>Bar starts</span>
          <span>
            {finding ? (
              FINDING
            ) : bars.status === 'finding' ? (
              <Badge>{BARS_NOTES.finding}</Badge>
            ) : bars.status === 'unavailable' ? (
              <Badge>Not found yet</Badge>
            ) : (
              <FoundBadge count={analysis?.downbeats?.length ?? 0} />
            )}
          </span>
        </div>
        <div>
          <span>Sections</span>
          <span>
            {finding ? FINDING : list.length}
            {!finding && choruses > 1 ? `, chorus repeats ${choruses}×` : ''}
          </span>
        </div>
        <div>
          <span>Energy curve</span>
          <span>{finding ? FINDING : 'Shown in the song lane'}</span>
        </div>
      </div>
      {bars.status === 'unavailable' && (
        <div className={keepSpace(styles.muted, analyzing)}>
          {analysis?.tempo?.confidence === 1
            ? // Analyze again would replace the tempo the user set.
              `${BARS_NOTES.notFound} at this tempo. Set first beat to start them on the beat at the playhead.`
            : `${BARS_NOTES.notFound}. Analyze again to look for them.`}
        </div>
      )}
      <div className={styles.analysisActions}>
        {analyzing && (
          <p id={statusId} role="status" className={styles.lede}>
            {SONG_STATE_TEXT.analyzing}
          </p>
        )}
        <div className={keepSpace(styles.linkRow, analyzing)}>
          <Tooltip
            label="Tap tempo"
            description={`Play the song and tap along with the beat, at least ${MIN_TAPS} times, or press Space or T while the button is focused. Stop for ${TAP_RESET_SECONDS} seconds to use the tempo.`}
          >
            <Button
              size="sm"
              variant="ghost"
              icon={<Activity />}
              disabled={!analysis || busy}
              onPointerDown={(e) => {
                if (e.button === 0) tap(e.timeStamp)
              }}
              onKeyDown={(e) => {
                if (!TAP_KEYS.has(e.key)) return
                // Space and T are also editor shortcuts (play, add text); here they only tap.
                e.preventDefault()
                e.stopPropagation()
                if (!e.repeat) tap(e.timeStamp)
              }}
            >
              Tap tempo
            </Button>
          </Tooltip>
          <Tooltip
            label="Set first beat"
            description="Makes the beat nearest the playhead the start of a bar"
          >
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
              ref={nextAction}
              size="sm"
              variant="ghost"
              disabled={!hasSong(project) || busy}
              onClick={start}
            >
              Analyze again
            </Button>
          </Tooltip>
        </div>
      </div>
      <p className={styles.muted}>
        Section names are best guesses. Rename them by double-clicking on the timeline.
      </p>
    </ToolView>
  )
}
