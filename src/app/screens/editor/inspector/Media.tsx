import type { VisualClip } from '../../../../model/index.ts'
import { FieldRow, NumberField, Section, Select } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { dispatch, editor, useProject } from '../../../state/project.ts'
import { clipReframeMode, framingHint, setClipReframe } from '../../../state/reframe.ts'
import { useFrameThumbnail } from '../../../state/thumbs.ts'
import { AnimateAction } from './Animate.tsx'
import { CameraSection, CameraSuggestion } from './Camera.tsx'
import { ColorSection, EffectsSection } from './Effects.tsx'
import { BehindSuggestion, LayeringSection } from './Layering.tsx'
import { CompositingSection, Header, TransformSection } from './parts.tsx'
import { SoundSection } from './Sound.tsx'
import styles from '../Inspector.module.css'

export function MediaInspector({ clip }: { clip: VisualClip & { assetId: string } }) {
  const project = useProject()
  const asset = project.assets[clip.assetId]
  const thumb = useFrameThumbnail(asset, clip.type === 'video' ? clip.sourceStart : 0)
  const isImage = clip.type === 'image'
  const end = clip.start + clip.duration
  const meta = `${isImage ? 'Image' : 'Video'} · ${formatTime(clip.start, true)} – ${formatTime(end, true)} · ${clip.duration.toFixed(1)} s`
  return (
    <>
      <Header thumb={thumb} title={clip.name ?? asset?.name ?? 'Clip'} meta={meta} />
      <BehindSuggestion clip={clip} />
      {clip.type === 'image' && <AnimateAction clip={clip} />}
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
              { value: 'auto', label: 'Auto', description: 'Follow the subject' },
              { value: 'fit', label: 'Fit', description: 'Fit with bars' },
              { value: 'fill', label: 'Fill', description: 'Center crop' },
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
                  { label: 'Change speed', coalesceKey: `inspector:${clip.id}:speed` },
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
      {clip.type === 'video' && <SoundSection clip={clip} />}
    </>
  )
}
