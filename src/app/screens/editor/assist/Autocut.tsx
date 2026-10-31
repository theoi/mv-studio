import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Info, Lock, RotateCcw, Scissors, Undo2, Upload } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { Segmented, Select, Switch } from '../../../ds/Fields.tsx'
import { formatBytes, formatTime, plural } from '../../../format.ts'
import {
  autoCutClipCount,
  autoCutOptions,
  matchingDownloadBytes,
  selectedAsset,
  setAutoCutChoices,
  startAutoCut,
  targetSection,
  unanalyzedClipCount,
  undoAutoCut,
  useAutoCut,
} from '../../../state/autocut.ts'
import { analyzeFootageNow, useFootage } from '../../../state/footage.ts'
import { openImport } from '../../../state/importer.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { editor, sectionName, useProject } from '../../../state/project.ts'
import { toast, useUi } from '../../../state/ui.ts'
import { dismiss, pct, useJob } from './jobState.ts'
import { CancelButton, Field, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Auto-cut row of Assist's tool list. */
export function AutocutBadge() {
  const { job, phase } = useJob(JOB_KINDS.autocut)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  return null
}

/** Bytes the matching model still needs to download when this cut starts footage analysis, else 0. */
function useMatchingDownload(needed: boolean): number {
  const [bytes, setBytes] = useState(0)
  useEffect(() => {
    if (!needed) return
    let live = true
    void matchingDownloadBytes().then((b) => {
      if (live) setBytes(b)
    })
    return () => {
      live = false
    }
  }, [needed])
  return needed ? bytes : 0
}

export function AutocutView() {
  const { job, phase } = useJob(JOB_KINDS.autocut)
  const project = useProject()
  const selection = useUi((s) => s.selection)
  const playhead = useUi((s) => s.playhead)
  const choices = useAutoCut((s) => s.choices)
  const result = useAutoCut((s) => (job ? s.results[job.id] : undefined))
  const indexing = useFootage((s) => s.indexing)
  const clipCount = autoCutClipCount(project)
  const unanalyzed = unanalyzedClipCount(project)
  const section = targetSection(project, selection, playhead)
  const asset = selectedAsset(project, selection)
  const range = choices.range === 'section' && section ? 'section' : 'all'
  const clips = choices.clips === 'selected' && asset ? 'selected' : 'all'
  const analyzing = indexing?.status === 'indexing'
  const willAnalyze = choices.matchMood && unanalyzed > 0 && !analyzing
  const download = useMatchingDownload(willAnalyze)
  const cut = () => {
    if (willAnalyze) analyzeFootageNow()
    startAutoCut(autoCutOptions({ ...choices, range, clips }, project, selection, playhead))
  }

  if (phase === 'running')
    return (
      <ToolView title="Auto-cut" subtitle="Cutting to the beat" footer={<CancelButton job={job} />}>
        <RunCard job={job} label="Auto-cut progress" />
        <p className={styles.muted}>Nothing changes on the timeline until the cut is ready.</p>
      </ToolView>
    )

  if (phase === 'failed')
    return (
      <ToolView
        title="Auto-cut"
        subtitle="Cut stopped"
        footer={
          clipCount ? (
            <Button variant="primary" block icon={<RotateCcw />} onClick={cut}>
              Try again
            </Button>
          ) : (
            <Button variant="primary" block icon={<Upload />} onClick={() => openImport('media')}>
              Import clips
            </Button>
          )
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

  if (phase === 'done' && result) {
    const cuts = result.stats.cuts
    const { start, end } = result.plan.range
    const songEnd = project.songAssetId ? (project.assets[project.songAssetId]?.duration ?? end) : end
    const whole = start < 0.05 && end > songEnd - 0.05
    const canUndo = editor.undoLabel() === result.label
    const undoButton = (
      <Button
        variant="secondary"
        icon={<Undo2 />}
        disabled={!canUndo}
        onClick={() => {
          if (undoAutoCut(result)) toast('Cuts removed')
          dismiss(job)
        }}
      >
        Undo
      </Button>
    )
    return (
      <ToolView
        title="Auto-cut"
        subtitle="Cut ready"
        footer={
          <div className={styles.footerRow}>
            {canUndo ? (
              undoButton
            ) : (
              <Tooltip
                label="You changed the project after this cut"
                description="Step back through your changes with Undo in the top bar."
                side="top"
              >
                <span tabIndex={0}>{undoButton}</span>
              </Tooltip>
            )}
            <Button variant="primary" className={styles.grow} icon={<Check />} onClick={() => dismiss(job)}>
              Keep {plural(cuts, 'cut')}
            </Button>
          </div>
        }
      >
        <div className={styles.success}>
          <span className={styles.successIcon}>
            <Check />
          </span>
          <div>
            <div className={styles.successTitle}>
              {whole
                ? `Cut the song into ${plural(cuts, 'shot')}`
                : `Cut ${formatTime(start)}–${formatTime(end)} into ${plural(cuts, 'shot')}`}
            </div>
            <div className={styles.muted}>
              On the Auto-cut track. Cutting again replaces only the clips you haven’t changed.
            </div>
          </div>
        </div>
        {result.warnings.length > 0 && (
          <div className={styles.callout} role="status">
            <Info />
            <div>
              {result.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          </div>
        )}
      </ToolView>
    )
  }

  const note = !clipCount
    ? 'Import video clips or images first. Auto-cut cuts them to the song.'
    : choices.matchMood && analyzing
      ? `Analyzing your footage… ${indexing?.done ?? 0} of ${indexing?.total ?? clipCount} clips. Cut again when it’s done to match the mood.`
      : willAnalyze
        ? `${unanalyzed === clipCount ? 'Your clips aren’t' : `${plural(unanalyzed, 'clip')} aren’t`} analyzed yet, so this cut picks them for variety and starts the analysis. Cut again when it’s done to match the mood.`
        : undefined
  return (
    <ToolView
      title="Auto-cut"
      subtitle="Cut your clips to the music"
      footer={
        <>
          <Button variant="primary" block icon={<Scissors />} onClick={cut} disabled={!clipCount}>
            Cut to the beat
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device · free{download ? ` · ${formatBytes(download)} download, once` : ''}
          </div>
        </>
      }
    >
      {note && (
        <div className={styles.callout}>
          <Info />
          <div>{note}</div>
        </div>
      )}
      <Field label="Cut every">
        <Segmented
          block
          value={choices.pace}
          onChange={(pace) => setAutoCutChoices({ pace })}
          ariaLabel="Cut pace"
          options={[
            { value: 'beat', label: 'Beat' },
            { value: '2-beats', label: '2 beats' },
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
        <Switch
          checked={choices.followEnergy}
          onCheckedChange={(followEnergy) => setAutoCutChoices({ followEnergy })}
          ariaLabel="Follow the song’s energy"
        />
      </label>
      <label className={styles.switchRow}>
        <span>
          <span className={styles.switchTitle}>Match clips to the mood</span>
          <span className={styles.fieldHint}>Uses footage tags, like “crowd” for choruses</span>
        </span>
        <Switch
          checked={choices.matchMood}
          onCheckedChange={(matchMood) => setAutoCutChoices({ matchMood })}
          ariaLabel="Match clips to the mood"
        />
      </label>
      <Field label="Range">
        <Select
          value={range}
          onChange={(value) => setAutoCutChoices({ range: value })}
          ariaLabel="Range"
          options={[
            { value: 'all', label: 'Whole song' },
            ...(section
              ? [
                  {
                    value: 'section' as const,
                    label: selection.type === 'section' ? 'Selected section' : 'Section at the playhead',
                    description: `${sectionName(section)} · ${formatTime(section.start)}–${formatTime(section.end)}`,
                  },
                ]
              : []),
          ]}
        />
      </Field>
      <Field label="Clips">
        <Select
          value={clips}
          onChange={(value) => setAutoCutChoices({ clips: value })}
          ariaLabel="Clips to use"
          options={[
            { value: 'all', label: `All ${plural(clipCount, 'clip')} in the library` },
            ...(asset
              ? [{ value: 'selected' as const, label: 'Selected clips', description: asset.name }]
              : []),
          ]}
        />
      </Field>
    </ToolView>
  )
}
