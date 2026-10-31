import { useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  Clock,
  FolderDown,
  HardDrive,
  Lock,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  Repeat,
  Scissors,
  Square,
} from 'lucide-react'
import {
  estimateRenderSeconds,
  planOutput,
  type ExportQuality,
  type OutputSpec,
  type PlannedOutput,
  type ReframeMode,
} from '../../../export/index.ts'
import type { ExportResolution } from '../../../engine/export.ts'
import type { AspectPreset, Project } from '../../../model/index.ts'
import { jobs, type JobSnapshot } from '../../../shared/jobs.ts'
import { Button } from '../../ds/Button.tsx'
import { Dialog } from '../../ds/Dialog.tsx'
import { Badge, ProgressBar } from '../../ds/Feedback.tsx'
import { Input, Segmented, Select } from '../../ds/Fields.tsx'
import { formatTime, plural } from '../../format.ts'
import { downloadAgain, useExports, type ExportRow } from '../../state/exports.ts'
import { useJobs } from '../../state/jobs.ts'
import { sectionColor, sectionKind, sectionsOf, timelineDuration, useProject } from '../../state/project.ts'
import { releaseStills, useStill, versionOf } from '../../state/stills.ts'
import { set, toast, useUi } from '../../state/ui.ts'
import {
  RATIO,
  addCandidate,
  candidateOutputs,
  initialItems,
  outputSummary,
  outputTitle,
  remainingCandidates,
  sizeLabel,
  specsLine,
  startOutputs,
  stillTime,
  timeLabel,
  withAspect,
  type OutputItem,
} from './outputs.ts'
import styles from './ExportDialog.module.css'

const aspectIcon = (a: AspectPreset) =>
  a === '16:9' ? <RectangleHorizontal /> : a === '1:1' ? <Square /> : <RectangleVertical />

const image = (url: string | undefined) => (url ? `url(${url})` : undefined)

/** Stills depend on the project, the output's layout and the moment, not on its name, size or quality. */
function stillKey(project: Project, planned: PlannedOutput, time: number): string {
  const { kind, aspect, reframe, range } = planned.spec
  return [versionOf(project), kind, aspect, reframe, range ? `${range.start}-${range.end}` : '', time].join(
    '|',
  )
}

function framingNote(planned: PlannedOutput): ReactNode {
  const { reframe } = planned.spec
  if (reframe === 'fit') return 'Shows the whole picture with bars. Text stays inside the safe area.'
  if (reframe === 'fill') return 'Crops the center of each shot. Text stays inside the safe area.'
  const unanalysed = planned.unanalysed.length
  if (unanalysed) return `${plural(unanalysed, 'clip')} without subject analysis are cropped in the center.`
  return (
    <>
      <Check /> Follows the subject in each shot. Text stays inside the safe area.
    </>
  )
}

function Frame({
  project,
  planned,
  playhead,
}: {
  project: Project
  planned: PlannedOutput
  playhead: number
}) {
  const { spec } = planned
  const same = spec.aspect === project.settings.aspect
  const sourceRatio = project.settings.width / project.settings.height
  const r = RATIO[spec.aspect]
  const time = stillTime(planned, playhead)
  const output = useStill(stillKey(project, planned, time), planned.project, time, r)
  const source = useStill(same ? null : `${versionOf(project)}|source|${time}`, project, time, sourceRatio)
  const box =
    r >= sourceRatio
      ? { left: 0, width: '100%', top: '50%', transform: 'translateY(-50%)' }
      : { top: 0, height: '100%', left: '50%', transform: 'translateX(-50%)' }
  return (
    <div className={styles.frameWrap}>
      <div
        className={styles.frameOuter}
        role="img"
        aria-label={`Preview of ${outputTitle(project, spec)}`}
        style={{
          aspectRatio: `${sourceRatio}`,
          // Portrait and square projects keep the 16:9 preview's height.
          width: sourceRatio < 16 / 9 ? `min(100%, ${Math.round(203 * sourceRatio)}px)` : undefined,
          backgroundImage: image(same ? output : source),
        }}
      >
        {!same && (
          <>
            <div className={styles.frameDim} />
            <div
              className={[styles.frame, styles.frameCrop].join(' ')}
              style={{ ...box, aspectRatio: `${r}`, backgroundImage: image(output), backgroundSize: 'cover' }}
            />
          </>
        )}
      </div>
      {!same && <div className={styles.frameNote}>{framingNote(planned)}</div>}
    </div>
  )
}

