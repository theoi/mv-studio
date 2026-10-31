import { useState } from 'react'
import { Button } from '../../../ds/Button.tsx'
import { Segmented, Slider } from '../../../ds/Fields.tsx'
import { sceneThumb } from '../../../mock/art.ts'
import { toast } from '../../../state/ui.ts'
import { Field, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

export function CameraView() {
  const [motion, setMotion] = useState('push')
  const [strength, setStrength] = useState(40)
  return (
    <ToolView
      title="3D camera"
      subtitle="Depth motion on still images"
      footer={
        <Button variant="primary" block onClick={() => toast('3D camera added to 1 image')}>
          Apply to 1 image
        </Button>
      }
    >
      <Field label="Motion">
        <Segmented
          block
          value={motion}
          onChange={setMotion}
          ariaLabel="Camera motion"
          options={[
            { value: 'push', label: 'Push in' },
            { value: 'orbit', label: 'Orbit' },
            { value: 'drift', label: 'Drift' },
          ]}
        />
      </Field>
      <Field label="Strength">
        <Slider value={strength} onChange={setStrength} ariaLabel="Strength" />
      </Field>
      <div className={styles.suitRow}>
        <span className={styles.suitThumb} style={{ backgroundImage: `url(${sceneThumb('sunset')})` }} />
        <span className={styles.suitText}>
          <span className={styles.toolTitle}>Rooftop sunset</span>
          <span className={styles.muted}>Image · on the timeline at 0:28</span>
        </span>
      </div>
      <p className={styles.muted}>Depth is estimated on this device. First use downloads a 25 MB model.</p>
    </ToolView>
  )
}
