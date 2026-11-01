import { Sparkles } from 'lucide-react'
import type { ImageClip } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { useCloud } from '../../../state/cloud.ts'
import { animateImage } from '../../../state/generate.ts'
import styles from '../Inspector.module.css'

/** Inspector › image: makes a video clip from the still with Assist › Generate. */
export function AnimateAction({ clip }: { clip: ImageClip }) {
  const { falKey } = useCloud()
  return (
    <div className={styles.inlineActions}>
      <Tooltip
        label="Make a video clip from this image with fal.ai. You see the price first."
        description={falKey ? undefined : 'Needs fal.ai'}
      >
        <Button
          size="sm"
          variant="ghost"
          icon={<Sparkles />}
          className={styles.forwardAction}
          onClick={() => animateImage(clip)}
        >
          Animate with AI
        </Button>
      </Tooltip>
    </div>
  )
}
