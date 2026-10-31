import { useState } from 'react'
import { Info, KeyRound } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, Select, TextArea } from '../../../ds/Fields.tsx'
import { set } from '../../../state/ui.ts'
import { Field, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Generate row of Assist's tool list. */
export function GenerateBadge() {
  return <Badge icon={<KeyRound />}>fal.ai</Badge>
}

export function GenerateView() {
  const [type, setType] = useState('video')
  return (
    <ToolView
      title="Generate"
      subtitle="AI images and clips with fal.ai"
      footer={
        <>
          <Button
            variant="primary"
            block
            icon={<KeyRound />}
            onClick={() => set({ dialog: 'settings', settingsPage: 'ai' })}
          >
            Connect fal.ai to generate
          </Button>
          <div className={styles.costLine}>
            <Info /> {type === 'video' ? 'About $0.35 per 5 s clip' : 'About $0.01 per image'}, charged by
            fal.ai to your key
          </div>
        </>
      }
    >
      <Segmented
        block
        value={type}
        onChange={setType}
        ariaLabel="What to generate"
        options={[
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video clip' },
        ]}
      />
      <Field label="Describe the shot">
        <TextArea
          rows={3}
          defaultValue="Slow aerial over a neon city at night, light rain, cinematic"
          aria-label="Describe the shot"
        />
      </Field>
      {type === 'video' && (
        <Field label="Start from" hint="Optional. Animate one of your images.">
          <Select
            value="none"
            onChange={() => undefined}
            ariaLabel="Start image"
            options={[
              { value: 'none', label: 'Text only' },
              { value: 'sunset', label: 'Rooftop sunset (image)' },
            ]}
          />
        </Field>
      )}
      <div className={styles.twoCol}>
        <Field label="Model">
          <Select
            value="fast"
            onChange={() => undefined}
            ariaLabel="Model"
            options={[
              { value: 'fast', label: type === 'video' ? 'Video · fast' : 'Image · fast' },
              { value: 'hq', label: type === 'video' ? 'Video · high quality' : 'Image · high quality' },
            ]}
          />
        </Field>
        <Field label={type === 'video' ? 'Length' : 'Count'}>
          <Select
            value="5"
            onChange={() => undefined}
            ariaLabel={type === 'video' ? 'Length' : 'Count'}
            options={[{ value: '5', label: type === 'video' ? '5 s' : '4 images' }]}
          />
        </Field>
      </div>
      <p className={styles.muted}>Results land in Media › Generated and at the playhead as normal clips.</p>
    </ToolView>
  )
}
