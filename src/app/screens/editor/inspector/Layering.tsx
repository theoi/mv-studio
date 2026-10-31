import { useEffect } from 'react'
import { Check, Crosshair, MousePointerClick } from 'lucide-react'
import type { VisualClip } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { FieldRow, Section, Switch } from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import {
  bringToFront,
  canTryCutout,
  checkFootage,
  cutoutsOf,
  hasCutout,
  objectOf,
  putBehind,
  suitabilityOf,
  suitabilityText,
  useBehind,
  type ObjectPick,
  type VideoClip,
} from '../../../state/behind.ts'
import { fixObject, pickObject, timelineTimeOf, trackingText } from '../../../state/behindObject.ts'
import { backgroundAnalysisOn } from '../../../state/footage.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { editor, useProject } from '../../../state/project.ts'
import { toast } from '../../../state/ui.ts'
import { pct, useJob } from '../assist/jobState.ts'
import { InlineSuggestion } from '../Suggestion.tsx'
import styles from '../Inspector.module.css'

type MediaClip = VisualClip & { assetId: string }

/** Lost spots offered as "Fix at" buttons; more are fixed by re-running from the next one. */
const MAX_FIXES = 3

function useBehindState(clip: MediaClip) {
  const project = useProject()
  const checks = useBehind((s) => s.checks)
  const requests = useBehind((s) => s.requests)
  const { job, phase } = useJob(JOB_KINDS.cutout)
  const cutoutOf = typeof clip.meta?.behindSubjectOf === 'string' ? clip.meta.behindSubjectOf : undefined
  const hostId = cutoutOf ?? clip.id
  const host = project.clips[hostId]
  const suitability = suitabilityOf(project, host, checks)
  const request = job ? requests[job.id] : undefined
  const asked = !!request?.clips.includes(hostId)
  return {
    hostId,
    host: host?.type === 'video' ? host : undefined,
    assetId: host && 'assetId' in host ? host.assetId : undefined,
    behind: !!cutoutOf || hasCutout(project, clip.id),
    object: objectOf(cutoutsOf(project, hostId)[0]),
    suitability,
    busy: phase === 'running',
    cutting: asked && phase === 'running' ? job : undefined,
    failure: asked && phase === 'failed' ? job?.error?.message : undefined,
    objectFailure: !!request?.object,
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

/** How well the picked object was followed, with a button for each spot where it was lost. */
function ObjectTracking({ host, pick, disabled }: { host: VideoClip; pick: ObjectPick; disabled: boolean }) {
  const fixes = pick.fix.slice(0, MAX_FIXES)
  // formatTime floors the tenths, so 11.2 computed as 11.1999… would read 0:11.1.
  const timeLabel = (t: number) => formatTime(timelineTimeOf(host, t) + 1e-6, true)
  return (
    <>
      <p className={styles.note}>
        {trackingText(pick)}
        {pick.fix.length ? ' Click the object there to fix it.' : ''}
      </p>
      {fixes.length > 0 && (
        <div className={styles.inlineActions}>
          {fixes.map((t) => (
            <Button
              key={t}
              size="sm"
              variant="ghost"
              icon={<Crosshair />}
              disabled={disabled}
              onClick={() => fixObject(host.id, t)}
            >
              Fix at {timeLabel(t)}
            </Button>
          ))}
        </div>
      )}
    </>
  )
}

export function LayeringSection({ clip }: { clip: MediaClip }) {
  const { hostId, host, assetId, behind, object, suitability, busy, cutting, failure, objectFailure } =
    useBehindState(clip)
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
            {object ? 'Object picked' : 'Person found'}
          </Badge>
        ) : suitability.status === 'checking' ? (
          <Badge>{text.status}</Badge>
        ) : null}
      </FieldRow>
      {failure ? (
        <p className={styles.note} role="alert">
          {failure} Your project is unchanged.{' '}
          {objectFailure ? 'Pick the object again to retry.' : 'Turn it on again to retry.'}
        </p>
      ) : behind && object && host ? (
        <ObjectTracking host={host} pick={object} disabled={busy} />
      ) : (
        !behind && text.why && <p className={styles.note}>{text.why}</p>
      )}
      {host && (
        <div className={styles.inlineActions}>
          <Button
            size="sm"
            variant="ghost"
            icon={<MousePointerClick />}
            disabled={busy}
            onClick={() => pickObject(hostId)}
          >
            Pick another object in the preview
          </Button>
        </div>
      )}
    </Section>
  )
}
