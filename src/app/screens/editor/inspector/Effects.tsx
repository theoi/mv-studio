import { AudioWaveform, Plus } from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import type { VisualClip } from '../../../../model/index.ts'
import { IconButton } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { AnimateButtons, FieldRow, Section, Slider } from '../../../ds/Fields.tsx'
import { dispatch, editor } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import styles from '../Inspector.module.css'

export function ColorSection({ clip }: { clip: VisualClip }) {
  return (
    <Section title="Color" defaultOpen={false}>
      {(['exposure', 'contrast', 'saturation'] as const).map((k) => (
        <FieldRow key={k} label={k[0]?.toUpperCase() + k.slice(1)} trailing={<AnimateButtons property={k} />}>
          <Slider
            value={Math.round(((clip.adjustments?.[k]?.value ?? 0) + 1) * 50)}
            min={0}
            max={100}
            onChange={(v) =>
              dispatch(
                {
                  type: 'clip.set',
                  clipId: clip.id,
                  path: ['adjustments'],
                  value: { ...clip.adjustments, [k]: { value: v / 50 - 1 } },
                },
                { coalesceKey: `inspector:${clip.id}:${k}` },
              )
            }
            onCommit={() => editor.endGesture()}
            ariaLabel={k}
          />
        </FieldRow>
      ))}
    </Section>
  )
}

export function EffectsSection({ clip }: { clip: VisualClip }) {
  return (
    <Section
      title="Effects"
      defaultOpen={false}
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
