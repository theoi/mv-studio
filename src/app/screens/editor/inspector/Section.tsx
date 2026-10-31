import { Film } from 'lucide-react'
import { ToggleGroup } from 'radix-ui'
import type { SongSection } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Input, NumberField, Section } from '../../../ds/Fields.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatTime } from '../../../format.ts'
import { barsBetween, beatGrid } from '../../../state/beats.ts'
import {
  dispatch,
  editor,
  sectionGuess,
  sectionColor,
  sectionKind,
  sectionName,
  sectionsOf,
  sectionUnsure,
  songAnalysis,
  useProject,
  type SectionKind,
} from '../../../state/project.ts'
import { exportSectionTeaser } from '../../../state/exports.ts'
import { revealSuggestions, useFootage, useFootageResults } from '../../../state/footage.ts'
import { cutClipsToSection, moveBoundary, sectionEdge } from '../../../state/sections.ts'
import { set } from '../../../state/ui.ts'
import { InlineSuggestion } from '../Suggestion.tsx'
import { Header } from './parts.tsx'
import { ProjectInspector } from './Project.tsx'
import styles from '../Inspector.module.css'

const colorNames: Record<SectionKind, string> = {
  intro: 'Intro',
  verse: 'Verse',
  pre: 'Pre-chorus',
  chorus: 'Chorus',
  bridge: 'Bridge',
  outro: 'Outro',
}

const kinds = Object.keys(colorNames) as SectionKind[]

/** "N clips match this chorus" once footage analysis finds two or more strong matches for the section. */
function SectionMatches({ section }: { section: SongSection }) {
  const strong = useFootage((s) => s.strongMatch)
  const count = (useFootageResults('section', section.id) ?? []).filter((r) => r.score >= strong).length
  if (count < 2) return null
  // A name the user typed reads as typed ("this DJ break"); a found one reads "this verse", not "this Verse 1".
  const name = section.confidence === 1 ? section.label : section.label.replace(/\s*\d+$/, '').toLowerCase()
  return (
    <InlineSuggestion
      // Not now quiets the section wherever it repeats.
      id={section.repeatGroup === undefined ? `match-${section.id}` : `match-repeat-${section.repeatGroup}`}
      action="Show"
      onAction={() => {
        revealSuggestions()
        set({ libraryTab: 'media', libraryOpen: true })
      }}
    >
      {count} clips match this {name}.
    </InlineSuggestion>
  )
}

export function SectionInspector({ id }: { id: string }) {
  const project = useProject()
  const sec = sectionsOf(project).find((s) => s.id === id)
  const analysis = songAnalysis(project)
  if (!sec || !analysis) return <ProjectInspector />
  const bars = barsBetween(beatGrid(project), sec.start, sec.end)
  const plays =
    sec.repeatGroup === undefined
      ? 1
      : sectionsOf(project).filter((s) => s.repeatGroup === sec.repeatGroup).length
  const span = [
    `${formatTime(sec.start)} – ${formatTime(sec.end)}`,
    bars === null ? '' : `${bars} ${bars === 1 ? 'bar' : 'bars'}`,
  ]
    .filter(Boolean)
    .join(' · ')
  const guess = sectionGuess(sec)
  const update = (patch: { label?: string; color?: string }, label: string, coalesceKey?: string) =>
    dispatch(
      { type: 'analysis.updateSection', assetId: analysis.assetId, sectionId: sec.id, patch },
      { label, ...(coalesceKey ? { coalesceKey } : {}) },
    )
  const edge = (which: 'start' | 'end') => {
    const b = sectionEdge(project, sec.id, which)
    return (
      <NumberField
        value={sec[which]}
        min={b?.min}
        max={b?.max}
        step={0.1}
        precision={2}
        unit="s"
        onChange={(v) => b && moveBoundary(b, v, `inspector:${sec.id}:${which}`)}
        onCommit={() => editor.endGesture()}
        ariaLabel={which === 'start' ? 'Section start' : 'Section end'}
      />
    )
  }
  const picked = sec.color && kinds.includes(sec.color as SectionKind) ? sec.color : 'auto'
  return (
    <>
      <Header
        icon={<Film />}
        title={`Section: ${sectionName(sec)}`}
        meta={guess ?? span}
        metaBelow={guess && span}
      />
      <SectionMatches section={sec} />
      <Section title="Section">
        <FieldRow label="Name">
          <Input
            value={sec.label}
            onChange={(e) => update({ label: e.target.value }, 'Rename section', `inspector:${sec.id}:label`)}
            onBlur={() => editor.endGesture()}
            aria-label="Section name"
          />
        </FieldRow>
        <FieldRow label="Color">
          {/* Swatches that wrap: the inspector is too narrow at 1280 px for Auto and six colors in one row. */}
          <ToggleGroup.Root
            type="single"
            value={picked}
            onValueChange={(v) => v && update({ color: v === 'auto' ? '' : v }, 'Change section color')}
            aria-label="Section color"
            className={styles.swatches}
          >
            <Tooltip
              label={`Auto: ${colorNames[sectionKind(sec)]} color`}
              description="From the section's name"
            >
              <ToggleGroup.Item value="auto" className={styles.swatchAuto} aria-label="Auto">
                Auto
              </ToggleGroup.Item>
            </Tooltip>
            {kinds.map((k) => (
              <Tooltip key={k} label={`${colorNames[k]} color`}>
                <ToggleGroup.Item
                  value={k}
                  className={styles.swatchItem}
                  aria-label={`${colorNames[k]} color`}
                >
                  <span className={styles.swatch} style={{ background: sectionColor[k] }} />
                </ToggleGroup.Item>
              </Tooltip>
            ))}
          </ToggleGroup.Root>
        </FieldRow>
        <FieldRow label="Start">{edge('start')}</FieldRow>
        <FieldRow label="End">{edge('end')}</FieldRow>
        <p className={styles.note}>
          {sec.confidence === 1
            ? 'Named by you'
            : sectionUnsure(sec)
              ? 'Name guessed from the audio'
              : 'Found automatically'}
          {plays > 1 ? `, plays ${plays} times in the song` : ''}.{' '}
          {sectionUnsure(sec) ? 'Rename it if the guess is wrong. ' : ''}Drag its edges on the timeline to
          adjust; a neighbor that touches it moves too.
        </p>
      </Section>
      <Section title="Do more with this section">
        <div className={styles.stackActions}>
          <Button size="sm" variant="secondary" block onClick={() => cutClipsToSection(sec.id)}>
            Cut clips to this section…
          </Button>
          <Button size="sm" variant="ghost" block onClick={() => exportSectionTeaser(sec.id)}>
            Export as a teaser…
          </Button>
        </div>
      </Section>
    </>
  )
}
