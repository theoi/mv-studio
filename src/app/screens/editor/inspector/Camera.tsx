import { useId, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import type { VisualClip } from '../../../../model/index.ts'
import { JobError } from '../../../../shared/jobs.ts'
import type { CameraPreset } from '../../../../vision/index.ts'
import { CAMERA_EFFECT_ID } from '../../../../vision/render/cameraEffect.ts'
import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Section, Select, Slider } from '../../../ds/Fields.tsx'
import {
  MOTION_PRESETS,
  addedRiskNote,
  cameraMoveOf,
  cameraRisks,
  chosenIntensity,
  hasCameraMove,
  motionOf,
  removeCameraMove,
  riskFacts,
  setCameraMove,
  startCameraMoves,
  undoCameraMoves,
  useCamera,
  useDepthDownload,
  useSafeAmounts,
  type CameraMotion,
} from '../../../state/camera.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { formatBytes } from '../../../format.ts'
import { editor } from '../../../state/project.ts'
import { toast } from '../../../state/ui.ts'
import { downloadPct, pct, useJob } from '../assist/jobState.ts'
import { CancelButton } from '../assist/ToolView.tsx'
import { InlineSuggestion } from '../Suggestion.tsx'
import styles from '../Inspector.module.css'

const CAMERA_DESCRIPTION = 'Give this still image depth with a slow 3D camera move'

/** Offers a 3D camera move on a still image that has none. */
export function CameraSuggestion({ clip }: { clip: VisualClip }) {
  const { phase } = useJob(JOB_KINDS.camera)
  const available = clip.type === 'image' && !hasCameraMove(clip) && phase !== 'running'
  const download = useDepthDownload(available)
  if (!available) return null
  return (
    <InlineSuggestion
      id={`camera-${clip.id}`}
      action="Add 3D camera"
      onAction={() => {
        const handle = startCameraMoves(
          [clip.id],
          MOTION_PRESETS[useCamera.getState().motion],
          chosenIntensity(),
        )
        handle?.promise.then(
          (result) => {
            const risk = addedRiskNote(result)
            toast(risk ? `3D camera move added. ${risk}` : '3D camera move added', {
              label: 'Undo',
              run: () => undoCameraMoves(result),
            })
          },
          (err: unknown) => {
            if (!(err instanceof JobError && err.code === 'cancelled'))
              toast('The 3D camera move couldn’t be added. Try again from Assist › 3D camera.')
          },
        )
      }}
    >
      {CAMERA_DESCRIPTION}
      {download ? ` (${formatBytes(download)} download, once)` : ''}.
    </InlineSuggestion>
  )
}

const MOTIONS: { value: CameraMotion; label: string }[] = [
  { value: 'push', label: 'Push in' },
  { value: 'orbit', label: 'Orbit' },
  { value: 'drift', label: 'Drift' },
]

/** Label of a preset the panel does not offer (moves the director or an older project added). */
function presetLabel(preset: CameraPreset): string {
  const param = pluginRegistry.get(CAMERA_EFFECT_ID)?.params?.find((p) => p.key === 'preset')
  const option = param && 'options' in param ? param.options?.find((o) => o.value === preset) : undefined
  return option?.label ?? preset
}

/**
 * Inspector › Motion for a still: pick, change or remove its 3D camera move and set its strength, or give a flat move
 * depth.
 */
