import { Palette } from 'lucide-react'
import type { AdjustmentClip, Project, VisualClip } from '../../../../model/index.ts'
import { currentLook, lookIdOf, lookRegistry, ORIGINAL_LOOK } from '../../../../plugins/looks.ts'
import { Button } from '../../../ds/Button.tsx'
import { AnimateButtons, FieldRow, Section, Slider } from '../../../ds/Fields.tsx'
import { formatSpan } from '../../../format.ts'
import { revealLooks } from '../../../state/library.ts'
import { isLookClip, useProject } from '../../../state/project.ts'
import { useAnimatable } from './animatable.ts'
import { ColorSection, EffectsSection } from './Effects.tsx'
import { Header } from './parts.tsx'
import styles from '../Inspector.module.css'

/** Where the look layer applies: everywhere, or the part of the video it was trimmed to. */
function lookSpan(project: Project, clip: VisualClip): string {
  let end = 0
  for (const c of Object.values(project.clips))
    if (c.id !== clip.id) end = Math.max(end, c.start + c.duration)
  const clipEnd = clip.start + clip.duration
  return clip.start <= 0.05 && clipEnd >= end - 0.05 ? 'On every clip' : formatSpan(clip.start, clip.duration)
}

/** The look's intensity is the opacity of its layer, so it can be keyframed and react to the music. */
function LookIntensity({ clip, name = 'Look intensity' }: { clip: VisualClip; name?: string }) {
  const intensity = useAnimatable(clip, ['opacity'], undefined, { label: name })
  const pct = Math.round(Number(intensity.value ?? 1) * 100)
  return (
    <FieldRow label="Intensity" trailing={<AnimateButtons property={name} {...intensity.buttons} />}>
      <Slider
        value={pct}
        onChange={(v) => intensity.set(v / 100)}
        onCommit={intensity.commit}
        ariaLabel={name}
      />
      <span className={`${styles.value} tnum`}>{pct}%</span>
    </FieldRow>
  )
}

/** The project's look, in the project inspector. */
export function LookSection() {
  const project = useProject()
  const current = currentLook(project)
  const found = current ? project.clips[current.clipId] : undefined
  const layer = found && found.type !== 'audio' ? found : undefined
  const look = current?.lookId ? lookRegistry.get(current.lookId) : undefined
  const thumbnail = layer ? look?.thumbnail : ORIGINAL_LOOK.thumbnail
  return (
    <Section title="Look">
      <div className={styles.lookCard}>
        <span
          className={styles.lookThumb}
          style={thumbnail ? { backgroundImage: `url(${thumbnail})` } : undefined}
        />
        <div className={styles.lookText}>
          <div className={styles.lookName}>
            {layer ? (look?.name ?? layer.name ?? 'Custom look') : ORIGINAL_LOOK.name}
          </div>
          <div className={styles.meta}>{layer ? lookSpan(project, layer) : 'No look'}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={revealLooks}>
          Change
        </Button>
      </div>
      {layer && <LookIntensity clip={layer} />}
    </Section>
  )
}

/**
 * A selected look layer: which look, how strongly it applies, and the color adjustments and effects it is made of.
 * Other adjustment layers (a VJ recording's effect hits) get the same, without the look.
 */
export function LookInspector({ clip }: { clip: AdjustmentClip }) {
  const project = useProject()
  const isLook = isLookClip(clip)
  const lookId = lookIdOf(clip)
  const look = lookId ? lookRegistry.get(lookId) : undefined
  const kind = isLook ? 'Look' : 'Adjustment layer'
  return (
    <>
      <Header
        thumb={look?.thumbnail}
        icon={<Palette />}
        title={look?.name ?? clip.name ?? (isLook ? 'Custom look' : kind)}
        meta={`${kind} · ${lookSpan(project, clip)}`}
      />
      <Section title={kind}>
        <LookIntensity clip={clip} name={isLook ? 'Look intensity' : 'Intensity'} />
        {isLook && (
          <div className={styles.stackActions}>
            <Button size="sm" variant="secondary" block onClick={revealLooks}>
              Change look
            </Button>
          </div>
        )}
      </Section>
      <ColorSection clip={clip} defaultOpen />
      <EffectsSection clip={clip} defaultOpen />
    </>
  )
}
