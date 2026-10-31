import { useEffect } from 'react'
import { Check } from 'lucide-react'
import type { VisualClip } from '../../../../model/index.ts'
import { Badge } from '../../../ds/Feedback.tsx'
import { FieldRow, Section, Switch } from '../../../ds/Fields.tsx'
import {
  bringToFront,
  canTryCutout,
  checkFootage,
  hasCutout,
  putBehind,
  suitabilityOf,
  suitabilityText,
  useBehind,
} from '../../../state/behind.ts'
import { backgroundAnalysisOn } from '../../../state/footage.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { editor, useProject } from '../../../state/project.ts'
import { toast } from '../../../state/ui.ts'
import { pct, useJob } from '../assist/jobState.ts'
import { InlineSuggestion } from '../Suggestion.tsx'
import styles from '../Inspector.module.css'

type MediaClip = VisualClip & { assetId: string }

function useBehindState(clip: MediaClip) {
  const project = useProject()
  const checks = useBehind((s) => s.checks)
  const requests = useBehind((s) => s.requests)
  const { job, phase } = useJob(JOB_KINDS.cutout)
  const cutoutOf = typeof clip.meta?.behindSubjectOf === 'string' ? clip.meta.behindSubjectOf : undefined
  const hostId = cutoutOf ?? clip.id
  const suitability = suitabilityOf(project, project.clips[hostId], checks)
  const asked = !!job && !!requests[job.id]?.includes(hostId)
  return {
    hostId,
    assetId:
      project.clips[hostId] && 'assetId' in project.clips[hostId] ? project.clips[hostId].assetId : undefined,
    behind: !!cutoutOf || hasCutout(project, clip.id),
    suitability,
    cutting: asked && phase === 'running' ? job : undefined,
    failure: asked && phase === 'failed' ? job?.error?.message : undefined,
  }
}

/** Starts the cutout and says so when it lands, with Undo. */
function cutOut(hostId: string) {
  putBehind([hostId])?.promise.then(
    (result) => {
      if (result.count)
        toast('Lyrics now sit behind the person on this clip', {
          label: 'Undo',
          run: () => {
            if (editor.undoLabel() === result.label) editor.undo()
            else toast('The project has changed since. Use Undo in the top bar to step back.')
          },
        })
    },
    () => undefined,
  )
}

/** Offers to put the lyrics behind the person when the shot has one and they are not behind yet. */
export function BehindSuggestion({ clip }: { clip: MediaClip }) {
  const { hostId, behind, suitability, cutting } = useBehindState(clip)
  const known = suitability.status === 'checked' && suitability.verdict !== 'unsuitable'
  if (!known || behind || cutting) return null
  return (
    <InlineSuggestion
      id={`behind-${clip.assetId}`}
      action="Put lyrics behind"
      onAction={() => cutOut(hostId)}
    >
      There’s a person in this shot. Put the lyrics behind them?
    </InlineSuggestion>
  )
}

export function LayeringSection({ clip }: { clip: MediaClip }) {
  const { hostId, assetId, behind, suitability, cutting, failure } = useBehindState(clip)
  const text = suitabilityText(suitability)
  const unchecked = suitability.status === 'unchecked'
  useEffect(() => {
    if (unchecked && assetId && backgroundAnalysisOn()) checkFootage([assetId])
  }, [unchecked, assetId])
  return (
    <Section title="Layering" defaultOpen={behind}>
      <FieldRow label="Behind subject" wideLabel trailing={<span className={styles.trailSpacer} />}>
        <Switch
          checked={behind || !!cutting}
          onCheckedChange={(on) => (on ? cutOut(hostId) : bringToFront([hostId]))}
          disabled={!!cutting || (!behind && !canTryCutout(suitability))}
          ariaLabel="Put text and effects behind the subject"
        />
        {cutting ? (
          <Badge tone="accent">Cutting out… {pct(cutting)}%</Badge>
        ) : behind ? (
          <Badge tone="success" icon={<Check />}>
            Person found
          </Badge>
        ) : suitability.status === 'checking' ? (
          <Badge>{text.status}</Badge>
        ) : null}
      </FieldRow>
      {failure ? (
        <p className={styles.note} role="alert">
          {failure} Your project is unchanged. Turn it on again to retry.
        </p>
      ) : (
        !behind && text.why && <p className={styles.note}>{text.why}</p>
      )}
    </Section>
  )
}
