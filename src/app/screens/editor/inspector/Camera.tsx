import type { VisualClip } from '../../../../model/index.ts'
import { JobError } from '../../../../shared/jobs.ts'
import {
  MOTION_PRESETS,
  hasCameraMove,
  startCameraMoves,
  undoCameraMoves,
  useCamera,
  useDepthDownload,
} from '../../../state/camera.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { formatBytes } from '../../../format.ts'
import { toast } from '../../../state/ui.ts'
import { useJob } from '../assist/jobState.ts'
import { InlineSuggestion } from '../Suggestion.tsx'

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
