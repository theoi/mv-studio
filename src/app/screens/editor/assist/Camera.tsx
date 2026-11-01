import { AlertTriangle, Box, Check, Lock, Play, RotateCcw, Undo2 } from 'lucide-react'
import type { Asset, ImageClip } from '../../../../model/index.ts'
import { useId, useRef, type ReactNode } from 'react'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { Badge, EmptyState } from '../../../ds/Feedback.tsx'
import { Segmented, Slider } from '../../../ds/Fields.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBytes, formatTime, plural } from '../../../format.ts'
import {
  MOTION_LABELS,
  MOTION_PRESETS,
  cameraTargets,
  chosenIntensity,
  hasCameraMove,
  resetStrength,
  riskFacts,
  riskNote,
  riskyMoves,
  startCameraMoves,
  stillClips,
  undoCameraMoves,
  useCamera,
  useDepthDownload,
  type CameraMotion,
} from '../../../state/camera.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { editor, useProject } from '../../../state/project.ts'
import { showClips } from '../../../state/reveal.ts'
import { set, toast, useUi } from '../../../state/ui.ts'
import { useThumbnail } from '../../../state/thumbs.ts'
import { dismiss, pct, useJob } from './jobState.ts'
import { CancelButton, Field, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the 3D camera row of Assist's tool list. */
export function CameraBadge() {
  const { job, phase } = useJob(JOB_KINDS.camera)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  return null
}

function StillRow({
  clip,
  asset,
  title,
  detail,
  action,
}: {
  clip: ImageClip
  asset: Asset
  title?: string
  detail?: string
  action?: ReactNode
}) {
  const thumb = useThumbnail(asset)
  return (
    <div className={styles.suitRow}>
      <span className={styles.suitThumb} style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} />
      <span className={styles.suitText}>
        <span className={styles.toolTitle}>{title ?? clip.name ?? asset.name}</span>
        <span className={styles.muted}>
          {detail ??
            `Image · on the timeline at ${formatTime(clip.start)}${hasCameraMove(clip) ? ' · replaces its camera move' : ''}`}
        </span>
      </span>
      {action}
    </div>
  )
}

