import { pluginRegistry } from '../../../../engine/registry.ts'
import type { VisualClip } from '../../../../model/index.ts'
import { JobError } from '../../../../shared/jobs.ts'
import type { CameraPreset } from '../../../../vision/index.ts'
import { CAMERA_EFFECT_ID } from '../../../../vision/render/cameraEffect.ts'
import { FieldRow, Section, Select, Slider } from '../../../ds/Fields.tsx'
import {
  MOTION_PRESETS,
  cameraMoveOf,
  hasCameraMove,
  motionOf,
  removeCameraMove,
  setCameraMove,
  startCameraMoves,
  undoCameraMoves,
  useCamera,
  useDepthDownload,
  type CameraMotion,
} from '../../../state/camera.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { formatBytes } from '../../../format.ts'
import { editor } from '../../../state/project.ts'
import { toast } from '../../../state/ui.ts'
import { pct, useJob } from '../assist/jobState.ts'
import { InlineSuggestion } from '../Suggestion.tsx'
import styles from '../Inspector.module.css'

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
        const { motion, strength } = useCamera.getState()
        const handle = startCameraMoves([clip.id], MOTION_PRESETS[motion], strength / 100)
        handle?.promise.then(
          (result) => toast('3D camera move added', { label: 'Undo', run: () => undoCameraMoves(result) }),
          (err: unknown) => {
            if (!(err instanceof JobError && err.code === 'cancelled'))
              toast('The 3D camera move could not be added. Try again from Assist › 3D camera.')
          },
        )
      }}
    >
      Give this still image depth with a slow 3D camera move
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

/** Inspector › Motion for a still: pick, change or remove its 3D camera move and set its strength. */
export function CameraSection({ clip }: { clip: VisualClip }) {
  const { job, phase } = useJob(JOB_KINDS.camera)
  const requests = useCamera((s) => s.requests)
  const strength = useCamera((s) => s.strength)
  const move = cameraMoveOf(clip)
  const asked = !!job && !!requests[job.id]?.includes(clip.id)
  const adding = asked && phase === 'running' ? job : undefined
  const failure = asked && phase === 'failed' ? job?.error?.message : undefined
  const download = useDepthDownload(!move && !adding)
  const motion = move && motionOf(move.preset)
  const value: string = move ? (motion ?? move.preset) : 'none'
  const options = [
    { value: 'none', label: 'None' },
    ...MOTIONS,
    ...(move && !motion ? [{ value: move.preset, label: presetLabel(move.preset) }] : []),
  ]
  const choose = (v: string) => {
    if (v === value) return
    if (v === 'none') removeCameraMove(clip.id)
    else if (v in MOTION_PRESETS) {
      const preset = MOTION_PRESETS[v as CameraMotion]
      if (move) setCameraMove(clip.id, { preset })
      else startCameraMoves([clip.id], preset, strength / 100)
    }
  }
  return (
    <Section title="Motion" defaultOpen={!!move}>
      <FieldRow label="3D camera" trailing={<span className={styles.trailSpacer} />}>
        <Select value={value} onChange={choose} options={options} ariaLabel="3D camera move" />
      </FieldRow>
      {move && !adding && (
        <FieldRow label="Strength" trailing={<span className={styles.trailSpacer} />}>
          <Slider
            value={Math.round(move.intensity * 100)}
            onChange={(v) => setCameraMove(clip.id, { intensity: v / 100 }, true)}
            onCommit={() => editor.endGesture()}
            ariaLabel="3D camera strength"
          />
        </FieldRow>
      )}
      {adding ? (
        <p className={styles.note}>Estimating depth… {pct(adding)}%</p>
      ) : failure ? (
        <p className={styles.note} role="alert">
          {failure} Your project is unchanged. Choose a move again to retry.
        </p>
      ) : (
        !move && (
          <p className={styles.note}>
            Moves a camera through the still, with near and far parts shifting at their own speed
            {download ? ` (${formatBytes(download)} download, once)` : ''}.
          </p>
        )
      )}
    </Section>
  )
}
