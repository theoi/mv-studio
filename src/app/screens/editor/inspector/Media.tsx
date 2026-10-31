import type { VisualClip } from '../../../../model/index.ts'
import { FieldRow, NumberField, Section, Select } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { sceneThumb } from '../../../mock/art.ts'
import { sceneOf } from '../../../mock/demoProject.ts'
import { dispatch, editor, useProject } from '../../../state/project.ts'
import { clipReframeMode, framingHint, setClipReframe } from '../../../state/reframe.ts'
import { CameraSection, CameraSuggestion } from './Camera.tsx'
import { ColorSection, EffectsSection } from './Effects.tsx'
import { BehindSuggestion, LayeringSection } from './Layering.tsx'
import { CompositingSection, Header, TransformSection } from './parts.tsx'
import styles from '../Inspector.module.css'

export function MediaInspector({ clip }: { clip: VisualClip & { assetId: string } }) {
  const project = useProject()
  const asset = project.assets[clip.assetId]
  const scene = sceneOf(asset)
  const isImage = clip.type === 'image'
  const end = clip.start + clip.duration
  const meta = `${isImage ? 'Image' : 'Video'} · ${formatTime(clip.start, true)} – ${formatTime(end, true)} · ${clip.duration.toFixed(1)} s`
  return (
    <>
      <Header
        thumb={scene ? sceneThumb(scene) : undefined}
        title={clip.name ?? asset?.name ?? 'Clip'}
        meta={meta}
      />
      <BehindSuggestion clip={clip} />
      {isImage && <CameraSuggestion clip={clip} />}
      <TransformSection clip={clip} />
      <CompositingSection clip={clip} />
      {isImage && <CameraSection clip={clip} />}
      <LayeringSection clip={clip} />
      <ColorSection clip={clip} />
      <EffectsSection clip={clip} />
      <Section title="Framing" defaultOpen={false}>
        <FieldRow label="Reframe" trailing={<span className={styles.trailSpacer} />}>
          <Select
            value={clipReframeMode(project, clip.id)}
            onChange={(mode) => setClipReframe(clip.id, mode)}
            ariaLabel="Reframe"
            options={[
              { value: 'auto', label: 'Auto', description: 'Follows the subject' },
              { value: 'fit', label: 'Fit', description: 'The whole picture, with bars' },
              { value: 'fill', label: 'Fill', description: 'Crops the center' },
            ]}
          />
        </FieldRow>
        <p className={styles.note}>{framingHint(project, clip)}</p>
      </Section>
      {clip.type === 'video' && (
        <Section title="Speed" defaultOpen={false}>
          <FieldRow label="Speed" trailing={<span className={styles.trailSpacer} />}>
            <NumberField
              value={Math.round(clip.playbackRate * 100)}
              onChange={(v) =>
                dispatch(
                  { type: 'clip.set', clipId: clip.id, path: ['playbackRate'], value: v / 100 },
                  { coalesceKey: `inspector:${clip.id}:speed` },
                )
              }
              onCommit={() => editor.endGesture()}
              unit="%"
              min={10}
              ariaLabel="Speed"
            />
          </FieldRow>
        </Section>
      )}
    </>
  )
}
