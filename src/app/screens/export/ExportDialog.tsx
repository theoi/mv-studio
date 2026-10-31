import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { create } from 'zustand'
import {
  Check,
  ChevronLeft,
  ChevronRight,
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
  barTimes,
  estimateRenderSeconds,
  framingOverrides,
  loopLengthOf,
  loopLengthRange,
  loopLengths,
  loopSeam,
  movedRange,
  planOutput,
  teaserLengthPatch,
  TEASER_CHOICES,
  type ExportQuality,
  type OutputSpec,
  type PlannedOutput,
  type ReframeMode,
} from '../../../export/index.ts'
import type { ExportResolution } from '../../../engine/export.ts'
import type { AspectPreset, Project } from '../../../model/index.ts'
import { jobs, type JobSnapshot } from '../../../shared/jobs.ts'
import { Button, IconButton } from '../../ds/Button.tsx'
import { Dialog } from '../../ds/Dialog.tsx'
import { Badge, ProgressBar } from '../../ds/Feedback.tsx'
import { Input, Segmented, Select } from '../../ds/Fields.tsx'
import { formatTime, plural } from '../../format.ts'
import { downloadAgain, useExports, type ExportRow } from '../../state/exports.ts'
import { startFootageAnalysis } from '../../state/footage.ts'
import { JOB_KINDS, useJobs } from '../../state/jobs.ts'
import {
  sectionColor,
  sectionKind,
  sectionName,
  sectionsOf,
  timelineDuration,
  useProject,
} from '../../state/project.ts'
import { releaseStills, useStill, versionOf } from '../../state/stills.ts'
import { set, toast, useUi } from '../../state/ui.ts'
import {
  RATIO,
  addCandidate,
  adjustFraming,
  candidateOutputs,
  cropBox,
  initialItems,
  outputSummary,
  outputTitle,
  remainingCandidates,
  shotTime,
  shotsOf,
  sizeLabel,
  specsLine,
  startOutputs,
  stillTime,
  subjectCounts,
  timeLabel,
  withAspect,
  type OutputItem,
} from './outputs.ts'
import styles from './ExportDialog.module.css'

const aspectIcon = (a: AspectPreset) =>
  a === '16:9' ? <RectangleHorizontal /> : a === '1:1' ? <Square /> : <RectangleVertical />

const image = (url: string | undefined) => (url ? `url(${url})` : undefined)

/** Stills depend on the project, the output's layout and range and the moment, not on its name, size or quality. */
function stillKey(project: Project, planned: PlannedOutput, time: number): string {
  const { kind, aspect, reframe } = planned.spec
  const { start, end } = planned.range
  return [versionOf(project), kind, aspect, reframe, `${start}-${end}`, time].join('|')
}

const CLIP_MODE_NOTES = {
  auto: 'follows the subject',
  fill: 'crops the center',
  fit: 'shows the whole picture with bars',
} as const

