import { useEffect } from 'react'
import { AlertTriangle, Check, Eye, Lock, RotateCcw, Undo2 } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBytes, plural } from '../../../format.ts'
import { isSampleAsset } from '../../../mock/sampleMedia.ts'
import {
  checkFootage,
  cutoutsOf,
  footageRows,
  hasCutout,
  putBehind,
  suitabilityText,
  suitableClips,
  useBehind,
  usePersonDownload,
  type FootageRow,
} from '../../../state/behind.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { editor, useProject } from '../../../state/project.ts'
import { set, toast } from '../../../state/ui.ts'
import { useThumbnail } from '../../../state/thumbs.ts'
import { dismiss, pct, useJob } from './jobState.ts'
import { CancelButton, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Behind the subject row of Assist's tool list. */
export function BehindBadge() {
  const { job, phase } = useJob(JOB_KINDS.cutout)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  return null
}

function SuitRow({ asset, suitability, clips }: FootageRow) {
  const thumb = useThumbnail(asset)
  const text = suitabilityText(suitability)
  const detail = `${(text.why ?? text.status).replace(/\.$/, '')} · ${plural(clips, 'clip')}`
  const checked = suitability.status === 'checked'
  return (
    <div className={styles.suitRow}>
      <span className={styles.suitThumb} style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} />
      <span className={styles.suitText}>
        <span className={styles.toolTitle}>{asset.name.replace(/\.[^.]+$/, '')}</span>
        <span className={checked ? (text.ok ? styles.okText : styles.warnText) : styles.muted}>{detail}</span>
      </span>
      {checked ? (
        text.ok ? (
          <Badge tone="success">Suitable</Badge>
        ) : (
          <Badge tone="warning">Not suitable</Badge>
        )
      ) : (
        <Badge>{suitability.status === 'checking' ? 'Checking…' : 'Not checked'}</Badge>
      )}
    </div>
  )
}

export function BehindView() {
  const { job, phase } = useJob(JOB_KINDS.cutout)
  const project = useProject()
  const checks = useBehind((s) => s.checks)
  const result = useBehind((s) => (job ? s.results[job.id] : undefined))
  const rows = footageRows(project, checks)
  const unchecked = rows
    .filter((r) => r.suitability.status === 'unchecked')
    .map((r) => r.asset.id)
    .join(',')
  const checking = rows.some(
    (r) => r.suitability.status === 'checking' || r.suitability.status === 'unchecked',
  )
  const download = usePersonDownload(rows.some((r) => !isSampleAsset(r.asset)))
  useEffect(() => {
    if (unchecked) checkFootage(unchecked.split(','))
  }, [unchecked])
  const targets = suitableClips(project, checks).filter((id) => !hasCutout(project, id))
  const apply = () => putBehind(targets)

  if (phase === 'running')
    return (
      <ToolView title="Behind the subject" subtitle="Cutting out" footer={<CancelButton job={job} />}>
        <RunCard job={job} label="Cutout progress" />
        <p className={styles.muted}>Nothing changes on the timeline until every cutout is ready.</p>
      </ToolView>
    )

  if (phase === 'failed')
    return (
      <ToolView
        title="Behind the subject"
        subtitle="Stopped"
        footer={
          <Button variant="primary" block icon={<RotateCcw />} onClick={apply} disabled={!targets.length}>
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

  if (phase === 'done' && result) {
    const first = Object.values(project.clips)
      .filter((c) => c.meta?.behindSubjectOf && editor.undoLabel() === result.label)
      .sort((a, b) => a.start - b.start)[0]
    const host =
      first && typeof first.meta?.behindSubjectOf === 'string' ? first.meta.behindSubjectOf : undefined
    const canUndo = result.count > 0 && editor.undoLabel() === result.label
    const undoButton = (
      <Button
        variant="secondary"
        icon={<Undo2 />}
        disabled={!canUndo}
        onClick={() => {
          if (canUndo && editor.undo()) toast('Lyrics are back in front')
          dismiss(job)
        }}
      >
        Undo
      </Button>
    )
    return (
      <ToolView
        title="Behind the subject"
        subtitle="Done"
        footer={
          <div className={styles.footerRow}>
            {canUndo || !result.count ? (
              undoButton
            ) : (
              <Tooltip
                label="You changed the project after this"
                description="Step back through your changes with Undo in the top bar."
                side="top"
              >
                <span tabIndex={0}>{undoButton}</span>
              </Tooltip>
            )}
            <Button
              variant="primary"
              className={styles.grow}
              icon={<Eye />}
              disabled={!host}
              onClick={() => {
                dismiss(job)
                const clip = host ? project.clips[host] : undefined
                if (clip) set({ selection: { type: 'clip', id: clip.id }, playhead: clip.start + 0.1 })
              }}
            >
              Show
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
              {result.count
                ? `Lyrics now sit behind the person on ${plural(result.count, 'clip')}`
                : 'No clip changed'}
            </div>
            <div className={styles.muted}>
              {result.count
                ? 'Each cutout is on the Subject track, above the lyrics.'
                : 'The clips have no person large enough to cut out, or already have a cutout.'}
            </div>
          </div>
        </div>
      </ToolView>
    )
  }

  const behindCount = Object.keys(project.clips).filter((id) => cutoutsOf(project, id).length).length
  const label = targets.length
    ? `Apply to ${plural(targets.length, 'suitable clip')}`
    : checking
      ? 'Checking your clips…'
      : behindCount
        ? 'No more suitable clips'
        : 'No suitable clips'
  const noneSuitable = !targets.length && !checking && !behindCount && rows.length > 0
  return (
    <ToolView
      title="Behind the subject"
      subtitle="Text sits between the person and the background"
      footer={
        <>
          <Button variant="primary" block onClick={apply} disabled={!targets.length}>
            {label}
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device · free
            {download ? ` · ${formatBytes(download)} download, once` : ''}
            {behindCount ? ` · ${plural(behindCount, 'clip')} already behind` : ''}
            {noneSuitable ? ' · no clip has a person to cut out' : ''}
          </div>
        </>
      }
    >
      <p className={styles.lede}>People are cut out automatically on this device.</p>
      <div className={styles.groupLabelInset}>Clips on the timeline</div>
      {rows.length ? (
        rows.map((row) => <SuitRow key={row.asset.id} {...row} />)
      ) : (
        <p className={styles.muted}>Add video clips to the timeline to cut out the people in them.</p>
      )}
    </ToolView>
  )
}
