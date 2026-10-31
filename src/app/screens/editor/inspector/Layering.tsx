import { Check, MousePointerClick } from 'lucide-react'
import type { Project, VisualClip } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { FieldRow, Section, Switch } from '../../../ds/Fields.tsx'
import { bringToFront, canCutOut, hasCutout, putBehind } from '../../../state/behind.ts'
import { undo, useProject } from '../../../state/project.ts'
import { toast } from '../../../state/ui.ts'
import { InlineSuggestion } from '../Suggestion.tsx'
import styles from '../Inspector.module.css'

type MediaClip = VisualClip & { assetId: string }

function behindState(project: Project, clip: MediaClip) {
  const cutoutOf = typeof clip.meta?.behindSubjectOf === 'string' ? clip.meta.behindSubjectOf : undefined
  return {
    behind: !!cutoutOf || hasCutout(project, clip.id),
    cutOut: canCutOut(project, clip),
    setBehind: (on: boolean) => {
      if (on) return putBehind([clip.id]) > 0
      return bringToFront([cutoutOf ?? clip.id])
    },
  }
}

/** Offers to put the lyrics behind the person when the clip has one and they are not behind yet. */
export function BehindSuggestion({ clip }: { clip: MediaClip }) {
  const { behind, cutOut, setBehind } = behindState(useProject(), clip)
  if (!cutOut || behind) return null
  return (
    <InlineSuggestion
      id={`behind-${clip.assetId}`}
      action="Put lyrics behind"
      onAction={() => {
        if (setBehind(true))
          toast('Lyrics now sit behind the singer on this clip', { label: 'Undo', run: undo })
      }}
    >
      The singer fills this shot. Put the lyrics behind them?
    </InlineSuggestion>
  )
}

export function LayeringSection({ clip }: { clip: MediaClip }) {
  const { behind, cutOut, setBehind } = behindState(useProject(), clip)
  return (
    <Section title="Layering" defaultOpen={behind}>
      <FieldRow label="Behind subject" wideLabel trailing={<span className={styles.trailSpacer} />}>
        <Switch
          checked={behind}
          onCheckedChange={setBehind}
          disabled={!cutOut && !behind}
          ariaLabel="Put text and effects behind the subject"
        />
        {behind && (
          <Badge tone="success" icon={<Check />}>
            Person found
          </Badge>
        )}
      </FieldRow>
      <div className={styles.inlineActions}>
        <Button size="sm" variant="ghost" icon={<MousePointerClick />}>
          Pick another object in the preview
        </Button>
      </div>
    </Section>
  )
}
