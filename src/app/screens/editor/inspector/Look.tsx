import type { Project, VisualClip } from '../../../../model/index.ts'
import { currentLook, lookRegistry, ORIGINAL_LOOK } from '../../../../plugins/looks.ts'
import { Button } from '../../../ds/Button.tsx'
import { AnimateButtons, FieldRow, Section, Slider } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { useProject } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import { useAnimatable } from './animatable.ts'
import styles from '../Inspector.module.css'

/** Where the look layer applies: everywhere, or the part of the video it was trimmed to. */
function lookSpan(project: Project, clip: VisualClip): string {
  let end = 0
  for (const c of Object.values(project.clips))
    if (c.id !== clip.id) end = Math.max(end, c.start + c.duration)
  const clipEnd = clip.start + clip.duration
  return clip.start <= 0.05 && clipEnd >= end - 0.05
    ? 'On every clip'
    : `${formatTime(clip.start)} to ${formatTime(clipEnd)}`
}

/** The look's intensity is the opacity of its layer, so it can be keyframed and react to the music. */
function LookIntensity({ clip }: { clip: VisualClip }) {
  const intensity = useAnimatable(clip, ['opacity'], undefined, { label: 'Look intensity' })
  const pct = Math.round(Number(intensity.value ?? 1) * 100)
  return (
    <FieldRow
      label="Intensity"
      trailing={<AnimateButtons property="Look intensity" {...intensity.buttons} />}
    >
      <Slider
        value={pct}
        onChange={(v) => intensity.set(v / 100)}
        onCommit={intensity.commit}
        ariaLabel="Look intensity"
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
        <Button
          size="sm"
          variant="secondary"
          onClick={() => set({ libraryTab: 'effects', libraryOpen: true })}
        >
          Change
        </Button>
      </div>
      {layer && <LookIntensity clip={layer} />}
    </Section>
  )
}
