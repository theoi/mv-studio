import type { TextClip } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Section, Segmented, Select, Switch } from '../../../ds/Fields.tsx'
import { dispatch } from '../../../state/project.ts'
import {
  applyStyleToAllLines,
  linePosition,
  NO_PRESET,
  presetOptions,
  setLinePosition,
  setPreset,
  type LinePosition,
} from '../../../state/textStyle.ts'
import { FontRow, PresetSettings, SizeRow, TextColor } from './Text.tsx'
import styles from '../Inspector.module.css'

const KARAOKE = { highlightColor: '#ffd27a', mode: 'word' } as const

/** How a lyric line looks and animates, and applying that to every line. `clip` is the line's text clip, if placed. */
export function LyricStyleSections({ clip }: { clip?: TextClip }) {
  if (!clip)
    return (
      <Section title="Style">
        <p className={styles.note}>This line is not on the timeline yet, so it has no style to change.</p>
      </Section>
    )
  const spacer = <span className={styles.trailSpacer} />
  return (
    <>
      <Section title="Style">
        <FieldRow label="Preset" trailing={spacer}>
          <Select
            value={clip.animation?.presetId ?? NO_PRESET}
            onChange={(id) => setPreset(clip, id)}
            ariaLabel="Kinetic preset"
            options={presetOptions()}
          />
        </FieldRow>
        <FontRow clip={clip} />
        <SizeRow clip={clip} />
        <FieldRow label="Color" trailing={spacer}>
          <TextColor clip={clip} path={['style', 'color']} value={clip.style.color} ariaLabel="Text color" />
        </FieldRow>
        <FieldRow label="Karaoke" trailing={spacer}>
          <Switch
            checked={!!clip.karaoke}
            onCheckedChange={(on) =>
              dispatch(
                {
                  type: 'clip.set',
                  clipId: clip.id,
                  path: ['karaoke'],
                  value: on ? { ...KARAOKE } : undefined,
                },
                { label: on ? 'Karaoke highlight' : 'No karaoke highlight' },
              )
            }
            ariaLabel="Karaoke word highlight"
          />
          {clip.karaoke && (
            <TextColor
              clip={clip}
              path={['karaoke', 'highlightColor']}
              value={clip.karaoke.highlightColor}
              ariaLabel="Highlight color"
            />
          )}
        </FieldRow>
        <FieldRow label="Position" trailing={spacer}>
          <Segmented<LinePosition>
            value={linePosition(clip)}
            onChange={(p) => setLinePosition(clip, p)}
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
        <PresetSettings clip={clip} />
      </Section>
      <div className={styles.footerAction}>
        <Button variant="secondary" size="sm" block onClick={() => applyStyleToAllLines(clip)}>
          Apply style to all lines
        </Button>
      </div>
    </>
  )
}