function rangeReason(planned: PlannedOutput): string {
  if (planned.loop) {
    const { bars, barAligned } = planned.loop
    return `${plural(bars, 'bar')}, ${barAligned ? 'loops seamlessly on the beat' : 'not on the beat, so the loop point may jump'}`
  }
  if (planned.spec.range) return 'the range you picked'
  const pick = planned.teaser
  if (pick?.source === 'chorus') return 'starts on the strongest chorus'
  if (pick?.source === 'section') return `starts on ${pick.label ?? 'a section'}, the most repeated part`
  if (pick?.source === 'energy') return 'the loudest part of the song'
  return 'the start of the song, as no chorus was found'
}

/** The song's sections with the output's range on top: where a teaser or loop comes from. */
function RangeLane({ project, planned }: { project: Project; planned: PlannedOutput }) {
  const duration = Math.max(timelineDuration(project), 1e-3)
  const { start, end } = planned.range
  const lane: { key: string; flex: number; background?: string }[] = []
  let cursor = 0
  for (const s of sectionsOf(project)) {
    if (s.start > cursor) lane.push({ key: `gap-${s.id}`, flex: s.start - cursor })
    lane.push({
      key: s.id,
      flex: s.end - s.start,
      background: `color-mix(in srgb, ${sectionColor[sectionKind(s)]} 45%, transparent)`,
    })
    cursor = Math.max(cursor, s.end)
  }
  if (cursor < duration)
    lane.push({
      key: 'end',
      flex: duration - cursor,
      background: cursor === 0 ? 'var(--bg-active)' : undefined,
    })
  return (
    <div className={styles.range}>
      <div className={styles.rangeLane}>
        {lane.map((s) => (
          <span key={s.key} style={{ flex: s.flex, background: s.background }} />
        ))}
        <span
          className={styles.rangeSel}
          style={{ left: `${(start / duration) * 100}%`, width: `${((end - start) / duration) * 100}%` }}
        />
      </div>
      <div className={`${styles.rangeText} tnum`}>
        {formatTime(start)} – {formatTime(end)} · {rangeReason(planned)}
      </div>
    </div>
  )
}

function OutputRow({
  project,
  item,
  planned,
  selected,
  playhead,
  onSelect,
  onToggle,
}: {
  project: Project
  item: OutputItem
  planned: PlannedOutput
  selected: boolean
  playhead: number
  onSelect: () => void
  onToggle: (on: boolean) => void
}) {
  const { spec } = item
  const title = outputTitle(project, spec)
  const time = stillTime(planned, playhead)
  const still = useStill(stillKey(project, planned, time), planned.project, time, RATIO[spec.aspect])
  return (
    <div
      className={[styles.output, selected && styles.outputOn].filter(Boolean).join(' ')}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
    >
      <label className={styles.check} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={item.on}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`Include ${title}`}
        />
        <span>
          <Check />
        </span>
      </label>
      <span className={styles.outThumb}>
        <span style={{ aspectRatio: `${RATIO[spec.aspect]}`, backgroundImage: image(still) }} />
      </span>
      <span className={styles.outText}>
        <span className={styles.outName}>
          {title}
          {spec.kind === 'video' && spec.aspect !== project.settings.aspect && <Badge>Auto-reframe</Badge>}
        </span>
        <span className={`${styles.outSpecs} tnum`}>{specsLine(planned)}</span>
      </span>
    </div>
  )
}

interface RowState {
  fraction: number
  status: string
}

/** Each file's share of the job is its share of the frames; files render in order. */
function rowStates(job: JobSnapshot | undefined, rows: ExportRow[]): RowState[] {
  const total = rows.reduce((sum, r) => sum + r.frames, 0) || 1
  const f = job?.status === 'succeeded' ? 1 : (job?.progress.fraction ?? 0)
  let before = 0
  return rows.map((r) => {
    const start = before / total
    const share = r.frames / total
    before += r.frames
    const own = Math.min(1, Math.max(0, (f - start) / share))
    if (!job) return { fraction: 0, status: 'Waiting' }
    if (job.status === 'succeeded') return { fraction: 1, status: 'Saved' }
    if (job.status === 'cancelled') return { fraction: own, status: 'Cancelled' }
    if (job.status === 'failed') {
      const current = f >= start && f < start + share
      return {
        fraction: own,
        status: current ? (job.error?.message ?? 'Failed') : own >= 1 ? 'Not saved' : 'Not exported',
      }
    }
    if (own <= 0) return { fraction: 0, status: 'Waiting' }
    if (own >= 1) return { fraction: 1, status: 'Rendered' }
    const pct = `${Math.round(own * 100)}%`
    const eta = job.progress.etaSeconds
    if (eta === undefined) return { fraction: own, status: pct }
    const left = (eta * (start + share - f)) / Math.max(1e-6, 1 - f)
    return {
      fraction: own,
      status: `${pct} · ${left < 50 ? 'less than a minute left' : `about ${Math.max(1, Math.round(left / 60))} min left`}`,
    }
  })
}

