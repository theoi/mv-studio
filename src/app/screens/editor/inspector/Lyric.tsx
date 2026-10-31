import { Check, Mic2 } from 'lucide-react'
import type { Clip, LyricLine } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { FieldRow, Input, NumberField, Section } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { dispatch, editor, lyricLines, sectionName, sectionsOf, useProject } from '../../../state/project.ts'
import { toast } from '../../../state/ui.ts'
import { LyricStyleSections } from './LyricStyle.tsx'
import { Header } from './parts.tsx'
import { ProjectInspector } from './Project.tsx'
import styles from '../Inspector.module.css'

/** A lyric line's words and timing. */
function WordsSection({ line }: { line: LyricLine }) {
  const updateLine = (patch: { text?: string; start?: number; end?: number }) =>
    dispatch(
      { type: 'lyrics.updateLine', lineId: line.id, patch },
      { coalesceKey: `inspector:${line.id}:${Object.keys(patch).join()}` },
    )
  return (
    <Section title="Words">
      <div className={styles.padded}>
        <Input
          value={line.text}
          onChange={(e) => updateLine({ text: e.target.value })}
          onBlur={() => editor.endGesture()}
          aria-label="Lyric text"
        />
        <div className={styles.timedRow}>
          <Badge tone="success" icon={<Check />}>
            {line.words.length} words timed to vocals
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => toast('Line re-timed to the vocals')}>
            Re-time line
          </Button>
        </div>
      </div>
      <FieldRow label="Start">
        <NumberField
          value={line.start ?? 0}
          onChange={(v) => updateLine({ start: v })}
          onCommit={() => editor.endGesture()}
          step={0.01}
          precision={2}
          unit="s"
          ariaLabel="Start time"
        />
      </FieldRow>
      <FieldRow label="End">
        <NumberField
          value={line.end ?? 0}
          onChange={(v) => updateLine({ end: v })}
          onCommit={() => editor.endGesture()}
          step={0.01}
          precision={2}
          unit="s"
          ariaLabel="End time"
        />
      </FieldRow>
    </Section>
  )
}

export function LyricInspector({ id }: { id: string }) {
  const project = useProject()
  const line = lyricLines(project).find((l) => l.id === id)
  const clip = Object.values(project.clips).find(
    (c): c is Extract<Clip, { type: 'text' }> => c.type === 'text' && c.lyricLineId === id,
  )
  if (!line) return <ProjectInspector />
  const sec = sectionsOf(project).find(
    (s) => line.start !== undefined && line.start >= s.start && line.start < s.end,
  )
  return (
    <>
      <Header
        icon={<Mic2 />}
        title="Lyric line"
        meta={`${sec ? sectionName(sec) : 'Lyrics'} · ${formatTime(line.start ?? 0, true)} – ${formatTime(line.end ?? 0, true)}`}
      />
      <WordsSection line={line} />
      <LyricStyleSections clip={clip} />
    </>
  )
}
