import { useRef, useState } from 'react'
import {
  Brush,
  ChevronRight,
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
import { Collapsible } from 'radix-ui'
import { pluginRegistry } from '../../../../engine/registry.ts'
import type { ParamSpec } from '../../../../engine/types.ts'
import type { ColorAdjustmentKey, PropertyPath, VisualClip } from '../../../../model/index.ts'
import { CAMERA_EFFECT_ID } from '../../../../vision/render/cameraEffect.ts'
import { IconButton } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { AnimateButtons, FieldRow, Section, Slider, Switch } from '../../../ds/Fields.tsx'
import { dispatch } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import { ADJUSTMENTS, ALWAYS, useAnimatable } from './animatable.ts'
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
  const addRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** After a removal, focus goes to the next effect's switch, else the previous one's, else Add effect. */
  const focusAfterRemoving = (index: number) => {
    const next = clip.effects[index + 1] ?? clip.effects[index - 1]
    requestAnimationFrame(() => {
      const target =
        next && listRef.current?.querySelector<HTMLElement>(`[data-effect-row="${next.id}"] [role="switch"]`)
      ;(target ?? addRef.current)?.focus()
    })
  }
  return (
    <Section
      title="Effects"
      defaultOpen={defaultOpen}
      badge={clip.effects.length ? <Badge>{clip.effects.length}</Badge> : undefined}
      actions={
        <IconButton
          ref={addRef}
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
        <div ref={listRef}>
          {clip.effects.map((fx, index) => {
            const def = pluginRegistry.get(fx.effectId)
            const name = def?.name ?? fx.effectId
            const Icon = CATEGORY_ICONS[def?.category ?? ''] ?? Sparkles
            // The 3D camera move is set in Motion (its move and strength, with its progress keyed across the clip).
            const params = fx.effectId === CAMERA_EFFECT_ID ? [] : (def?.params ?? [])
            const basic = params.filter((p) => !p.advanced)
            const advanced = params.filter((p) => p.advanced)
            const base: PropertyPath = ['effects', index, 'params']
            return (
              <div key={fx.id}>
                <div className={styles.effectRow} data-effect-row={fx.id}>
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
                    onClick={() => {
                      dispatch(
                        { type: 'effect.remove', clipId: clip.id, effectInstanceId: fx.id },
                        { label: `Remove effect: ${name}` },
                      )
                      focusAfterRemoving(index)
                    }}
                  >
                    <X />
                  </IconButton>
                </div>
                {params.length > 0 && (
                  <div className={fx.enabled ? undefined : styles.effectOff}>
                    <PluginParams clip={clip} base={base} specs={basic} owner={name} />
                    {advanced.length > 0 && (
                      <MoreSettings clip={clip} base={base} specs={advanced} owner={name} />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

/** An effect's secondary settings, collapsed under "More" so a clip with several effects stays short. */
function MoreSettings({
  clip,
  base,
  specs,
  owner,
}: {
  clip: VisualClip
  base: PropertyPath
  specs: ParamSpec[]
  owner: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className={styles.effectMore} aria-label={`More ${owner} settings`}>
        <ChevronRight
          className={[styles.effectMoreChevron, open && styles.effectMoreOpen].filter(Boolean).join(' ')}
        />
        More
      </Collapsible.Trigger>
      <Collapsible.Content>
        <PluginParams clip={clip} base={base} specs={specs} owner={owner} />
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
