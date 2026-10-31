import { Film } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Input, Section } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import {
  bpmOf,
  dispatch,
  editor,
  sectionGuess,
  sectionName,
  sectionsOf,
  sectionUnsure,
  songAnalysis,
  useProject,
} from '../../../state/project.ts'
import { exportSectionTeaser } from '../../../state/exports.ts'
import { openAssist } from '../../../state/ui.ts'
import { Header } from './parts.tsx'
import { ProjectInspector } from './Project.tsx'
import styles from '../Inspector.module.css'

export function SectionInspector({ id }: { id: string }) {
  const project = useProject()
  const sec = sectionsOf(project).find((s) => s.id === id)
  const analysis = songAnalysis(project)
  if (!sec || !analysis) return <ProjectInspector />
  const bpm = bpmOf(project)
  const bars = bpm && Math.round((sec.end - sec.start) / ((60 / bpm) * 4))
  const plays =
    sec.repeatGroup === undefined
      ? 1
      : sectionsOf(project).filter((s) => s.repeatGroup === sec.repeatGroup).length
  const span = [`${formatTime(sec.start)} – ${formatTime(sec.end)}`, bars && `${bars} bars`]
    .filter(Boolean)
    .join(' · ')
  const guess = sectionGuess(sec)
  return (
    <>
      <Header
        icon={<Film />}
        title={`Section: ${sectionName(sec)}`}
        meta={guess ?? span}
        metaBelow={guess && span}
      />
      <Section title="Section">
        <FieldRow label="Name">
          <Input
            value={sec.label}
            onChange={(e) =>
              dispatch(
                {
                  type: 'analysis.updateSection',
                  assetId: analysis.assetId,
                  sectionId: sec.id,
                  patch: { label: e.target.value },
                },
                { coalesceKey: `inspector:${sec.id}:label`, label: 'Rename section' },
              )
            }
            onBlur={() => editor.endGesture()}
            aria-label="Section name"
          />
        </FieldRow>
        <p className={styles.note}>
          {sec.confidence === 1
            ? 'Named by you'
            : sectionUnsure(sec)
              ? 'Name guessed from the audio'
              : 'Found automatically'}
          {plays > 1 ? `, plays ${plays} times in the song` : ''}.{' '}
          {sectionUnsure(sec) ? 'Rename it if the guess is wrong. ' : ''}Drag its edges on the timeline to
          adjust.
        </p>
      </Section>
      <Section title="Do more with this section">
        <div className={styles.stackActions}>
          <Button size="sm" variant="secondary" block onClick={() => openAssist('autocut')}>
            Cut clips to this section
          </Button>
          <Button size="sm" variant="ghost" block onClick={() => exportSectionTeaser(sec.id)}>
            Export as a teaser
          </Button>
        </div>
      </Section>
    </>
  )
}
