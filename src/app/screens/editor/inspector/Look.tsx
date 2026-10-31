import { useState } from 'react'
import { Button } from '../../../ds/Button.tsx'
import { AnimateButtons, FieldRow, Section, Slider } from '../../../ds/Fields.tsx'
import { sceneThumb } from '../../../mock/art.ts'
import { set } from '../../../state/ui.ts'
import styles from '../Inspector.module.css'

/** The project's look, in the project inspector. */
export function LookSection() {
  const [intensity, setIntensity] = useState(70)
  return (
    <Section title="Look">
      <div className={styles.lookCard}>
        <span className={styles.lookThumb} style={{ backgroundImage: `url(${sceneThumb('city')})` }} />
        <div className={styles.lookText}>
          <div className={styles.lookName}>Neon noir</div>
          <div className={styles.meta}>On every clip</div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => set({ libraryTab: 'effects', libraryOpen: true })}
        >
          Change
        </Button>
      </div>
      <FieldRow label="Intensity" trailing={<AnimateButtons property="Look intensity" />}>
        <Slider value={intensity} onChange={setIntensity} ariaLabel="Look intensity" />
        <span className={`${styles.value} tnum`}>{intensity}%</span>
      </FieldRow>
    </Section>
  )
}
