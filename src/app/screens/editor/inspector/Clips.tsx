import { Layers } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Clip, Project, VideoClip, VisualClip } from '../../../../model/index.ts'
import { FieldRow, Section, Select, Slider, Switch } from '../../../ds/Fields.tsx'
import { keyName } from '../../../ds/keys.ts'
import { formatSpan } from '../../../format.ts'
import { dispatch, editor, hasShotSound, useProject } from '../../../state/project.ts'
import {
  setShotsMuted,
  setShotsVolume,
  shotVolumeAt,
  volumeKeptNote,
  volumeSettableAt,
} from '../../../state/shotSound.ts'
import { useUi } from '../../../state/ui.ts'
import { blendModes } from './blendModes.ts'
import { Header } from './parts.tsx'
import { ProjectInspector } from './Project.tsx'
import styles from '../Inspector.module.css'

const isVisual = (c: Clip): c is VisualClip => c.type !== 'audio'

/** Several selected clips: their span, and the properties they share, changed on all of them at once. */
export function ClipsInspector({ ids }: { ids: string[] }) {
  const project = useProject()
  const clips = ids.flatMap((id) => {
    const c = project.clips[id]
    return c ? [c] : []
  })
  if (!clips.length) return <ProjectInspector />
  const start = Math.min(...clips.map((c) => c.start))
  const end = Math.max(...clips.map((c) => c.start + c.duration))
  const visual = clips.filter(isVisual)
  const shots = clips.filter((c) => hasShotSound(project, c))
  return (
    <>
      <Header icon={<Layers />} title={`${clips.length} clips`} meta={formatSpan(start, end - start)} />
      {visual.length > 0 && <SharedCompositing clips={visual} />}
      {shots.length > 0 && <SharedSound project={project} shots={shots} />}
      <p className={styles.note}>
        Shift-click or {keyName('Mod')}-click a clip to add or remove it. Drag across empty track space to
        select an area.
      </p>
    </>
  )
}

function SharedCompositing({ clips }: { clips: VisualClip[] }) {
  const opacities = clips.map((c) => c.opacity.value)
  const sameOpacity = opacities.every((v) => v === opacities[0])
  const pct = Math.round((opacities.reduce((a, v) => a + v, 0) / opacities.length) * 100)
  const blend = clips.every((c) => c.blendMode === clips[0]?.blendMode) ? clips[0]?.blendMode : undefined
  const key = clips.map((c) => c.id).join(',')
  return (
    <Section title="Compositing">
      <FieldRow label="Opacity" trailing={<span className={styles.trailSpacer} />}>
        <Slider
          value={pct}
          onChange={(v) =>
            dispatch(
              clips.map((c) => ({
                type: 'clip.set' as const,
                clipId: c.id,
                path: ['opacity', 'value'],
                value: v / 100,
              })),
              { coalesceKey: `inspector:${key}:opacity`, label: 'Change opacity' },
            )
          }
          onCommit={() => editor.endGesture()}
          ariaLabel="Opacity"
        />
        <span className={`${styles.value} tnum`}>{sameOpacity ? `${pct}%` : 'Mixed'}</span>
      </FieldRow>
      <FieldRow label="Blend" trailing={<span className={styles.trailSpacer} />}>
        <Select<string>
          value={blend ?? ''}
          onChange={(v) => {
            const mode = blendModes.find((b) => b.value === v)?.value
            if (mode)
              dispatch(
                clips.map((c) => ({
                  type: 'clip.set' as const,
                  clipId: c.id,
                  path: ['blendMode'],
                  value: mode,
                })),
                { label: 'Change blend mode' },
              )
          }}
          options={blendModes}
          placeholder="Mixed"
          ariaLabel="Blend mode"
        />
      </FieldRow>
    </Section>
  )
}

/**
 * The own sound of the selected shots whose files have sound: on or off for all, and the volume of those playing at
 * the playhead. A shot with Volume keyframes away from the playhead keeps its volume, and a note says so.
 */
function SharedSound({ project, shots }: { project: Project; shots: VideoClip[] }) {
  const ids = shots.map((c) => c.id)
  const playing = shots.filter((c) => !c.muted)
  const allOn = playing.length === shots.length
  // Keyframed volumes change with the playhead; shallow equality re-renders only when a shown level changes.
  const levels = useUi(
    useShallow((s) =>
      playing.flatMap((c) => (volumeSettableAt(c, s.playhead) ? [shotVolumeAt(c, s.playhead)] : [])),
    ),
  )
  const kept = useUi((s) => volumeKeptNote(project, playing, s.playhead))
  const sameVolume = levels.every((v) => v === levels[0])
  const pct = Math.round((levels.reduce((a, v) => a + v, 0) / Math.max(1, levels.length)) * 100)
  return (
    <Section title="Sound">
      <FieldRow label="Own sound" trailing={<span className={styles.trailSpacer} />}>
        <Switch
          checked={allOn}
          onCheckedChange={(play) => setShotsMuted(ids, !play)}
          ariaLabel="Play the shots’ own sound"
        />
        {playing.length > 0 && !allOn && <span className={styles.value}>Mixed</span>}
      </FieldRow>
      {levels.length > 0 && (
        <FieldRow label="Volume" trailing={<span className={styles.trailSpacer} />}>
          <Slider
            value={pct}
            onChange={(v) =>
              setShotsVolume(
                playing.map((c) => c.id),
                v / 100,
                { coalesceKey: `inspector:${ids.join(',')}:volume`, keepMuted: true },
              )
            }
            onCommit={() => editor.endGesture()}
            ariaLabel="Volume"
          />
          <span className={`${styles.value} tnum`}>{sameVolume ? `${pct}%` : 'Mixed'}</span>
        </FieldRow>
      )}
      {playing.length === 0 && <p className={styles.note}>Off: only the song plays during these shots.</p>}
      {kept && <p className={styles.note}>{kept}</p>}
    </Section>
  )
}