function ExportingView({ onClose }: { onClose: () => void }) {
  const { jobId, rows } = useExports()
  const job = useJobs().find((j) => j.id === jobId)
  const states = rowStates(job, rows)
  const running = job?.status === 'running' || job?.status === 'queued'
  const title = running
    ? `Exporting ${plural(rows.length, 'file')}`
    : job?.status === 'succeeded'
      ? `${plural(rows.length, 'file')} saved`
      : job?.status === 'failed'
        ? 'Export failed'
        : job?.status === 'cancelled'
          ? 'Export cancelled'
          : 'Nothing is exporting'
  const note = running
    ? 'Rendering on this device. You can keep editing; files save to your Downloads folder.'
    : job?.status === 'succeeded'
      ? 'Find them in your Downloads folder.'
      : job
        ? 'No files were saved.'
        : ''
  return (
    <div className={styles.exporting}>
      <div className={styles.exportingHead}>
        <div className={styles.exportingTitle}>{title}</div>
        <div className={styles.muted}>{note}</div>
      </div>
      <div className={styles.jobList}>
        {rows.map((r, i) => {
          const state = states[i] ?? { fraction: 0, status: 'Waiting' }
          const saved = job?.status === 'succeeded'
          return (
            <div key={r.id} className={styles.jobRow}>
              <span className={styles.jobIcon}>{aspectIcon(r.aspect)}</span>
              <div className={styles.jobMain}>
                <div className={styles.jobTop}>
                  <span className={styles.jobName}>{r.title}</span>
                  <span className={`${styles.muted} tnum`}>{state.status}</span>
                </div>
                <ProgressBar
                  value={state.fraction}
                  tone={saved ? 'success' : 'accent'}
                  label={`${r.title} progress`}
                />
              </div>
              {saved ? (
                <Button size="sm" variant="ghost" icon={<FolderDown />} onClick={() => downloadAgain(r.id)}>
                  Download
                </Button>
              ) : (
                <span className={styles.jobSpacer} />
              )}
            </div>
          )
        })}
      </div>
      <div className={styles.exportingFoot}>
        {running ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                if (job) jobs.cancel(job.id)
                set({ exportPhase: 'setup' })
              }}
            >
              Cancel all
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                onClose()
                toast('Export continues in the background')
              }}
            >
              Keep editing
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )}
      </div>
    </div>
  )
}

const RESOLUTIONS: { value: ExportResolution; label: string }[] = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '1440p', label: '1440p' },
  { value: '2160p', label: '4K' },
]

const FRAMING: { value: ReframeMode; label: string; description?: string }[] = [
  { value: 'auto', label: 'Follow the subject', description: 'Tracks people and motion in each shot' },
  { value: 'fill', label: 'Center crop' },
  { value: 'fit', label: 'Fit with bars' },
]

const QUALITY: { value: ExportQuality; label: string }[] = [
  { value: 'high', label: 'High · recommended' },
  { value: 'balanced', label: 'Balanced · smaller file' },
  { value: 'small', label: 'Small · quick to share' },
]

