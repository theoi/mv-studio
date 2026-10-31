import { useState } from 'react'
import { AudioWaveform } from 'lucide-react'
import type { Clip } from '../../../../model/index.ts'
import { pluginRegistry } from '../../../../engine/registry.ts'
import {
  AnimateButtons,
  ColorField,
  FieldRow,
  NumberField,
  Section,
  Segmented,
  Select,
  Slider,
} from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { useAnimatable } from './animatable.ts'
import { CompositingSection, Header } from './parts.tsx'
import styles from '../Inspector.module.css'

export function GeneratorInspector({ clip }: { clip: Extract<Clip, { type: 'generator' }> }) {
  const [source, setSource] = useState('drums')
  const sens = useAnimatable(clip, ['params', 'sensitivity'])
  const smooth = useAnimatable(clip, ['params', 'smoothing'])
  const bars = useAnimatable(clip, ['params', 'bars'])
  const pct = (v: unknown) => Math.round(Number(v ?? 0) * 100)
  return (
    <>
      <Header
        icon={<AudioWaveform />}
        title={clip.name ?? pluginRegistry.get(clip.generatorId)?.name ?? 'Visual'}
        meta={`Visualizer · ${formatTime(clip.start)} – ${formatTime(clip.start + clip.duration)}`}
      />
      <Section title="Reacts to">
        <FieldRow label="Source">
          <Select
            value={source}
            onChange={setSource}
            ariaLabel="Audio source"
            options={[
              { value: 'song', label: 'Whole song' },
              { value: 'drums', label: 'Drums stem' },
              { value: 'bass', label: 'Bass stem' },
              { value: 'vocals', label: 'Vocals stem' },
              { value: 'low', label: 'Low frequencies' },
              { value: 'onsets', label: 'Beats and hits' },
            ]}
          />
        </FieldRow>
        <FieldRow
          label="Sensitivity"
          trailing={
            <AnimateButtons
              property="Sensitivity"
              keyed={sens.keyed}
              onKey={sens.key}
              reactive={sens.reactive}
              onReact={sens.react}
            />
          }
        >
          <Slider
            value={pct(sens.value)}
            onChange={(v) => sens.set(v / 100)}
            onCommit={sens.commit}
            ariaLabel="Sensitivity"
          />
          <span className={`${styles.value} tnum`}>{pct(sens.value)}%</span>
        </FieldRow>
        <FieldRow
          label="Smoothing"
          trailing={<AnimateButtons property="Smoothing" keyed={smooth.keyed} onKey={smooth.key} />}
        >
          <Slider
            value={pct(smooth.value)}
            onChange={(v) => smooth.set(v / 100)}
            onCommit={smooth.commit}
            ariaLabel="Smoothing"
          />
          <span className={`${styles.value} tnum`}>{pct(smooth.value)}%</span>
        </FieldRow>
      </Section>
      <Section title="Style">
        <FieldRow
          label="Bars"
          trailing={<AnimateButtons property="Bars" keyed={bars.keyed} onKey={bars.key} />}
        >
          <NumberField
            value={Number(bars.value ?? 56)}
            onChange={(v) => bars.set(v)}
            onCommit={bars.commit}
            ariaLabel="Bar count"
            min={8}
            max={128}
          />
        </FieldRow>
        <FieldRow label="Color" trailing={<AnimateButtons property="Color" reactive />}>
          <ColorField value="#ffffff" ariaLabel="Bar color" />
        </FieldRow>
        <FieldRow label="Position" trailing={<span className={styles.trailSpacer} />}>
          <Segmented
            value="bottom"
            onChange={() => undefined}
            ariaLabel="Position"
            size="sm"
            block
            options={[
              { value: 'bottom', label: 'Bottom' },
              { value: 'center', label: 'Center' },
              { value: 'top', label: 'Top' },
            ]}
          />
        </FieldRow>
      </Section>
      <CompositingSection clip={clip} />
    </>
  )
}
