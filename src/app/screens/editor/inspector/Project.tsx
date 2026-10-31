import { Layers, Music2 } from 'lucide-react'
import type { AspectPreset } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { ColorField, FieldRow, Section, Segmented, Select } from '../../../ds/Fields.tsx'
import { formatBpm, plural } from '../../../format.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { dispatch, editor, hasSong, sectionsOf, songAnalysis, useProject } from '../../../state/project.ts'
import { changeAspect } from '../../../state/reframe.ts'
import { useJob } from '../assist/jobState.ts'
import { openAssist } from '../../../state/ui.ts'
import { LookSection } from './Look.tsx'
import { Header } from './parts.tsx'
import styles from '../Inspector.module.css'

/** What Inspector › Song says about the song: the facts analysis found, or where analysis stands. */
function useSongFacts(): string {
  const project = useProject()
  const analysis = useJob(JOB_KINDS.analysis).phase
  const tempo = songAnalysis(project)?.tempo
  if (tempo && tempo.bpm > 0)
    return `${formatBpm(tempo.bpm)} · 4/4 · ${plural(sectionsOf(project).length, 'section')}`
  if (analysis === 'running') return 'Analyzing the song…'
  if (analysis === 'failed') return 'Couldn’t analyze the song'
  return songAnalysis(project) ? 'No beat found' : 'Not analyzed yet'
}

export function ProjectInspector() {
  const project = useProject()
  const empty = !hasSong(project)
  const facts = useSongFacts()
  const { aspect, fps } = project.settings
  return (
    <>
      <Header icon={<Layers />} title="Project" meta="Settings for the whole video" />
      <Section title="Format">
        <FieldRow label="Aspect" stacked>
          <Segmented<AspectPreset>
            block
            value={aspect}
            onChange={changeAspect}
            ariaLabel="Aspect ratio"
            options={(['16:9', '9:16', '1:1', '4:5'] as const).map((v) => ({ value: v, label: v }))}
          />
        </FieldRow>
        <FieldRow label="Frame rate">
          <Select
            value={String(fps)}
            onChange={(v) =>
              dispatch(
                { type: 'project.updateSettings', settings: { fps: Number(v) } },
                { label: 'Change frame rate' },
              )
            }
            ariaLabel="Frame rate"
            options={['24', '25', '30', '60'].map((v) => ({ value: v, label: `${v} fps` }))}
          />
        </FieldRow>
        <FieldRow label="Background">
          <ColorField
            value={project.settings.backgroundColor}
            ariaLabel="Background color"
            onChange={(hex) =>
              dispatch(
                { type: 'project.updateSettings', settings: { backgroundColor: hex } },
                { label: 'Change background color', coalesceKey: 'inspector:project:background' },
              )
            }
            onCommit={() => editor.endGesture()}
          />
        </FieldRow>
      </Section>
      {!empty && (
        <>
          <LookSection />
          <Section title="Song">
            <div className={styles.songBlock}>
              <span className={styles.icon}>
                <Music2 />
              </span>
              <div className={styles.headerText}>
                <div className={styles.lookName}>
                  {project.songAssetId ? project.assets[project.songAssetId]?.name : ''}
                </div>
                <div className={`${styles.meta} tnum`} data-testid="song-facts">
                  {facts}
                </div>
              </div>
            </div>
            <div className={styles.inlineActions}>
              <Button size="sm" variant="ghost" onClick={() => openAssist('analysis')}>
                Song analysis
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openAssist('stems')}>
                Separate stems
              </Button>
            </div>
          </Section>
        </>
      )}
      <p className={styles.hint}>Select a clip, text or lyric line to edit it.</p>
    </>
  )
}