function ExportDialogBody() {
  const phase = useUi((s) => s.exportPhase)
  const playhead = useUi((s) => s.playhead)
  const project = useProject()
  const [items, setItems] = useState(() => initialItems(project))
  const [candidates] = useState(() => candidateOutputs(project))
  const [selectedId, setSelectedId] = useState(() => items[0]?.spec.id)
  const planned = useMemo(() => items.map((i) => planOutput(project, i.spec)), [project, items])
  const index = Math.max(
    0,
    items.findIndex((i) => i.spec.id === selectedId),
  )
  const sel = items[index]
  const selPlan = planned[index]
  const close = () => {
    releaseStills()
    set({ dialog: null, exportPhase: 'setup' })
  }
  if (!sel || !selPlan) return null

  const active = planned.filter((_, k) => items[k]?.on)
  const bytes = active.reduce((sum, p) => sum + p.estimatedBytes, 0)
  const seconds = active.reduce((sum, p) => sum + estimateRenderSeconds(p), 0)
  const update = (patch: Partial<OutputSpec>) =>
    setItems((list) =>
      list.map((i) => (i.spec.id === sel.spec.id ? { ...i, spec: { ...i.spec, ...patch } } : i)),
    )
  const remaining = remainingCandidates(candidates, items)
  const audio = sel.spec.audio ?? sel.spec.kind !== 'loop'
  const frameRates = [...new Set([24, 25, 30, 60, sel.spec.fps])].sort((a, b) => a - b)

  return (
    <Dialog
      open
      onOpenChange={(o) => (o ? set({ dialog: 'export' }) : close())}
      title="Export"
      description="Make one or more videos from this project. What you see in the preview is what you get."
      width={phase === 'exporting' ? 640 : 920}
      height={phase === 'exporting' ? undefined : 620}
      footer={
        phase === 'setup' ? (
          <>
            <div className={styles.summary}>
              <span>
                <HardDrive /> {sizeLabel(bytes)}
              </span>
              <span>
                <Clock /> {timeLabel(seconds)}
              </span>
              <span>
                <Lock /> Free · rendered in your browser
              </span>
            </div>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!active.length}
              onClick={() => {
                startOutputs(project, active)
                releaseStills()
                set({ exportPhase: 'exporting' })
              }}
            >
              Export {plural(active.length, 'file')}
            </Button>
          </>
        ) : undefined
      }
    >
      {phase === 'exporting' ? (
        <ExportingView onClose={close} />
      ) : (
        <div className={styles.layout}>
          <div className={styles.outputs}>
            <div className={styles.colLabel}>Outputs</div>
            {items.map((item, k) => {
              const plan = planned[k]
              if (!plan) return null
              return (
                <OutputRow
                  key={item.spec.id}
                  project={project}
                  item={item}
                  planned={plan}
                  selected={item.spec.id === sel.spec.id}
                  playhead={playhead}
                  onSelect={() => setSelectedId(item.spec.id)}
                  onToggle={(on) =>
                    setItems((list) => list.map((x) => (x.spec.id === item.spec.id ? { ...x, on } : x)))
                  }
                />
              )
            })}
            {remaining.length > 0 && <div className={styles.colLabel}>Add another</div>}
            {remaining.map((c) => (
              <button
                key={c.id}
                className={styles.suggest}
                onClick={() => {
                  const spec = addCandidate(project, c)
                  setItems((list) => [...list, { spec, on: true }])
                  setSelectedId(spec.id)
                }}
              >
                <span className={styles.suggestIcon}>
                  {c.kind === 'teaser' ? <Scissors /> : c.kind === 'loop' ? <Repeat /> : aspectIcon(c.aspect)}
                </span>
                <span className={styles.outText}>
                  <span className={styles.outName}>{outputTitle(project, c)}</span>
                  <span className={styles.outSpecs}>{outputSummary(project, c)}</span>
                </span>
                <Plus className={styles.plus} />
              </button>
            ))}
          </div>

          <div className={`${styles.settings} scroll`}>
            <Frame project={project} planned={selPlan} playhead={playhead} />
            {sel.spec.kind !== 'video' && <RangeLane project={project} planned={selPlan} />}
            <div className={styles.form}>
              <label className={styles.formRow}>
                <span>Name</span>
                <Input value={sel.spec.name} onChange={(e) => update({ name: e.target.value })} />
              </label>
              <div className={styles.formRow}>
                <span>Aspect</span>
                <Segmented
                  value={sel.spec.aspect}
                  onChange={(v) => update(withAspect(project, sel.spec, v))}
                  ariaLabel="Aspect ratio"
                  options={(['16:9', '9:16', '1:1', '4:5'] as const).map((a) => ({ value: a, label: a }))}
                />
              </div>
              {sel.spec.aspect !== project.settings.aspect && (
                <div className={styles.formRow}>
                  <span>Framing</span>
                  <Select
                    value={sel.spec.reframe}
                    onChange={(v) => update({ reframe: v })}
                    ariaLabel="Framing"
                    options={FRAMING}
                  />
                </div>
              )}
              <div className={styles.formRow}>
                <span>Resolution</span>
                <Segmented
                  value={sel.spec.resolution}
                  onChange={(v) => update({ resolution: v })}
                  ariaLabel="Resolution"
                  options={RESOLUTIONS}
                />
              </div>
              <div className={styles.formRow}>
                <span>Frame rate</span>
                <Segmented
                  value={String(sel.spec.fps)}
                  onChange={(v) => update({ fps: Number(v) })}
                  ariaLabel="Frame rate"
                  options={frameRates.map((v) => ({ value: String(v), label: String(v) }))}
                />
              </div>
              <div className={styles.formRow}>
                <span>Quality</span>
                <Select
                  value={sel.spec.quality}
                  onChange={(v) => update({ quality: v })}
                  ariaLabel="Quality"
                  options={QUALITY}
                />
              </div>
              <div className={styles.formRow}>
                <span>Format</span>
                <span className={styles.static}>MP4 · H.264 video, {audio ? 'AAC audio' : 'no audio'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** Mounted only while open, so every opening starts from the saved (or suggested) outputs. */
export function ExportDialog() {
  const open = useUi((s) => s.dialog === 'export')
  return open ? <ExportDialogBody /> : null
}