function framingNote(
  project: Project,
  planned: PlannedOutput,
  adjusted: boolean,
  clipMode: 'auto' | 'fill' | 'fit' | undefined,
  indexing: JobSnapshot | undefined,
): ReactNode {
  const { reframe } = planned.spec
  if (adjusted) return 'Adjusted by hand. Double-click the frame to reset this shot.'
  if (clipMode && clipMode !== reframe)
    return `This shot ${CLIP_MODE_NOTES[clipMode]}, as set in Inspector › Framing.`
  if (reframe === 'fit') return 'Shows the whole picture with bars.'
  const unanalysed = planned.unanalysed.length
  if (unanalysed && indexing)
    return `Analyzing footage for framing… ${Math.round((indexing.progress.fraction ?? 0) * 100)}%`
  if (unanalysed)
    return `${plural(unanalysed, 'clip')} without subject analysis ${unanalysed === 1 ? 'is' : 'are'} centered. Drag the frame to adjust this shot.`
  if (reframe === 'fill') return 'Crops the center of each shot. Drag the frame to adjust this shot.'
  const { clips, nobody } = subjectCounts(project, planned)
  if (nobody && nobody === clips)
    return 'No one is in these clips, so they stay centered. Drag the frame to adjust this shot.'
  if (nobody)
    return `Follows the subject. ${plural(nobody, 'clip')} with no one in ${nobody === 1 ? 'it stays' : 'them stay'} centered.`
  return (
    <>
      <Check /> Follows the subject in each shot. Drag the frame to adjust this shot.
    </>
  )
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface Drag {
  pointerId: number
  x: number
  y: number
  dx: number
  dy: number
  /** Size of the preview in CSS pixels when the drag started. */
  width: number
  height: number
}

/**
 * The selected output at one moment. For reframed outputs, the output's frame sits over the dimmed source where its
 * crop is; dragging it (or arrow keys) moves the framing of the shot shown, and the stepper moves between shots.
 */
function Frame({
  project,
  planned,
  time,
  onTime,
}: {
  project: Project
  planned: PlannedOutput
  time: number
  onTime: (time: number) => void
}) {
  const { spec } = planned
  const same = spec.aspect === project.settings.aspect
  const sourceRatio = project.settings.width / project.settings.height
  const r = RATIO[spec.aspect]
  const output = useStill(stillKey(project, planned, time), planned.project, time, r)
  const source = useStill(same ? null : `${versionOf(project)}|source|${time}`, project, time, sourceRatio)
  const indexing = useJobs().find(
    (j) => j.kind === JOB_KINDS.footage && (j.status === 'running' || j.status === 'queued'),
  )
  const [drag, setDrag] = useState<Drag | null>(null)
  const shots = useMemo(() => (same ? [] : shotsOf(project, planned)), [same, project, planned])
  const index = shots.findIndex((s) => time >= s.start && time < s.end)
  const shot = shots[index]
  const override = shot ? framingOverrides(project, spec.aspect)[shot.clipId] : undefined
  const box =
    shot && (override?.mode ?? spec.reframe) !== 'fit' ? cropBox(project, planned, shot.clipId, time) : null
  const anchor = shot ? shot.start : time
  const previous = [...shots].reverse().find((s) => s.start < anchor - 1e-3)
  const next = shots.find((s) => s.start > anchor + 1e-3)

  /** Moves the shot's framing by a share of the crop, kept where the crop can still go. */
  const move = (fx: number, fy: number) => {
    if (!shot || !box) return
    const x = clamp(fx, -box.left / box.width, (1 - box.left - box.width) / box.width)
    const y = clamp(fy, -box.top / box.height, (1 - box.top - box.height) / box.height)
    if (Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4) return
    adjustFraming(spec.aspect, shot.clipId, {
      offsetX: clamp((override?.offsetX ?? 0) + x, -2, 2),
      offsetY: clamp((override?.offsetY ?? 0) + y, -2, 2),
    })
  }

  let boxStyle: CSSProperties
  if (box) {
    const left = box.left + (drag ? drag.dx / drag.width : 0)
    const top = box.top + (drag ? drag.dy / drag.height : 0)
    // While dragging, and until the moved output is drawn, the frame is a window onto the source.
    const windowed = (drag || !output) && source
    boxStyle = {
      left: `${left * 100}%`,
      top: `${top * 100}%`,
      width: `${box.width * 100}%`,
      height: `${box.height * 100}%`,
      cursor: drag ? 'grabbing' : 'grab',
      touchAction: 'none',
      ...(windowed
        ? {
            backgroundImage: image(source),
            backgroundSize: `${100 / box.width}% ${100 / box.height}%`,
            backgroundPosition: `${box.width < 1 ? (100 * left) / (1 - box.width) : 0}% ${box.height < 1 ? (100 * top) / (1 - box.height) : 0}%`,
          }
        : { backgroundImage: image(output), backgroundSize: 'cover' }),
    }
  } else {
    boxStyle = {
      ...(r >= sourceRatio
        ? { left: 0, width: '100%', top: '50%', transform: 'translateY(-50%)' }
        : { top: 0, height: '100%', left: '50%', transform: 'translateX(-50%)' }),
      aspectRatio: `${r}`,
      backgroundImage: image(output),
      backgroundSize: 'cover',
    }
  }

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
              style={boxStyle}
              {...(box && {
                tabIndex: 0,
                'aria-label': `Framing of shot ${index + 1}. Drag or use the arrow keys to move it; double-click to reset.`,
                onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
                  const outer = e.currentTarget.parentElement?.getBoundingClientRect()
                  if (e.button !== 0 || !outer) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({
                    pointerId: e.pointerId,
                    x: e.clientX,
                    y: e.clientY,
                    dx: 0,
                    dy: 0,
                    width: outer.width,
                    height: outer.height,
                  })
                },
                onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
                  if (!drag || e.pointerId !== drag.pointerId) return
                  setDrag({
                    ...drag,
                    dx: clamp(
                      e.clientX - drag.x,
                      -box.left * drag.width,
                      (1 - box.left - box.width) * drag.width,
                    ),
                    dy: clamp(
                      e.clientY - drag.y,
                      -box.top * drag.height,
                      (1 - box.top - box.height) * drag.height,
                    ),
                  })
                },
                onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
                  if (!drag || e.pointerId !== drag.pointerId) return
                  setDrag(null)
                  move(drag.dx / (box.width * drag.width), drag.dy / (box.height * drag.height))
                },
                onPointerCancel: () => setDrag(null),
                onDoubleClick: () => {
                  if (shot && override) adjustFraming(spec.aspect, shot.clipId, null)
                },
                onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                  const step = e.shiftKey ? 0.1 : 0.02
                  const d = {
                    ArrowLeft: [-step, 0],
                    ArrowRight: [step, 0],
                    ArrowUp: [0, -step],
                    ArrowDown: [0, step],
                  }[e.key]
                  if (!d) return
                  e.preventDefault()
                  move(d[0] ?? 0, d[1] ?? 0)
                },
              })}
            />
          </>
        )}
      </div>
      {!same && (
        <div className={styles.frameNote}>
          <span className={styles.noteText}>
            {framingNote(
              project,
              planned,
              Boolean(override && (override.offsetX || override.offsetY || (override.zoom ?? 1) !== 1)),
              override?.mode,
              indexing,
            )}
          </span>
          {shots.length > 0 && (
            <span className={styles.shotStepper}>
              <IconButton
                label="Previous shot"
                size="sm"
                disabled={!previous}
                onClick={() => previous && onTime(shotTime(previous))}
              >
                <ChevronLeft />
              </IconButton>
              <span className="tnum">
                {index >= 0 ? `Shot ${index + 1} of ${shots.length}` : plural(shots.length, 'shot')}
              </span>
              <IconButton
                label="Next shot"
                size="sm"
                disabled={!next}
                onClick={() => next && onTime(shotTime(next))}
              >
                <ChevronRight />
              </IconButton>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
function rangeReason(project: Project, planned: PlannedOutput): string {
  if (planned.loop) {
    const { bars, barAligned } = planned.loop
    return `${plural(bars, 'bar')}, ${barAligned ? 'loops seamlessly on the beat' : 'not on the beat, so the loop point may jump'}`
  }
  const section = planned.spec.section && sectionsOf(project).find((s) => s.id === planned.spec.section)
  if (section) return `starts on ${sectionName(section)}`
  if (planned.spec.range) return 'the range you picked'
  const pick = planned.teaser
  if (pick?.source === 'chorus') return 'starts on the strongest chorus'
  if (pick?.source === 'section') return `starts on ${pick.label ?? 'a section'}, the most repeated part`
  if (pick?.source === 'energy') return 'the loudest part of the song'
  return 'the start of the song, as no chorus was found'
}

/**
 * The song's sections with the output's range on top: where a teaser or loop comes from. The range is dragged, moved
 * a bar at a time with the arrow keys, or placed by clicking the lane; it lands on bars.
 */
function RangeLane({
  project,
  planned,
  title,
  onMove,
}: {
  project: Project
  planned: PlannedOutput
  title: string
  onMove: (start: number) => void
}) {
  const [drag, setDrag] = useState<{ pointerId: number; x: number; width: number; at: number } | null>(null)
  const duration = Math.max(timelineDuration(project), 1e-3)
  const length = planned.range.end - planned.range.start
  const start = drag ? drag.at : planned.range.start
  const end = start + length
  const latest = Math.max(0, duration - length)
  const step = (direction: 1 | -1) => {
    const from = planned.range.start
    const bars = barTimes(project)
    const next =
      bars.length >= 2
        ? direction > 0
          ? bars.find((b) => b > from + 1e-3)
          : bars.findLast((b) => b < from - 1e-3)
        : from + direction
    if (next !== undefined) onMove(clamp(next, 0, latest))
  }
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
      <div
        className={styles.rangeLane}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const at = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * duration
          onMove(clamp(at - length / 2, 0, latest))
        }}
      >
        {lane.map((s) => (
          <span key={s.key} style={{ flex: s.flex, background: s.background }} />
        ))}
        <span
          className={styles.rangeSel}
          style={{ left: `${(start / duration) * 100}%`, width: `${(length / duration) * 100}%` }}
          role="slider"
          tabIndex={0}
          aria-label={`${title} range`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(start * 10) / 10}
          aria-valuetext={`${formatTime(start)} to ${formatTime(end)}`}
          onPointerDown={(e) => {
            e.stopPropagation()
            const lane = e.currentTarget.parentElement
            e.currentTarget.setPointerCapture(e.pointerId)
            setDrag({ pointerId: e.pointerId, x: e.clientX, width: lane?.clientWidth ?? 1, at: start })
          }}
          onPointerMove={(e) => {
            if (drag?.pointerId !== e.pointerId) return
            const at = planned.range.start + ((e.clientX - drag.x) / drag.width) * duration
            setDrag({ ...drag, at: clamp(at, 0, latest) })
          }}
          onPointerUp={(e) => {
            if (drag?.pointerId !== e.pointerId) return
            if (Math.abs(drag.at - planned.range.start) > 1e-3) onMove(drag.at)
            setDrag(null)
          }}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={(e) => {
            if (e.key === 'Home' || e.key === 'End') onMove(e.key === 'Home' ? 0 : latest)
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') step(e.key === 'ArrowLeft' ? -1 : 1)
            else return
            e.preventDefault()
          }}
        />
      </div>
      <div className={`${styles.rangeText} tnum`}>
        {formatTime(start)} – {formatTime(end)} · {rangeReason(project, planned)}
      </div>
      {planned.loop && <LoopSeam project={project} planned={planned} />}
    </div>
  )
}

/** A loop's last frame next to its first: when they look alike, the loop plays round without a jump. */
function LoopSeam({ project, planned }: { project: Project; planned: PlannedOutput }) {
  const seam = loopSeam(planned)
  const ratio = RATIO[planned.spec.aspect]
  const key = (t: number | undefined) => (t === undefined ? null : stillKey(project, planned, t))
  const last = useStill(key(seam?.last), planned.project, seam?.last ?? 0, ratio, 160)
  const first = useStill(key(seam?.first), planned.project, seam?.first ?? 0, ratio, 160)
  if (!seam) return null
  return (
    <div className={styles.seam}>
      <span className={styles.seamFrame}>
        <span
          role="img"
          aria-label="Last frame of the loop"
          style={{ aspectRatio: `${ratio}`, backgroundImage: image(last) }}
        />
        Ends on
      </span>
      <Repeat className={styles.seamIcon} />
      <span className={styles.seamFrame}>
        <span
          role="img"
          aria-label="First frame of the loop"
          style={{ aspectRatio: `${ratio}`, backgroundImage: image(first) }}
        />
        Starts again on
      </span>
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
function rowStates(job: JobSnapshot | undefined, rows: ExportRow[], files: Record<string, File>): RowState[] {
  const total = rows.reduce((sum, r) => sum + r.frames, 0) || 1
  const f = job?.status === 'succeeded' ? 1 : (job?.progress.fraction ?? 0)
  let before = 0
  return rows.map((r) => {
    const start = before / total
    const share = r.frames / total
    before += r.frames
    const own = Math.min(1, Math.max(0, (f - start) / share))
    if (files[r.id]) return { fraction: 1, status: 'Saved' }
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
  const { jobId, rows, files } = useExports()
  const job = useJobs().find((j) => j.id === jobId)
  const states = rowStates(job, rows, files)
  const savedCount = rows.filter((r) => files[r.id]).length
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
        ? savedCount
          ? `${plural(savedCount, 'file')} saved to your Downloads folder.`
          : 'No files were saved.'
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
          const saved = Boolean(files[r.id])
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
                // Files that are done stay listed with Download; with none, go back to the outputs.
                if (!savedCount) set({ exportPhase: 'setup' })
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

interface OutputsDraft {
  items: OutputItem[]
  selectedId: string | undefined
}

/**
 * The outputs being edited live outside the dialog's components, so a remount while the dialog is open keeps the
 * user's choices. Closing the dialog drops them: the next opening starts from the saved (or suggested) outputs.
 */
const useDraft = create<{ draft: OutputsDraft | null }>(() => ({ draft: null }))
useUi.subscribe((s, prev) => {
  if (prev.dialog !== 'export' || s.dialog === 'export') return
  useDraft.setState({ draft: null })
  useExports.setState({ teaserSection: null })
})

function ExportDialogBody() {
  const phase = useUi((s) => s.exportPhase)
  const playhead = useUi((s) => s.playhead)
  const project = useProject()
  const [initial] = useState<OutputsDraft>(() => initialItems(project, useExports.getState().teaserSection))
  const { items, selectedId } = useDraft((s) => s.draft) ?? initial
  const edit = (change: (draft: OutputsDraft) => Partial<OutputsDraft>) => {
    const draft = useDraft.getState().draft ?? initial
    useDraft.setState({ draft: { ...draft, ...change(draft) } })
  }
  const setItems = (change: (list: OutputItem[]) => OutputItem[]) =>
    edit((draft) => ({ items: change(draft.items) }))
  const setSelectedId = (selectedId: string) => edit(() => ({ selectedId }))
  const [candidates] = useState(() => candidateOutputs(project))
  // Reframed outputs follow the subjects that footage analysis finds.
  useEffect(startFootageAnalysis, [])
  /** The moment the preview shows once a shot is picked; otherwise each output's own moment. */
  const [viewTime, setViewTime] = useState<number | null>(null)
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
  const loopChoices = sel.spec.kind === 'loop' ? loopLengths(project, selPlan.range.start) : []
  const loopNow = loopLengthOf(selPlan)
  const loopValue = (l: { bars: number; seconds: number }) => (l.bars > 0 ? `b${l.bars}` : `s${l.seconds}`)

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
            <Frame
              project={project}
              planned={selPlan}
              time={
                viewTime !== null && viewTime >= selPlan.range.start && viewTime < selPlan.range.end
                  ? viewTime
                  : stillTime(selPlan, playhead)
              }
              onTime={setViewTime}
            />
            {sel.spec.kind !== 'video' && (
              <RangeLane
                project={project}
                planned={selPlan}
                title={outputTitle(project, sel.spec)}
                onMove={(start) => {
                  const range = movedRange(project, selPlan, start)
                  if (range) update({ range, section: undefined })
                }}
              />
            )}
            <div className={styles.form}>
              <label className={styles.formRow}>
                <span>Name</span>
                <Input value={sel.spec.name} onChange={(e) => update({ name: e.target.value })} />
              </label>
              {sel.spec.kind === 'teaser' && (
                <div className={styles.formRow}>
                  <span>Length</span>
                  <Segmented
                    value={sel.spec.maxLength ? String(sel.spec.maxLength) : 'section'}
                    onChange={(v) =>
                      update(teaserLengthPatch(project, selPlan, v === 'section' ? null : Number(v)))
                    }
                    ariaLabel="Teaser length"
                    options={[
                      { value: 'section', label: sectionsOf(project).length > 0 ? 'Whole section' : 'Auto' },
                      ...TEASER_CHOICES.map((s) => ({ value: String(s), label: `Up to ${s} s` })),
                    ]}
                  />
                </div>
              )}
              {sel.spec.kind === 'loop' && loopChoices.length > 0 && (
                <div className={styles.formRow}>
                  <span>Length</span>
                  <Segmented
                    value={loopValue(loopNow)}
                    onChange={(v) => {
                      const choice = loopChoices.find((l) => loopValue(l) === v)
                      const range = choice && loopLengthRange(project, selPlan, choice)
                      if (range) update({ range })
                    }}
                    ariaLabel="Loop length"
                    options={loopChoices.map((l) => ({
                      value: loopValue(l),
                      label:
                        l.bars > 0
                          ? `${plural(l.bars, 'bar')} · ${Math.round(l.seconds * 10) / 10} s`
                          : `${l.seconds} s`,
                    }))}
                  />
                </div>
              )}
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

export function ExportDialog() {
  const open = useUi((s) => s.dialog === 'export')
  return open ? <ExportDialogBody /> : null
}
