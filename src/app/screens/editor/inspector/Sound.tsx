import type { VideoClip } from '../../../../model/index.ts'
import { AnimateButtons, FieldRow, Section, Slider, Switch } from '../../../ds/Fields.tsx'
import { hasShotSound, useProject } from '../../../state/project.ts'
import { setShotsMuted, shotSilencedBy } from '../../../state/shotSound.ts'
import { useAnimatable } from './animatable.ts'
import styles from '../Inspector.module.css'

/** A shot's own sound, for a file that has sound: on or off (shots start off), and its volume, which takes keyframes. */
export function SoundSection({ clip }: { clip: VideoClip }) {
  const project = useProject()
  const volume = useAnimatable(clip, ['volume'], undefined, { label: 'Shot volume' })
  if (!hasShotSound(project, clip)) return null
  const on = !clip.muted
  const pct = Math.round(Number(volume.value ?? 1) * 100)
  const silenced = on ? shotSilencedBy(project, clip) : null
  return (
    <Section title="Sound">
      <FieldRow label="Own sound" trailing={<span className={styles.trailSpacer} />}>
        <Switch
          checked={on}
          onCheckedChange={(play) => setShotsMuted([clip.id], !play)}
          ariaLabel="Play the shot’s own sound"
        />
      </FieldRow>
      {on && (
        <FieldRow label="Volume" trailing={<AnimateButtons property="Volume" {...volume.buttons} />}>
          <Slider
            value={pct}
            onChange={(v) => volume.set(v / 100)}
            onCommit={volume.commit}
            ariaLabel="Volume"
          />
          <span className={`${styles.value} tnum`}>{pct}%</span>
        </FieldRow>
      )}
      {!on ? (
        <p className={styles.note}>Off: only the song plays during this shot.</p>
      ) : (
        silenced && <p className={styles.note}>{silenced}</p>
      )}
    </Section>
  )
}