export function CameraView() {
  const { job, phase } = useJob(JOB_KINDS.camera)
  const project = useProject()
  const selection = useUi((s) => s.selection)
  const motion = useCamera((s) => s.motion)
  const strength = useCamera((s) => s.strength)
  const strengthSet = useCamera((s) => s.strengthSet)
  const slider = useRef<HTMLDivElement>(null)
  const strengthHint = useId()
  const result = useCamera((s) => (job ? s.results[job.id] : undefined))
  const preset = useCamera((s) => (job ? s.presets[job.id] : undefined))
  const targets = cameraTargets(project, selection)
  const download = useDepthDownload(phase === 'idle' && targets.length > 0)
  const apply = () =>
    startCameraMoves(
      targets.map((c) => c.id),
      MOTION_PRESETS[motion],
      chosenIntensity(),
    )

  if (phase === 'running')
    return (
      <ToolView title="3D camera" subtitle="Estimating depth" footer={<CancelButton job={job} />}>
        <RunCard job={job} label="3D camera progress" />
        <p className={styles.muted}>Nothing changes on the timeline until every image is ready.</p>
      </ToolView>
    )

  if (phase === 'failed')
    return (
      <ToolView
        title="3D camera"
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
    const first = result.moves
      .map((m) => project.clips[m.clipId])
      .filter((c) => !!c)
      .sort((a, b) => a.start - b.start)[0]
    const canUndo = editor.undoLabel() === result.label
    const risky = riskyMoves(project, result, preset)
    const note = riskNote(
      result.moves.length,
      risky.map((r) => ({
        risks: r.risks,
        alwaysBends: r.move.alwaysBends,
        cleanAlternatives: r.move.cleanAlternatives,
      })),
    )
    const riskRows = risky.flatMap((r) => {
      const clip = project.clips[r.move.clipId]
      const asset = clip?.type === 'image' ? project.assets[clip.assetId] : undefined
      return clip?.type === 'image' && asset ? [{ ...r, clip, asset, name: clip.name ?? asset.name }] : []
    })
    const undoButton = (
      <Button
        variant="secondary"
        icon={<Undo2 />}
        disabled={!canUndo}
        onClick={() => {
          if (undoCameraMoves(result))
            toast(result.moves.length === 1 ? 'Camera move removed' : 'Camera moves removed')
          dismiss(job)
        }}
      >
        Undo
      </Button>
    )
    return (
      <ToolView
        title="3D camera"
        subtitle="Done"
        footer={
          <div className={styles.footerRow}>
            {canUndo ? (
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
              icon={<Play />}
              disabled={!first}
              onClick={() => {
                dismiss(job)
                if (first)
                  set({ selection: { type: 'clip', id: first.id }, playhead: first.start, playing: true })
              }}
            >
              Play it
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
              Added a 3D camera move to {plural(result.moves.length, 'image')}
            </div>
            <div className={styles.muted}>
              It is the first effect on each image. Change its motion or strength in Inspector › Motion.
            </div>
          </div>
        </div>
        {note && (
          <div className={[styles.callout, styles.calloutWarning].join(' ')}>
            <AlertTriangle />
            <div>{note}</div>
          </div>
        )}
        {riskRows.map(({ move, strength, risks, clip, asset, name }) => {
          const at = `${name} at ${formatTime(clip.start)}`
          // No-break spaces keep a strength with its number, where a line break would read badly.
          const facts = riskFacts(risks, 'short').map((f) => f.replace(/ (\d+%)$/, '\u00a0$1'))
          return (
            <StillRow
              key={move.clipId}
              clip={clip}
              asset={asset}
              {...(riskRows.filter((r) => r.name === name).length > 1 ? { title: at } : {})}
              detail={`Strength\u00a0${strength}%\u00a0· may ${facts.join(' and ')}`}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Show ${at}`}
                  onClick={() => showClips([move.clipId])}
                >
                  Show
                </Button>
              }
            />
          )
        })}
      </ToolView>
    )
  }

  const stills = stillClips(project)
  return (
    <ToolView
      title="3D camera"
      subtitle="Depth motion on still images"
      footer={
        <>
          <Button variant="primary" block onClick={apply} disabled={!targets.length}>
            {targets.length ? `Apply to ${plural(targets.length, 'image')}` : 'Apply to images'}
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device&nbsp;·&nbsp;free
            {download ? `\u00a0· ${formatBytes(download)} download, once` : ''}
          </div>
        </>
      }
    >
      <Field label="Motion">
        <Segmented<CameraMotion>
          block
          value={motion}
          onChange={(m) => useCamera.setState({ motion: m })}
          ariaLabel="Camera motion"
          options={(Object.keys(MOTION_LABELS) as CameraMotion[]).map((value) => ({
            value,
            label: MOTION_LABELS[value],
          }))}
        />
      </Field>
      <Field
        label="Strength"
        {...(strengthSet
          ? {
              action: (
                <IconButton
                  label="Back to automatic strength"
                  size="xs"
                  tooltipSide="left"
                  onClick={() => {
                    resetStrength()
                    slider.current?.querySelector<HTMLElement>('[role="slider"]')?.focus()
                  }}
                >
                  <RotateCcw />
                </IconButton>
              ),
            }
          : {
              hint: 'Each image gets as much as it can take without smearing or bending straight lines.',
              hintId: strengthHint,
            })}
      >
        <div className={styles.sliderRow} ref={slider}>
          <Slider
            value={strength}
            onChange={(v) => useCamera.setState({ strength: v, strengthSet: true })}
            ariaLabel="Strength"
            {...(strengthSet
              ? {}
              : { valueText: 'Automatic, 50% or less for each image', ariaDescribedBy: strengthHint })}
          />
          <span className={`${styles.sliderValue} tnum`}>{strengthSet ? `${strength}%` : 'Auto'}</span>
        </div>
      </Field>
      {targets.length ? (
        targets.map((clip) => {
          const asset = project.assets[clip.assetId]
          return asset ? <StillRow key={clip.id} clip={clip} asset={asset} /> : null
        })
      ) : (
        <EmptyState
          compact
          icon={<Box />}
          title={stills.length ? 'Every image has a camera move' : 'No images on the timeline'}
          description={
            stills.length
              ? 'Select an image on the timeline to give it a different move.'
              : '3D camera moves work on still images. Add one from Media.'
          }
        />
      )}
      <p className={styles.muted}>Depth is estimated on this device.</p>
    </ToolView>
  )
}
