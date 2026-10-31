import { Fragment, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Mic2 } from 'lucide-react'
import type { Clip, LyricLine } from '../../../../model/index.ts'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { FieldRow, Input, NumberField, Section } from '../../../ds/Fields.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { aboutMinutes, formatBytes, formatTime, plural } from '../../../format.ts'
import { JOB_KINDS, runningJobs, useJobs } from '../../../state/jobs.ts'
import { isUncertain, markLineChecked } from '../../../state/lyricChecks.ts'
import { finishLineText, nudgeLine, setLineEdge, typeLineText } from '../../../state/lyricEdits.ts'
import { lineTiming, retimeCost, retimeLine } from '../../../state/lyricTiming.ts'
import {
  editor,
  lyricLines,
  sectionName,
  sectionsOf,
  songAnalysis,
  useProject,
} from '../../../state/project.ts'
import { pct, useJob } from '../assist/jobState.ts'
import { CancelButton } from '../assist/ToolView.tsx'
import { LyricStyleSections } from './LyricStyle.tsx'
import { Header } from './parts.tsx'
import { ProjectInspector } from './Project.tsx'
import styles from '../Inspector.module.css'

type RetimeCost = Awaited<ReturnType<typeof retimeCost>>

/** What the first re-time after a reload costs, or null when re-timing runs at once. */
function useRetimeCost(): RetimeCost {
  const project = useProject()
  const { phase } = useJob(JOB_KINDS.realign)
  const [cost, setCost] = useState<RetimeCost>(null)
  const stemsReady = !!songAnalysis(project)?.stems
  useEffect(() => {
    let live = true
    retimeCost().then(
      (value) => live && setCost(value),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [project.songAssetId, stemsReady, phase])
  return cost
}

function costText(cost: NonNullable<RetimeCost>): string {
  const parts = [
    cost.separatesStems ? 'separates the vocals first' : 'listens to the vocals first',
    ...(cost.downloadBytes ? [`${formatBytes(cost.downloadBytes)} download, once`] : []),
    `${aboutMinutes(cost.seconds).toLowerCase()} on this device`,
  ]
  return `Re-timing ${parts.join(' · ')}`
}

/**
 * The line under Re-time line: what it is doing, why it stopped or cannot start, or, when the line needs
 * re-timing, what that costs.
 */
function RetimeNote({
  line,
  cost,
  busy,
  onCancel,
}: {
  line: LyricLine
  cost: RetimeCost
  busy?: string
  onCancel: () => void
}) {
  const { job, phase } = useJob(JOB_KINDS.realign)
  if (phase === 'running')
    return (
      <div className={styles.progressRow}>
        <span>
          {job?.title ?? 'Listening to the vocals'}… {pct(job)}%
        </span>
        <CancelButton job={job} inline onCancel={onCancel} />
      </div>
    )
  if (phase === 'failed' && job?.error?.code !== 'cancelled')
    return (
      <p className={styles.note} role="alert">
        <span className={styles.noteDanger}>
          <AlertTriangle aria-hidden />
          {job?.error?.message ?? 'Something went wrong'}
        </span>
        Your lyrics are unchanged.
      </p>
    )
  if (busy) return <p className={styles.note}>{busy}</p>
  if (!cost || lineTiming(line) === 'timed') return null
  return <p className={styles.note}>{costText(cost)}</p>
}

function TimingBadge({ line }: { line: LyricLine }) {
  const timing = lineTiming(line)
  if (timing === 'untimed') return <Badge>Not timed yet</Badge>
  if (timing === 'edited') return <Badge tone="warning">Text changed since timing</Badge>
  return (
    <Badge tone="success" icon={<Check />}>
      {plural(line.words.length, 'word')} timed to vocals
    </Badge>
  )
}

/** A line to check: why, its words with the uncertain ones underlined, and Mark as checked. */
function CheckNote({ line }: { line: LyricLine }) {
  const underlined = line.words.some(isUncertain)
  return (
    <div className={styles.draft}>
      <p className={styles.draftText}>
        {line.check === 'words'
          ? `Drafted from the vocals. Check the words.${underlined ? ' Uncertain ones are underlined.' : ''}`
          : `${line.check === 'unlisted' ? 'Singing near this line isn’t in the pasted lyrics, so its words may be timed wrong.' : 'Some words may be timed wrong.'} Play the line to check.${underlined ? ' Uncertain words are underlined.' : ''}`}
      </p>
      {line.words.length > 0 && (
        <p className={styles.draftWords}>
          {line.words.map((w, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              {isUncertain(w) ? (
                <span className={styles.uncertain}>
                  {w.text}
                  <span className="sr-only"> (uncertain)</span>
                </span>
              ) : (
                w.text
              )}
            </Fragment>
          ))}
        </p>
      )}
      <span className={styles.draftAction}>
        <Button size="sm" variant="ghost" onClick={() => markLineChecked(line.id)}>
          Mark as checked
        </Button>
      </span>
    </div>
  )
}

/** A lyric line's words and timing. */
function WordsSection({ line }: { line: LyricLine }) {
  const project = useProject()
  const { phase } = useJob(JOB_KINDS.realign)
  const running = runningJobs(useJobs())
  const lyricsRunning = running.some((j) => j.kind === JOB_KINDS.lyrics)
  // Listening to the vocals separates stems when the song has none; a second separation would double the memory.
  const stemsRunning = !songAnalysis(project)?.stems && running.some((j) => j.kind === JOB_KINDS.stems)
  const busy = lyricsRunning
    ? 'Lyrics are being timed now.'
    : stemsRunning
      ? 'Stems are being separated now.'
      : undefined
  const cost = useRetimeCost()
  const retimeRef = useRef<HTMLButtonElement>(null)
  // A cancel is silent: the section returns to how it was, with focus back on the button that started the job.
  const cancelled = useRef(false)
  useEffect(() => {
    if (phase === 'running' || !cancelled.current) return
    cancelled.current = false
    retimeRef.current?.focus()
  }, [phase])
  const retime = (
    <Button
      ref={retimeRef}
      size="sm"
      variant="ghost"
      disabled={!project.songAssetId || !line.text.trim() || !!busy || phase === 'running'}
      onClick={() => void retimeLine(line.id)}
    >
      Re-time line
    </Button>
  )
  const textKey = `inspector:${line.id}:text`
  const setEdge = (edge: 'start' | 'end', value: number) =>
    setLineEdge(line.id, edge, value, `inspector:${line.id}:${edge}`)
  const timed = line.words.length > 0
  return (
    <Section title="Words">
      <div className={styles.padded}>
        <Input
          value={line.text}
          onChange={(e) => typeLineText(line.id, e.target.value, textKey)}
          onBlur={() => finishLineText(line.id, textKey)}
          aria-label="Lyric text"
        />
        <div className={styles.timedRow}>
          <TimingBadge line={line} />
          {cost && !busy && phase !== 'running' && lineTiming(line) === 'timed' ? (
            <Tooltip label="Re-time line" description={costText(cost)}>
              {retime}
            </Tooltip>
          ) : (
            retime
          )}
        </div>
      </div>
      {line.check && <CheckNote line={line} />}
      <RetimeNote line={line} cost={cost} busy={busy} onCancel={() => (cancelled.current = true)} />
      <FieldRow label="Start">
        <NumberField
          value={line.start ?? 0}
          onChange={(v) => setEdge('start', v)}
          onCommit={() => editor.endGesture()}
          step={0.01}
          precision={2}
          unit="s"
          ariaLabel="Start time"
        />
      </FieldRow>
      <FieldRow label="End">
        <NumberField
          value={line.end ?? 0}
          onChange={(v) => setEdge('end', v)}
          onCommit={() => editor.endGesture()}
          step={0.01}
          precision={2}
          unit="s"
          ariaLabel="End time"
        />
      </FieldRow>
      <FieldRow label="Nudge">
        <div className={styles.nudgeRow}>
          <IconButton
            size="sm"
            variant="secondary"
            label="Nudge one frame earlier"
            shortcut="Alt ←"
            disabled={!timed}
            onClick={() => nudgeLine(line.id, -1)}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label="Nudge one frame later"
            shortcut="Alt →"
            disabled={!timed}
            onClick={() => nudgeLine(line.id, 1)}
          >
            <ChevronRight />
          </IconButton>
        </div>
      </FieldRow>
    </Section>
  )
}

export function LyricInspector({ id }: { id: string }) {
  const project = useProject()
  const line = lyricLines(project).find((l) => l.id === id)
  const clip = Object.values(project.clips).find(
    (c): c is Extract<Clip, { type: 'text' }> => c.type === 'text' && c.lyricLineId === id,
  )
  if (!line) return <ProjectInspector />
  const sec = sectionsOf(project).find(
    (s) => line.start !== undefined && line.start >= s.start && line.start < s.end,
  )
  return (
    <>
      <Header
        icon={<Mic2 />}
        title="Lyric line"
        meta={`${sec ? sectionName(sec) : 'Lyrics'} · ${formatTime(line.start ?? 0, true)} – ${formatTime(line.end ?? 0, true)}`}
      />
      <WordsSection line={line} />
      <LyricStyleSections clip={clip} />
    </>
  )
}
