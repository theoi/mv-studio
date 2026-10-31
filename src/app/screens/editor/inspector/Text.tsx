import { Type } from 'lucide-react'
import type { Clip } from '../../../../model/index.ts'
import { AnimateButtons, FieldRow, NumberField, Section, Select, TextArea } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { dispatch, editor } from '../../../state/project.ts'
import { Header, TransformSection } from './parts.tsx'
import styles from '../Inspector.module.css'

export function TextInspector({ clip }: { clip: Extract<Clip, { type: 'text' }> }) {
  return (
    <>
      <Header
        icon={<Type />}
        title={clip.name ?? 'Text'}
        meta={`Text · ${formatTime(clip.start, true)} – ${formatTime(clip.start + clip.duration, true)}`}
      />
      <Section title="Text">
        <div className={styles.padded}>
          <TextArea
            value={clip.text}
            onChange={(e) =>
              dispatch(
                { type: 'clip.set', clipId: clip.id, path: ['text'], value: e.target.value },
                { coalesceKey: `inspector:${clip.id}:text` },
              )
            }
            onBlur={() => editor.endGesture()}
            rows={2}
            aria-label="Text content"
          />
        </div>
        <FieldRow label="Font">
          <Select
            value="inter"
            onChange={() => undefined}
            ariaLabel="Font"
            options={[{ value: 'inter', label: 'Inter Display' }]}
          />
        </FieldRow>
        <FieldRow label="Size" trailing={<AnimateButtons property="Size" />}>
          <NumberField
            value={clip.style.fontSize}
            onChange={(v) =>
              dispatch(
                { type: 'clip.set', clipId: clip.id, path: ['style', 'fontSize'], value: v },
                { coalesceKey: `inspector:${clip.id}:size` },
              )
            }
            onCommit={() => editor.endGesture()}
            unit="px"
            min={8}
            ariaLabel="Font size"
          />
        </FieldRow>
      </Section>
      <TransformSection clip={clip} />
    </>
  )
}
