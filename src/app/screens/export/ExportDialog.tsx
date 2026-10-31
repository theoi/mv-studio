import { useState } from 'react'
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
  X,
} from 'lucide-react'
import { jobs, type JobSnapshot } from '../../../shared/jobs.ts'
import { Button, IconButton } from '../../ds/Button.tsx'
import { Dialog } from '../../ds/Dialog.tsx'
import { Badge, ProgressBar } from '../../ds/Feedback.tsx'
import { Input, Segmented, Select } from '../../ds/Fields.tsx'
import { formatTime } from '../../format.ts'
import { sceneThumb } from '../../mock/art.ts'
import type { ExportResolution } from '../../../engine/export.ts'
import { downloadAgain, exportTitle, startExports, type ExportKind } from '../../state/exports.ts'
import { JOB_KINDS, useJobs } from '../../state/jobs.ts'
import { sectionColor, sectionKind, sectionsOf, timelineDuration, useProject } from '../../state/project.ts'
import { set, toast, useUi } from '../../state/ui.ts'
import styles from './ExportDialog.module.css'

interface Output {
  id: string
  kind: ExportKind
  name: string
  aspect: '16:9' | '9:16' | '1:1' | '4:5'
  res: string
  fps: string
  on: boolean
}

const suggestions: Omit<Output, 'id' | 'on'>[] = [
  { kind: 'format', name: 'Square', aspect: '1:1', res: '1080', fps: '30' },
  { kind: 'teaser', name: 'Chorus teaser', aspect: '9:16', res: '1080', fps: '30' },
  { kind: 'loop', name: 'Loop for Canvas', aspect: '9:16', res: '720', fps: '30' },
]

const ratio: Record<Output['aspect'], number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 }
const aspectIcon = (a: Output['aspect']) =>
  a === '16:9' ? <RectangleHorizontal /> : a === '1:1' ? <Square /> : <RectangleVertical />

function lengthOf(o: Output, duration: number) {
  return o.kind === 'teaser' ? 15 : o.kind === 'loop' ? 8 : duration
}

function specs(o: Output, duration: number) {
  const len = o.kind === 'teaser' ? '15 s' : o.kind === 'loop' ? '8 s loop' : formatTime(duration)
  return `${o.aspect} · ${o.res === '2160' ? '4K' : `${o.res}p`} · ${o.fps} fps · ${len}`
}

function sizeMB(o: Output, duration: number) {
  const rate = o.res === '2160' ? 4.5 : o.res === '1440' ? 2.4 : o.res === '1080' ? 1.3 : 0.7
  return lengthOf(o, duration) * rate
}

function Frame({ o }: { o: Output }) {
  const r = ratio[o.aspect]
  const isWide = r >= 1.7
  return (
    <div className={styles.frameWrap}>
      <div
        className={styles.frameOuter}
        style={{ aspectRatio: '16 / 9', backgroundImage: `url(${sceneThumb('portrait', 640, 360)})` }}
      >
        {!isWide && <div className={styles.frameDim} />}
        <div
          className={[styles.frame, !isWide && styles.frameCrop].filter(Boolean).join(' ')}
          style={
            isWide
              ? { inset: 0 }
              : {
                  height: '100%',
                  aspectRatio: `${r}`,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  backgroundImage: `url(${sceneThumb('portrait', 640, 360)})`,
                }
          }
        >
          <span className={styles.frameLyric}>Under the neon skyline</span>
        </div>
      </div>
      {!isWide && (
        <div className={styles.frameNote}>
          <Check /> Follows the singer. Drag the frame to adjust any shot.
        </div>
      )}
    </div>
  )
}

function TeaserRange() {
  const project = useProject()
  const list = sectionsOf(project)
  const duration = timelineDuration(project)
  const chorus = list.find((s) => sectionKind(s) === 'chorus')
  const start = chorus?.start ?? 0
  return (
    <div className={styles.range}>
      <div className={styles.rangeLane}>
        {list.map((s) => (
          <span
            key={s.id}
            style={{
              flex: s.end - s.start,
              background: `color-mix(in srgb, ${sectionColor[sectionKind(s)]} 45%, transparent)`,
            }}
          />
        ))}
        <span
          className={styles.rangeSel}
          style={{ left: `${(start / duration) * 100}%`, width: `${(15 / duration) * 100}%` }}
        />
      </div>
      <div className={`${styles.rangeText} tnum`}>
        {formatTime(start)} – {formatTime(start + 15)} · starts on the first chorus, the most repeated part
      </div>
    </div>
  )
}

function rowStatus(job: JobSnapshot | undefined): string {
  if (!job) return 'Waiting'
  if (job.status === 'succeeded') return 'Saved'
  if (job.status === 'cancelled') return 'Cancelled'
  if (job.status === 'failed') return job.error?.message ?? 'Failed'
  if (job.progress.stage === 'waiting') return 'Waiting'
  const eta = job.progress.etaSeconds ?? 0
  const left = eta < 50 ? 'less than a minute left' : `about ${Math.round(eta / 60)} min left`
  return `${Math.round((job.progress.fraction ?? 0) * 100)}% · ${left}`
}