export function CameraSection({ clip }: { clip: VisualClip }) {
  const { job, phase } = useJob(JOB_KINDS.camera)
  const refocus = useRef(false)
  const requests = useCamera((s) => s.requests)
  const presets = useCamera((s) => s.presets)
  const move = cameraMoveOf(clip)
  const safe = useSafeAmounts(clip)
  const riskId = useId()
  const busy = phase === 'running'
  const asked = !!job && !!requests[job.id]?.includes(clip.id)
  const adding = asked && busy ? job : undefined
  const failure = asked && phase === 'failed' ? job?.error?.message : undefined
  const download = useDepthDownload((!move || move.flat) && !busy)
  const downloadNote = download ? ` (${formatBytes(download)} download, once)` : ''
  const refocusSelect = (el: HTMLElement | null) => {
    // After Cancel the section is back as before and its Cancel button is gone: focus the select.
    if (!el || !refocus.current) return
    refocus.current = false
    el.parentElement?.querySelector<HTMLElement>('[role="combobox"]')?.focus()
  }
  // While the move is being added, the select shows the motion that was chosen.
  const shown = move?.preset ?? (adding ? presets[adding.id] : undefined)
  const motion = shown && motionOf(shown)
  const value: string = shown ? (motion ?? shown) : 'none'
  const options = [
    { value: 'none', label: 'None' },
    ...MOTIONS,
    ...(shown && !motion ? [{ value: shown, label: presetLabel(shown) }] : []),
  ]
  const choose = (v: string) => {
    if (v === value) return
    if (v === 'none') removeCameraMove(clip.id)
    else if (v in MOTION_PRESETS) {
      const preset = MOTION_PRESETS[v as CameraMotion]
      if (move) setCameraMove(clip.id, { preset })
      else startCameraMoves([clip.id], preset, chosenIntensity())
    }
  }
  const addDepth = move?.flat && (
    <div className={styles.padded}>
      <Button
        size="sm"
        variant="ghost"
        className={`${styles.forwardAction} ${styles.noteAction}`}
        onClick={() => startCameraMoves([clip.id], move.preset, move.intensity)}
      >
        Add depth
      </Button>
    </div>
  )
  const intensity = move ? Math.round(move.intensity * 100) : 0
  // Advice only: a strength above the still's safe amounts is kept, with a note on what it may do.
  const risks = move && !adding && safe ? cameraRisks(safe, intensity) : []
  return (
    <Section title="Motion" defaultOpen={!!move || !!adding}>
      <FieldRow label="3D camera" trailing={<span className={styles.trailSpacer} />}>
        <Select
          value={value}
          onChange={choose}
          options={options}
          ariaLabel="3D camera move"
          disabled={busy}
        />
      </FieldRow>
      {move && !adding && (
        <FieldRow label="Strength" trailing={<span className={styles.trailSpacer} />}>
          <Slider
            value={intensity}
            onChange={(v) => setCameraMove(clip.id, { intensity: v / 100 }, true)}
            onCommit={() => editor.endGesture()}
            ariaLabel="3D camera strength"
            {...(risks.length ? { ariaDescribedBy: riskId } : {})}
          />
          <span className={`${styles.value} tnum`}>{intensity}%</span>
        </FieldRow>
      )}
      {risks.length > 0 && (
        <p id={riskId} className={styles.note}>
          <span className={styles.noteWarning}>
            <AlertTriangle aria-hidden />
            May {riskFacts(risks, 'long').join(' and ')}.
          </span>
        </p>
      )}
      {adding ? (
        <div className={styles.progressRow}>
          <span>
            {downloadPct(adding) === undefined
              ? `Estimating depth… ${pct(adding)}%`
              : `Downloading… ${downloadPct(adding)}%`}
          </span>
          <CancelButton job={adding} inline onCancel={() => (refocus.current = true)} />
        </div>
      ) : busy ? (
        <p className={styles.note}>Wait for the other 3D camera move to finish.</p>
      ) : failure ? (
        <>
          <p className={styles.note} role="alert">
            <span className={styles.noteDanger}>
              <AlertTriangle aria-hidden />
              {failure}
            </span>
            Your project is unchanged.{' '}
            {move?.flat ? 'Choose Add depth to try again.' : 'Choose a move again to retry.'}
          </p>
          {addDepth}
        </>
      ) : !move ? (
        <p className={styles.note} ref={refocusSelect}>
          {CAMERA_DESCRIPTION}
          {downloadNote}.
        </p>
      ) : (
        move.flat && (
          <>
            <p className={styles.note} ref={refocusSelect}>
              The move is flat: this image has no depth yet{downloadNote}.
            </p>
            {addDepth}
          </>
        )
      )}
    </Section>
  )
}
