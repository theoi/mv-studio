import { AudioWaveform, Plus } from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import type { ColorAdjustmentKey, VisualClip } from '../../../../model/index.ts'
import { IconButton } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { AnimateButtons, FieldRow, Section, Slider } from '../../../ds/Fields.tsx'
import { set } from '../../../state/ui.ts'
import { useAnimatable } from './animatable.ts'
import styles from '../Inspector.module.css'

const ADJUSTMENTS: readonly { key: ColorAdjustmentKey; label: string }[] = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'temperature', label: 'Temperature' },
  { key: 'tint', label: 'Tint' },
  { key: 'hue', label: 'Hue' },
]
/** Shown on every clip; the others only once the clip has them, as a look's temperature. */
const ALWAYS: ReadonlySet<ColorAdjustmentKey> = new Set(['exposure', 'contrast', 'saturation'])

/** One color adjustment (-1..1, neutral 0) on a 0..100 slider. */
function AdjustmentRow({
  clip,
  adjustment,
  label,
}: {
  clip: VisualClip
  adjustment: ColorAdjustmentKey
  label: string
}) {
  const a = useAnimatable(clip, ['adjustments', adjustment], 0, { label })
  return (
    <FieldRow label={label} trailing={<AnimateButtons property={label} {...a.buttons} />}>
      <Slider
        value={Math.round((Number(a.value) + 1) * 50)}
        min={0}
        max={100}
        onChange={(v) => a.set(v / 50 - 1)}
        onCommit={a.commit}
        ariaLabel={label}
      />
    </FieldRow>
  )
}

export function ColorSection({ clip, defaultOpen = false }: { clip: VisualClip; defaultOpen?: boolean }) {
  return (
    <Section title="Color" defaultOpen={defaultOpen}>
      {ADJUSTMENTS.filter((x) => ALWAYS.has(x.key) || clip.adjustments?.[x.key]).map((x) => (
        <AdjustmentRow key={x.key} clip={clip} adjustment={x.key} label={x.label} />
      ))}
    </Section>
  )
}

export function EffectsSection({ clip, defaultOpen = false }: { clip: VisualClip; defaultOpen?: boolean }) {
  return (
    <Section
      title="Effects"
      defaultOpen={defaultOpen}
      badge={clip.effects.length ? <Badge>{clip.effects.length}</Badge> : undefined}
      actions={
        <IconButton
          label="Add effect"
          size="xs"
          tooltipSide="left"
          onClick={() => set({ libraryTab: 'effects', libraryOpen: true })}
        >
          <Plus />
        </IconButton>
      }
    >
      {clip.effects.length === 0 ? (
        <p className={styles.note}>No effects yet. Add one from Library › Effects.</p>
      ) : (
        clip.effects.map((fx) => (
          <div key={fx.id} className={styles.effectRow}>
            <AudioWaveform className={styles.effectIcon} />
            <span className={styles.effectName}>{pluginRegistry.get(fx.effectId)?.name ?? fx.effectId}</span>
          </div>
        ))
      )}
    </Section>
  )
}
