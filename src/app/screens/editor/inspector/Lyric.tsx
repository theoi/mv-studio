import { useEffect, useState } from 'react'
import { Check, Mic2 } from 'lucide-react'
import type { Clip, LyricLine } from '../../../../model/index.ts'
import { jobs } from '../../../../shared/jobs.ts'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { FieldRow, Input, NumberField, Section } from '../../../ds/Fields.tsx'
import { formatBytes, formatTime, plural } from '../../../format.ts'
import { JOB_KINDS, runningJobs, useJobs } from '../../../state/jobs.ts'
import { lineTiming, retimeCost, retimeLine } from '../../../state/lyricTiming.ts'
import {
  dispatch,
  editor,
  lyricLines,
  sectionName,
  sectionsOf,
  songAnalysis,
  useProject,
} from '../../../state/project.ts'
import { pct, useJob } from '../assist/jobState.ts'
import { LyricStyleSections } from './LyricStyle.tsx'
import { Header } from './parts.tsx'
import { ProjectInspector } from './Project.tsx'
import styles from '../Inspector.module.css'

function minutesText(seconds: number): string {
  return seconds < 60 ? 'under a minute' : `about ${Math.round(seconds / 60)} min`
}

/** The line under Re-time line: what it is doing, why it stopped, or what it costs before it can start. */
function RetimeNote({ lyricsRunning }: { lyricsRunning: boolean }) {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.realign)
  const [cost, setCost] = useState<Awaited<ReturnType<typeof retimeCost>>>(null)
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
  if (phase === 'running')
    return (
      <p className={styles.note}>
        {job?.title ?? 'Listening to the vocals'}… {pct(job)}%
      </p>
    )
  if (phase === 'failed' && job?.error?.code !== 'cancelled')
    return (
      <p className={styles.note} role="alert">
        {job?.error?.message ?? 'Something went wrong'}
        <br />
        Your lyrics are unchanged.
      </p>
    )
  if (lyricsRunning) return <p className={styles.note}>Lyrics are being timed now.</p>
  if (!cost) return null
  const parts = [
    cost.separatesStems ? 'separates the vocals first' : 'listens to the vocals first',
    ...(cost.downloadBytes ? [`${formatBytes(cost.downloadBytes)} download, once`] : []),
    `${minutesText(cost.seconds)} on this device`,
  ]
  return <p className={styles.note}>Re-timing {parts.join(' · ')}</p>
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

/** A lyric line's words and timing. */
function WordsSection({ line }: { line: LyricLine }) {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.realign)
  const running = runningJobs(useJobs())
  const lyricsRunning = running.some((j) => j.kind === JOB_KINDS.lyrics)
  // Listening to the vocals separates stems when the song has none; a second separation would double the memory.
  const stemsRunning = !songAnalysis(project)?.stems && running.some((j) => j.kind === JOB_KINDS.stems)
  const updateLine = (patch: { text?: string; start?: number; end?: number }) =>
    dispatch(
      { type: 'lyrics.updateLine', lineId: line.id, patch },
      { coalesceKey: `inspector:${line.id}:${Object.keys(patch).join()}` },
    )
  return (
    <Section title="Words">
      <div className={styles.padded}>
        <Input
          value={line.text}
          onChange={(e) => updateLine({ text: e.target.value })}
          onBlur={() => editor.endGesture()}
          aria-label="Lyric text"
        />
        <div className={styles.timedRow}>
          <TimingBadge line={line} />
          {phase === 'running' ? (
            <Button size="sm" variant="ghost" onClick={() => job && jobs.cancel(job.id)}>
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={!project.songAssetId || !line.text.trim() || lyricsRunning || stemsRunning}
              onClick={() => void retimeLine(line.id)}
            >
              Re-time line
            </Button>
          )}
        </div>
      </div>
      <RetimeNote lyricsRunning={lyricsRunning} />
      <FieldRow label="Start">
        <NumberField
          value={line.start ?? 0}
          onChange={(v) => updateLine({ start: v })}
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
          onChange={(v) => updateLine({ end: v })}
          onCommit={() => editor.endGesture()}
          step={0.01}
          precision={2}
          unit="s"
          ariaLabel="End time"
        />
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
