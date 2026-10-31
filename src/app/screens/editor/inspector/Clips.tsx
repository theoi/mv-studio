import { Layers } from 'lucide-react'
import type { Clip, VisualClip } from '../../../../model/index.ts'
import { FieldRow, Section, Select, Slider } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { dispatch, editor, useProject } from '../../../state/project.ts'
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
  return (
    <>
      <Header
        icon={<Layers />}
        title={`${clips.length} clips`}
        meta={`${formatTime(start)} – ${formatTime(end)}`}
      />
      {visual.length > 0 && <SharedCompositing clips={visual} />}
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
          ariaLabel="Blend mode"
        />
      </FieldRow>
    </Section>
  )
}
