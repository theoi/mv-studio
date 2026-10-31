import type { TextClip } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Section, Segmented, Switch } from '../../../ds/Fields.tsx'
import { dispatch } from '../../../state/project.ts'
import {
  applyStyleToAllLines,
  linePosition,
  setLinePosition,
  type LinePosition,
} from '../../../state/textStyle.ts'
import {
  ColorRow,
  DecorationSections,
  FontRow,
  PresetRow,
  PresetSettings,
  SizeRow,
  TextColor,
  WeightRow,
} from './Text.tsx'
import styles from '../Inspector.module.css'

const KARAOKE = { highlightColor: '#ffd27a', mode: 'word' } as const

type KaraokeMode = NonNullable<TextClip['karaoke']>['mode']

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
        <PresetRow clip={clip} />
        <FontRow clip={clip} />
        <WeightRow clip={clip} />
        <SizeRow clip={clip} />
        <ColorRow clip={clip} />
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
        {clip.karaoke && (
          <FieldRow label="Fill" trailing={spacer}>
            <Segmented<KaraokeMode>
              value={clip.karaoke.mode}
              onChange={(mode) =>
                dispatch(
                  { type: 'clip.set', clipId: clip.id, path: ['karaoke', 'mode'], value: mode },
                  { label: mode === 'word' ? 'Karaoke fills word by word' : 'Karaoke lights the whole line' },
                )
              }
              ariaLabel="Karaoke fill"
              size="sm"
              block
              options={[
                { value: 'word', label: 'By word' },
                { value: 'line', label: 'By line' },
              ]}
            />
          </FieldRow>
        )}
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
      <DecorationSections clip={clip} />
      <div className={styles.footerAction}>
        <Button variant="secondary" size="sm" block onClick={() => applyStyleToAllLines(clip)}>
          Apply style to all lines
        </Button>
      </div>
    </>
  )
}
