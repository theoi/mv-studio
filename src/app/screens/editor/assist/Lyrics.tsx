import { useEffect, useState } from 'react'
import { AlertTriangle, Info, RotateCcw } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, TextArea } from '../../../ds/Fields.tsx'
import { formatBytes, plural } from '../../../format.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { estimateLyrics, lastLyricsRequest, startLyrics } from '../../../state/lyrics.ts'
import { hasSong, lyricLines, songAnalysis, useProject } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import { dismiss, pct, useJob } from './jobState.ts'
import { CancelButton, Field, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Lyrics row of Assist's tool list. */
export function LyricsBadge() {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.lyrics)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  if (lyricLines(project).some((l) => l.start !== undefined)) return <Badge tone="success">Timed</Badge>
  return null
}

type LyricsMode = 'paste' | 'draft'

const lyricsKind = (mode: LyricsMode) => (mode === 'paste' ? 'time' : 'draft')

function minutesText(seconds: number): string {
  return seconds < 60 ? 'under a minute' : `about ${Math.round(seconds / 60)} min`
}

/** The one line that says what pressing the button will do: separation, downloads and time on this device. */
function lyricsCost(e: Awaited<ReturnType<typeof estimateLyrics>>): { text: string; detail?: string } {
  if (!e) return { text: 'Uses the vocals stem for precise timing' }
  const parts = [
    ...(e.separatesStems ? ['Separates the vocals first'] : []),
    ...(e.downloadBytes ? [`${formatBytes(e.downloadBytes)} download, once`] : []),
    `${minutesText(e.seconds)} on this device`,
  ]
  const detail = e.downloads.map((d) => `${d.name} (${formatBytes(d.bytes)})`).join(', ')
  return { text: parts.join(' · '), ...(detail ? { detail: `Downloads ${detail}` } : {}) }
}

export function LyricsView() {
  const project = useProject()
  const lines = lyricLines(project)
  const { job, phase } = useJob(JOB_KINDS.lyrics)
  // Timing separates stems first when the song has none; two separations at once would need twice the memory.
  const separating = useJob(JOB_KINDS.stems).phase === 'running'
  const [mode, setMode] = useState<LyricsMode>('paste')
  const [text, setText] = useState(() => lines.map((l) => l.text).join('\n'))
  const [estimate, setEstimate] = useState<{
    mode: LyricsMode
    value: Awaited<ReturnType<typeof estimateLyrics>>
  }>()
  const stemsReady = !!songAnalysis(project)?.stems
  useEffect(() => {
    let live = true
    estimateLyrics(lyricsKind(mode)).then(
      (value) => live && setEstimate({ mode, value }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [mode, project.songAssetId, stemsReady, phase])
  const firstChorusLine = lines.find((l) => l.id.startsWith('l-c1'))
  const timed = lines.some((l) => l.start !== undefined)

  if (phase === 'running') {
    return (
      <ToolView
        title="Lyrics"
        subtitle={
          lastLyricsRequest?.kind === 'draft' ? 'Drafting from the vocals' : 'Timing words to the vocals'
        }
        footer={<CancelButton job={job} />}
      >
        <RunCard job={job} label="Lyrics progress" />
        <p className={styles.muted}>
          Keep editing; the lines land on the Lyrics track when they are ready, as one step you can undo.
        </p>
      </ToolView>
    )
  }
  if (phase === 'failed') {
    return (
      <ToolView
        title="Lyrics"
        subtitle="Stopped"
        footer={
          <div className={styles.footerRow}>
            <Button variant="secondary" onClick={() => dismiss(job)}>
              Edit lyrics
            </Button>
            <Button
              variant="primary"
              icon={<RotateCcw />}
              className={styles.grow}
              onClick={() => lastLyricsRequest && void startLyrics(lastLyricsRequest)}
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
              Your lyrics are unchanged.
              {stemsReady ? ' The separated stems are kept, so trying again is quicker.' : ''}
            </div>
          </div>
        </div>
      </ToolView>
    )
  }

  const cost = separating
    ? { text: 'Waiting for the stems to finish…' }
    : lyricsCost(estimate?.mode === mode ? estimate.value : null)
  const canRun = hasSong(project) && !separating && (mode === 'draft' || text.trim().length > 0)
  return (
    <ToolView
      title="Lyrics"
      subtitle={
        lines.length
          ? `${plural(lines.length, 'line')} · ${timed ? 'every word timed' : 'not timed yet'}`
          : 'Not added yet'
      }
      footer={
        <>
          <Button
            variant="primary"
            block
            disabled={!canRun}
            onClick={() => void startLyrics(mode === 'paste' ? { kind: 'time', text } : { kind: 'draft' })}
          >
            {mode === 'paste' ? 'Time words to the vocals' : 'Draft lyrics from the vocals'}
          </Button>
          <div className={styles.costLine} title={cost.detail}>
            <Info /> {cost.text}
          </div>
        </>
      }
    >
      <Segmented
        block
        value={mode}
        onChange={(v) => setMode(v as LyricsMode)}
        ariaLabel="Lyrics source"
        options={[
          { value: 'paste', label: 'Paste lyrics' },
          { value: 'draft', label: 'Draft from vocals' },
        ]}
      />
      {mode === 'paste' ? (
        <Field label="Lyrics" hint="Each line becomes a lyric line on the Lyrics track.">
          <TextArea rows={8} aria-label="Lyrics" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      ) : (
        <div className={styles.callout}>
          <Info />
          <div>
            A draft is written and timed from the vocals on this device. Sung lyrics are tricky, so check each
            line afterwards.
            {lines.length
              ? ` It replaces the ${plural(lines.length, 'line')} you have; you can undo it.`
              : ''}
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
