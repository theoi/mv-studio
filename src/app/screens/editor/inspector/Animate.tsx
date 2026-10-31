import { Sparkles } from 'lucide-react'
import type { ImageClip } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { animateImage } from '../../../state/generate.ts'
import styles from '../Inspector.module.css'

/** Inspector › image: makes a video clip from the still with Assist › Generate. */
export function AnimateAction({ clip }: { clip: ImageClip }) {
  return (
    <div className={styles.inlineActions}>
      <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => animateImage(clip)}>
        Animate with AI
      </Button>
    </div>
  )
}