/** Matches each output to its most recent export job by title, so the list survives closing the dialog. */
function useExportJobs(outputs: Output[]) {
  const list = useJobs().filter((j) => j.kind === JOB_KINDS.export)
  return outputs.map((o) => [...list].reverse().find((j) => j.title === exportTitle(o.name)))
}

function ExportingView({ outputs, onClose }: { outputs: Output[]; onClose: () => void }) {
  const rows = useExportJobs(outputs)
  const done = rows.every((j) => j && j.status !== 'running' && j.status !== 'queued')
  const saved = rows.filter((j) => j?.status === 'succeeded').length
  return (
    <div className={styles.exporting}>
      <div className={styles.exportingHead}>
        <div className={styles.exportingTitle}>
          {done
            ? `${saved} ${saved === 1 ? 'file' : 'files'} saved`
            : `Exporting ${outputs.length} ${outputs.length === 1 ? 'file' : 'files'}`}
        </div>
        <div className={styles.muted}>
          {done
            ? 'Find them in your Downloads folder.'
            : 'Rendering on this device. You can keep editing; files save to your Downloads folder.'}
        </div>
      </div>
      <div className={styles.jobList}>
        {outputs.map((o, i) => {
          const job = rows[i]
          const finished = job?.status === 'succeeded'
          const active = job?.status === 'running' || job?.status === 'queued'
          return (
            <div key={o.id} className={styles.jobRow}>
              <span className={styles.jobIcon}>{aspectIcon(o.aspect)}</span>
              <div className={styles.jobMain}>
                <div className={styles.jobTop}>
                  <span className={styles.jobName}>{o.name}</span>
                  <span className={`${styles.muted} tnum`}>{rowStatus(job)}</span>
                </div>
                <ProgressBar
                  value={job?.progress.fraction ?? 0}
                  tone={finished ? 'success' : 'accent'}
                  label={`${o.name} progress`}
                />
              </div>
              {finished ? (
                <Button size="sm" variant="ghost" icon={<FolderDown />} onClick={() => downloadAgain(o.name)}>
                  Download
                </Button>
              ) : active ? (
                <IconButton label="Cancel this file" size="sm" onClick={() => job && jobs.cancel(job.id)}>
                  <X />
                </IconButton>
              ) : (
                <span className={styles.jobSpacer} />
              )}
            </div>
          )
        })}
      </div>
      <div className={styles.exportingFoot}>
        {done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                jobs.cancelAll(JOB_KINDS.export)
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
        )}
      </div>
    </div>
  )
}

