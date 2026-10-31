import { useState } from 'react'
import type { Clip } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import {
  AnimateButtons,
  ColorField,
  FieldRow,
  NumberField,
  Section,
  Segmented,
  Select,
  Switch,
} from '../../../ds/Fields.tsx'
import { dispatch, editor, lyricLines, useProject } from '../../../state/project.ts'
import { toast } from '../../../state/ui.ts'
import styles from '../Inspector.module.css'

/** How a lyric line looks and animates, and applying that to every line. `clip` is the line's text clip, if placed. */
export function LyricStyleSections({ clip }: { clip?: Extract<Clip, { type: 'text' }> }) {
  const project = useProject()
  const [preset, setPreset] = useState('rise')
  const [pos, setPos] = useState('lower')
  const karaoke = !!clip?.karaoke
  return (
    <>
      <Section title="Style">
        <FieldRow label="Preset">
          <Select
            value={preset}
            onChange={setPreset}
            ariaLabel="Kinetic preset"
            options={[
              { value: 'rise', label: 'Rise', description: 'Words float up as they are sung' },
              { value: 'pop', label: 'Pop', description: 'Words bounce in on the beat' },
              { value: 'type', label: 'Typewriter' },
              { value: 'sweep', label: 'Karaoke sweep' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Font">
          <Select
            value="inter"
            onChange={() => undefined}
            ariaLabel="Font"
            options={[
              { value: 'inter', label: 'Inter Display · Bold' },
              { value: 'serif', label: 'Serif · Italic' },
            ]}
          />
        </FieldRow>
        {clip && (
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
        )}
        <FieldRow label="Color" trailing={<AnimateButtons property="Color" />}>
          <ColorField value={clip?.style.color ?? '#ffffff'} ariaLabel="Text color" />
        </FieldRow>
        <FieldRow label="Karaoke" trailing={<span className={styles.trailSpacer} />}>
          <Switch
            checked={karaoke}
            onCheckedChange={(v) =>
              clip &&
              dispatch(
                {
                  type: 'clip.set',
                  clipId: clip.id,
                  path: ['karaoke'],
                  value: v ? { highlightColor: '#ffd27a', mode: 'word' } : null,
                },
                { label: 'Karaoke highlight' },
              )
            }
            ariaLabel="Karaoke word highlight"
          />
          {karaoke && (
            <ColorField value={clip?.karaoke?.highlightColor ?? '#ffd27a'} ariaLabel="Highlight color" />
          )}
        </FieldRow>
        <FieldRow label="Position" trailing={<span className={styles.trailSpacer} />}>
          <Segmented
            value={pos}
            onChange={setPos}
            ariaLabel="Position"
            size="sm"
            block
            options={[
              { value: 'top', label: 'Top' },
              { value: 'center', label: 'Center' },
              { value: 'lower', label: 'Lower' },
            ]}
          />
        </FieldRow>
      </Section>
      <Section title="Animation" defaultOpen={false}>
        <FieldRow label="In">
          <Select
            value="rise"
            onChange={() => undefined}
            ariaLabel="Animation in"
            options={[{ value: 'rise', label: 'Rise · 0.3 s' }]}
          />
        </FieldRow>
        <FieldRow label="Out">
          <Select
            value="fade"
            onChange={() => undefined}
            ariaLabel="Animation out"
            options={[{ value: 'fade', label: 'Fade · 0.3 s' }]}
          />
        </FieldRow>
      </Section>
      <div className={styles.footerAction}>
        <Button
          variant="secondary"
          size="sm"
          block
          onClick={() => toast(`Style applied to all ${lyricLines(project).length} lyric lines`)}
        >
          Apply style to all lines
        </Button>
      </div>
    </>
  )
}
