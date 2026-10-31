import type { VisualClip } from '../../../../model/index.ts'
import { toast } from '../../../state/ui.ts'
import { InlineSuggestion } from '../Suggestion.tsx'

/** Offers a 3D camera move on a still image. */
export function CameraSuggestion({ clip }: { clip: VisualClip }) {
  return (
    <InlineSuggestion
      id={`camera-${clip.id}`}
      action="Add 3D camera"
      onAction={() => toast('3D camera motion added (depth computed on this device)')}
    >
      Give this still image depth with a slow 3D camera move.
    </InlineSuggestion>
  )
}
