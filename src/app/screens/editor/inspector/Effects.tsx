import {
  Brush,
  Droplet,
  Film,
  Palette,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Waves,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import type { ColorAdjustmentKey, VisualClip } from '../../../../model/index.ts'
import { IconButton } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { AnimateButtons, FieldRow, Section, Slider, Switch } from '../../../ds/Fields.tsx'
import { dispatch } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import { useAnimatable } from './animatable.ts'
import { PluginParams } from './PluginParams.tsx'
import styles from '../Inspector.module.css'

/** An effect row's icon, by the effect's library category. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Basic: SlidersHorizontal,
  Blur: Droplet,
  Color: Palette,
  Distort: Waves,
  Glitch: Zap,
  Light: Sun,
  Stylize: Brush,
  Texture: Film,
}

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
        clip.effects.map((fx, index) => {
          const def = pluginRegistry.get(fx.effectId)
          const name = def?.name ?? fx.effectId
          const Icon = CATEGORY_ICONS[def?.category ?? ''] ?? Sparkles
          return (
            <div key={fx.id}>
              <div className={styles.effectRow}>
                <Icon className={styles.effectIcon} />
                <span className={styles.effectName}>{name}</span>
                <Switch
                  checked={fx.enabled}
                  onCheckedChange={(on) =>
                    dispatch(
                      { type: 'clip.set', clipId: clip.id, path: ['effects', index, 'enabled'], value: on },
                      { label: `${on ? 'Turn on' : 'Turn off'} effect: ${name}` },
                    )
                  }
                  ariaLabel={`${name} on`}
                />
                <IconButton
                  label={`Remove ${name}`}
                  size="xs"
                  tooltipSide="left"
                  onClick={() =>
                    dispatch(
                      { type: 'effect.remove', clipId: clip.id, effectInstanceId: fx.id },
                      { label: `Remove effect: ${name}` },
                    )
                  }
                >
                  <X />
                </IconButton>
              </div>
              <PluginParams
                clip={clip}
                base={['effects', index, 'params']}
                specs={(def?.params ?? []).filter((p) => !p.advanced)}
              />
            </div>
          )
        })
      )}
    </Section>
  )
}
