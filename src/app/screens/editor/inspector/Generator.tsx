import { AudioWaveform } from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import { STEM_NAMES, type Clip, type StemName } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Section, Select } from '../../../ds/Fields.tsx'
import { formatSpan } from '../../../format.ts'
import { dispatch, songAnalysis, useProject } from '../../../state/project.ts'
import { openAssist } from '../../../state/ui.ts'
import { CompositingSection, Header } from './parts.tsx'
import { PluginParams } from './PluginParams.tsx'
import styles from '../Inspector.module.css'

const MIX = 'mix'

const STEM_LABEL: Record<StemName, string> = {
  vocals: 'Vocals stem',
  drums: 'Drums stem',
  bass: 'Bass stem',
  other: 'Other instruments stem',
}

const STEM_DESCRIPTION: Record<StemName, string> = {
  vocals: 'Only the singing',
  drums: 'Only the drums',
  bass: 'Only the bass',
  other: 'Everything but vocals, drums and bass',
}

/** Visualizers and shader visuals: what they react to, their own settings, and compositing. */
export function GeneratorInspector({ clip }: { clip: Extract<Clip, { type: 'generator' }> }) {
  const project = useProject()
  const def = pluginRegistry.get(clip.generatorId)
  const stems = songAnalysis(project)?.stemFeatures ?? {}
  const separated = STEM_NAMES.some((s) => stems[s])
  const options = [
    { value: MIX, label: 'Whole song', description: 'The full mix' },
    ...STEM_NAMES.map((s) => ({
      value: s,
      label: STEM_LABEL[s],
      description: stems[s] ? STEM_DESCRIPTION[s] : 'Separate stems first',
      disabled: !stems[s],
    })),
  ]
  const setSource = (value: string) => {
    const stem = STEM_NAMES.find((s) => s === value)
    if ((clip.audio?.stem ?? MIX) === value) return
    dispatch(
      { type: 'clip.setAudioSource', clipId: clip.id, source: stem ? { stem } : null },
      { label: stem ? `React to the ${STEM_LABEL[stem].toLowerCase()}` : 'React to the whole song' },
    )
  }
  const params = def?.params ?? []
  const advanced = params.filter((p) => p.advanced)
  return (
    <>
      <Header
        icon={<AudioWaveform />}
        title={clip.name ?? def?.name ?? 'Visual'}
        meta={`${def?.category ?? 'Visual'} · ${formatSpan(clip.start, clip.duration)}`}
      />
      <Section title="Reacts to">
        <FieldRow label="Source" trailing={<span className={styles.trailSpacer} />}>
          <Select
            value={clip.audio?.stem ?? MIX}
            onChange={setSource}
            ariaLabel="Audio source"
            options={options}
          />
        </FieldRow>
        {!separated && (
          <div className={styles.padded}>
            <div className={styles.timedRow}>
              <span className={styles.meta}>Stems not separated yet</span>
              <Button
                size="sm"
                variant="ghost"
                className={styles.forwardAction}
                onClick={() => openAssist('stems')}
              >
                Separate stems
              </Button>
            </div>
          </div>
        )}
      </Section>
      <Section title="Style">
        <PluginParams clip={clip} base={['params']} specs={params.filter((p) => !p.advanced)} />
      </Section>
      {advanced.length > 0 && (
        <Section title="More" defaultOpen={false}>
          <PluginParams clip={clip} base={['params']} specs={advanced} />
        </Section>
      )}
      <CompositingSection clip={clip} />
    </>
  )
}