export function ExportDialog() {
  const open = useUi((s) => s.dialog === 'export')
  const phase = useUi((s) => s.exportPhase)
  const project = useProject()
  const duration = timelineDuration(project)
  const [outputs, setOutputs] = useState<Output[]>([
    { id: 'o1', kind: 'full', name: 'Full video', aspect: '16:9', res: '1080', fps: '30', on: true },
    { id: 'o2', kind: 'format', name: 'Vertical', aspect: '9:16', res: '1080', fps: '30', on: true },
  ])
  const [selected, setSelected] = useState('o1')
  const sel = outputs.find((o) => o.id === selected) ?? outputs[0]!
  const active = outputs.filter((o) => o.on)
  const total = active.reduce((a, o) => a + sizeMB(o, duration), 0)
  const minutes = Math.max(
    1,
    Math.round(active.reduce((a, o) => a + (o.kind === 'full' || o.kind === 'format' ? 3 : 0.4), 0)),
  )
  const update = (patch: Partial<Output>) =>
    setOutputs((os) => os.map((o) => (o.id === sel.id ? { ...o, ...patch } : o)))
  const close = () => set({ dialog: null, exportPhase: 'setup' })
  const remaining = suggestions.filter((s) => !outputs.some((o) => o.name === s.name))
  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const fileBase = (o: Output) => `${slug}-${o.name.toLowerCase().replace(/\s+/g, '-')}`

  return (
    <Dialog
      open={open}
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
                <HardDrive /> About {Math.round(total)} MB
              </span>
              <span>
                <Clock /> About {minutes} min on this device
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
                startExports(
                  active.map((o) => ({
                    name: o.name,
                    fileName: `${fileBase(o)}.mp4`,
                    kind: o.kind,
                    aspect: o.aspect,
                    resolution: `${o.res}p` as ExportResolution,
                    fps: Number(o.fps),
                  })),
                )
                set({ exportPhase: 'exporting' })
              }}
            >
              Export {active.length} {active.length === 1 ? 'file' : 'files'}
            </Button>
          </>
        ) : undefined
      }
    >
      {phase === 'exporting' ? (
        <ExportingView outputs={active} onClose={close} />
      ) : (
        <div className={styles.layout}>
          <div className={styles.outputs}>
            <div className={styles.colLabel}>Outputs</div>
            {outputs.map((o) => (
              <div
                key={o.id}
                className={[styles.output, o.id === sel.id && styles.outputOn].filter(Boolean).join(' ')}
                onClick={() => setSelected(o.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelected(o.id)
                  }
                }}
                role="button"
                tabIndex={0}
                aria-pressed={o.id === sel.id}
              >
                <label className={styles.check} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={o.on}
                    onChange={(e) =>
                      setOutputs((os) => os.map((x) => (x.id === o.id ? { ...x, on: e.target.checked } : x)))
                    }
                    aria-label={`Include ${o.name}`}
                  />
                  <span>
                    <Check />
                  </span>
                </label>
                <span className={styles.outThumb}>
                  <span
                    style={{
                      aspectRatio: `${ratio[o.aspect]}`,
                      backgroundImage: `url(${sceneThumb('portrait')})`,
                    }}
                  />
                </span>
                <span className={styles.outText}>
                  <span className={styles.outName}>
                    {o.name}
                    {o.kind === 'format' && <Badge>Auto-reframe</Badge>}
                  </span>
                  <span className={`${styles.outSpecs} tnum`}>{specs(o, duration)}</span>
                </span>
              </div>
            ))}
            {remaining.length > 0 && <div className={styles.colLabel}>Add another</div>}
            {remaining.map((s) => (
              <button
                key={s.name}
                className={styles.suggest}
                onClick={() => {
                  const id = `o-${s.name}`
                  setOutputs((os) => [...os, { ...s, id, on: true }])
                  setSelected(id)
                }}
              >
                <span className={styles.suggestIcon}>
                  {s.kind === 'teaser' ? <Scissors /> : s.kind === 'loop' ? <Repeat /> : aspectIcon(s.aspect)}
                </span>
                <span className={styles.outText}>
                  <span className={styles.outName}>{s.name}</span>
                  <span className={styles.outSpecs}>
                    {s.kind === 'teaser'
                      ? '15–30 s highlight of the chorus'
                      : s.kind === 'loop'
                        ? 'Seamless 3–8 s vertical loop'
                        : `${s.aspect}, reframed to the subject`}
                  </span>
                </span>
                <Plus className={styles.plus} />
              </button>
            ))}
          </div>

          <div className={`${styles.settings} scroll`}>
            <Frame o={sel} />
            {sel.kind === 'teaser' && <TeaserRange />}
            <div className={styles.form}>
              <label className={styles.formRow}>
                <span>Name</span>
                <Input value={fileBase(sel)} onChange={() => undefined} />
              </label>
              <div className={styles.formRow}>
                <span>Aspect</span>
                <Segmented
                  value={sel.aspect}
                  onChange={(v) => update({ aspect: v })}
                  ariaLabel="Aspect ratio"
                  options={(['16:9', '9:16', '1:1', '4:5'] as const).map((a) => ({ value: a, label: a }))}
                />
              </div>
              {sel.aspect !== '16:9' && (
                <div className={styles.formRow}>
                  <span>Framing</span>
                  <Select
                    value="follow"
                    onChange={() => undefined}
                    ariaLabel="Framing"
                    options={[
                      {
                        value: 'follow',
                        label: 'Follow the subject',
                        description: 'Tracks people and motion in each shot',
                      },
                      { value: 'center', label: 'Center crop' },
                      { value: 'fit', label: 'Fit with blurred background' },
                    ]}
                  />
                </div>
              )}
              <div className={styles.formRow}>
                <span>Resolution</span>
                <Segmented
                  value={sel.res}
                  onChange={(v) => update({ res: v })}
                  ariaLabel="Resolution"
                  options={[
                    { value: '720', label: '720p' },
                    { value: '1080', label: '1080p' },
                    { value: '1440', label: '1440p' },
                    { value: '2160', label: '4K' },
                  ]}
                />
              </div>
              <div className={styles.formRow}>
                <span>Frame rate</span>
                <Segmented
                  value={sel.fps}
                  onChange={(v) => update({ fps: v })}
                  ariaLabel="Frame rate"
                  options={['24', '25', '30', '60'].map((v) => ({ value: v, label: v }))}
                />
              </div>
              <div className={styles.formRow}>
                <span>Quality</span>
                <Select
                  value="high"
                  onChange={() => undefined}
                  ariaLabel="Quality"
                  options={[
                    { value: 'std', label: 'Standard · smaller file' },
                    { value: 'high', label: 'High · recommended' },
                    { value: 'max', label: 'Maximum' },
                  ]}
                />
              </div>
              <div className={styles.formRow}>
                <span>Format</span>
                <span className={styles.static}>MP4 · H.264 video, AAC audio</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}
