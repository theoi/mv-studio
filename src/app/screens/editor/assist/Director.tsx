import { useId, useState, type ReactNode, type RefObject } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Clock,
  Cpu,
  EyeOff,
  Film,
  Info,
  KeyRound,
  Lock,
  RotateCcw,
  Shuffle,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { isLocalEndpoint } from '../../../../cloud/llm/presets.ts'
import { formatEstimate, formatUsd } from '../../../../cloud/pricing.ts'
import type {
  DirectorRequest,
  DirectorState,
  GeneratedUnit,
  PlanCost,
  PlanDescription,
  ShotStatus,
} from '../../../../director/index.ts'
import { NO_AI_SHOTS } from '../../../../director/notes.ts'
import { Button } from '../../../ds/Button.tsx'
import { Dialog } from '../../../ds/Dialog.tsx'
import { Badge, Spinner } from '../../../ds/Feedback.tsx'
import { Segmented, TextArea } from '../../../ds/Fields.tsx'
import { capitalize, plural } from '../../../format.ts'
import { llmLabel, useCloud } from '../../../state/cloud.ts'
import {
  applyDraft,
  backToPlan,
  clipsNoun,
  clipsSinceDraft,
  directorRequest,
  draftLocally,
  draftProgress,
  draftVideo,
  draftWithAiShots,
  paidCost,
  resetDirector,
  showTracks,
  tryAnotherVersion,
  undoDraft,
  useDirector,
  type AiShots,
  type ShotSource,
} from '../../../state/director.ts'
import { useJobs } from '../../../state/jobs.ts'
import { sectionName, sectionsOf, useProject } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import { pct, useKeepFocus } from './jobState.ts'
import { CancelButton, Elapsed, Field, RunCard, Steps, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

type StateOf<S extends DirectorState['status']> = Extract<DirectorState, { status: S }>

/** Status on the Director row of Assist's tool list. */
export function DirectorBadge() {
  const state = useDirector((s) => s.state)
  const list = useJobs()
  if (state.status === 'planning' || state.status === 'generating')
    return <Badge tone="accent">{pct(list.find((j) => j.id === state.jobId))}%</Badge>
  if (state.status === 'ready' && paidCost(state.cost)) return <Badge tone="accent">Plan ready</Badge>
  if (state.status === 'applied') return <Badge tone="success">Done</Badge>
  if (state.status === 'error') return <Badge tone="danger">Failed</Badge>
  return null
}

/**
 * A button label that ends in its price ("Generate 12 clips · about $3.38", with the button's `pricedButton` class).
 * In a panel too narrow for one line the price goes on a line of its own, so it always shows in full.
 */
function PricedLabel({ label }: { label: string }) {
  const at = label.lastIndexOf(' · ')
  if (at < 0) return label
  return (
    <>
      <span className={styles.nowrap}>{label.slice(0, at)}</span>
      <span className={styles.priceSep}> ·</span> <span className={styles.price}>{label.slice(at + 3)}</span>
    </>
  )
}

/** Ends a sentence that came from elsewhere (an error message) so the next one doesn't run into it. */
function sentence(text: string): string {
  const t = text.trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

function Notes({
  warnings,
  request,
  onRedraft,
}: {
  warnings: string[]
  request: DirectorRequest
  onRedraft: () => void
}) {
  // The draft was made without fal.ai, or with My clips. Once fal.ai is connected, the next step is drafting with AI shots.
  const offerAi = Boolean(useCloud().falKey) && warnings.includes(NO_AI_SHOTS)
  const shown = offerAi ? warnings.filter((w) => w !== NO_AI_SHOTS) : warnings
  return (
    <>
      {shown.length > 0 && (
        <ul className={styles.tips}>
          {shown.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {offerAi && (
        <div className={styles.callout}>
          <Sparkles />
          <div>
            <div>
              This draft uses your media or visuals. With fal.ai connected, the director can add AI shots.
            </div>
            <Button
              size="sm"
              variant="ghost"
              className={styles.calloutBtn}
              onClick={() => {
                onRedraft()
                draftWithAiShots(request)
              }}
            >
              Draft again with AI shots
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

/** Clips imported after a draft that uses the user's media: drafting again puts them in. */
function NewClips({ onRedraft }: { onRedraft: () => void }) {
  const state = useDirector((s) => s.state)
  const clipsAtDraft = useDirector((s) => s.clipsAtDraft)
  const added = clipsSinceDraft(useProject(), { state, clipsAtDraft })
  if (state.status !== 'applied' || !added.length) return null
  const { request } = state
  return (
    <div className={styles.callout}>
      <Film />
      <div>
        <div>
          {clipsNoun(added)} added after this draft. Draft again to use {added.length === 1 ? 'it' : 'them'}.
        </div>
        <Button
          size="sm"
          variant="ghost"
          className={styles.calloutBtn}
          onClick={() => {
            onRedraft()
            void draftVideo(request)
          }}
        >
          Draft again
        </Button>
      </div>
    </div>
  )
}

function PlanList({ description }: { description: PlanDescription | null }) {
  const sections = sectionsOf(useProject())
  if (!description?.sections.length) return null
  return (
    <>
      <div className={styles.groupLabelInset}>The plan</div>
      <ol className={styles.plan}>
        {description.sections.map((s) => {
          const section = sections.find((x) => x.id === s.id)
          return (
            <li key={s.id}>
              <span className={styles.planSection}>{section ? sectionName(section) : 'Section'}</span>
              <span className={styles.planDesc}>{s.text}</span>
            </li>
          )
        })}
      </ol>
    </>
  )
}

/**
 * Starts paid generation: straight away when the spend policy allows it, else after the confirm dialog. The
 * returned dialog must be rendered by the caller.
 */
function useSpend(cost: PlanCost | null, confirmRequired: boolean, actionLabel: string, unit: GeneratedUnit) {
  const [confirming, setConfirming] = useState(false)
  const paid = paidCost(cost)
  const start = () => (paid && confirmRequired ? setConfirming(true) : void applyDraft())
  const dialog = paid ? (
    <Dialog
      open={confirming}
      onOpenChange={setConfirming}
      title={`Generate ${plural(paid.count, unit)}?`}
      description={`Costs ${formatEstimate(paid)}, charged by fal.ai to your key.`}
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirming(false)
              void applyDraft({ confirmSpend: true })
            }}
          >
            {actionLabel}
          </Button>
        </>
      }
    >
      <div className={styles.viewBody}>
        <ul className={styles.tips}>
          {paid.byModel.map((m) => (
            <li key={`${m.kind}:${m.name}`}>
              {plural(m.count, m.kind)}
              {m.seconds ? `, ${Math.round(m.seconds)} s in all,` : ''} with {m.name}
              {/* With one model its price is the total, already in the description and on the button. */}
              {paid.byModel.length > 1 && ` · ${formatEstimate(m)}`}
            </li>
          ))}
        </ul>
        <p className={styles.muted}>
          Estimates from fal.ai’s prices on {paid.pricesCheckedOn}. {capitalize(unit)}s already made are kept
          if you cancel.
        </p>
      </div>
    </Dialog>
  ) : null
  return { start, dialog }
}

function IdleView() {
  const idea = useDirector((s) => s.idea)
  const shots = useDirector((s) => s.shots)
  const aiShots = useDirector((s) => s.aiShots)
  const cloud = useCloud()
  const planner = llmLabel(cloud.llm)
  const needsKey = shots !== 'mine' && !cloud.falKey
  const local = !cloud.llm || !planner || isLocalEndpoint(cloud.llm)
  let costLine: ReactNode
  if (needsKey)
    costLine = (
      <>
        <KeyRound /> Connect fal.ai to use AI shots, or choose My clips
      </>
    )
  else if (shots !== 'mine')
    costLine = (
      <>
        <Info />{' '}
        {aiShots === 'video'
          ? 'Free to plan. Video clips cost more and show their price before anything is generated'
          : 'Free to plan. AI shots show their price before anything is generated'}
      </>
    )
  else if (local)
    costLine = (
      <>
        <Lock /> Runs on this device with your clips&nbsp;·&nbsp;free
      </>
    )
  else
    costLine = (
      <>
        <Info /> Your clips&nbsp;· the plan is written by {planner}, billed to your key
      </>
    )
  return (
    <ToolView
      title="Director"
      subtitle="Drafts a complete, editable video"
      footer={
        <>
          <Button
            variant="primary"
            block
            icon={<Clapperboard />}
            disabled={needsKey}
            onClick={() => void draftVideo(directorRequest(idea, shots, aiShots))}
          >
            Draft video
          </Button>
          <div className={styles.costLine}>{costLine}</div>
        </>
      }
    >
      <Field label="Idea" hint="Optional. Without one, the director follows the song’s mood and your clips.">
        <TextArea
          rows={3}
          value={idea}
          onChange={(e) => useDirector.setState({ idea: e.target.value })}
          placeholder="For example: a dreamy night drive through a neon city that ends at sunrise"
          aria-label="Idea for the video"
        />
      </Field>
      <Field label="Shots">
        <Segmented<ShotSource>
          block
          value={shots}
          onChange={(value) => useDirector.setState({ shots: value })}
          ariaLabel="Where shots come from"
          options={[
            { value: 'mine', label: 'My clips' },
            { value: 'mix', label: 'Mix' },
            { value: 'gen', label: 'Generate' },
          ]}
        />
      </Field>
      {shots !== 'mine' && (
        <Field
          label="AI shots"
          hint={
            aiShots === 'video'
              ? 'Clips with real motion. Each takes a few minutes to make.'
              : 'Stills the director moves with the music. Costs the least.'
          }
        >
          <Segmented<AiShots>
            block
            value={aiShots}
            onChange={(value) => useDirector.setState({ aiShots: value })}
            ariaLabel="What AI shots are"
            options={[
              { value: 'images', label: 'Images' },
              { value: 'video', label: 'Video clips' },
            ]}
          />
        </Field>
      )}
      {needsKey && (
        <div className={styles.callout}>
          <KeyRound />
          <div>
            <div>Generating shots needs a fal.ai key.</div>
            <Button
              size="sm"
              variant="ghost"
              className={styles.calloutBtn}
              onClick={() => set({ dialog: 'settings', settingsPage: 'ai' })}
            >
              Connect fal.ai
            </Button>
          </div>
        </div>
      )}
      <Field label="Planner">
        <div className={styles.plannerRow}>
          <Cpu />
          <span>
            {planner
              ? `${planner} writes the creative plan`
              : 'The built-in planner writes the plan. Connect a language model in Settings for richer plans.'}
          </span>
        </div>
      </Field>
    </ToolView>
  )
}

const STEPS = ['Read the song and your clips', 'Write the creative plan', 'Place shots, lyrics and looks']

function PlanningView({ state }: { state: StateOf<'planning'> | StateOf<'ready'> }) {
  const list = useJobs()
  const llm = useCloud().llm
  const lastJob = useDirector((s) => s.planJobId)
  const planning = state.status === 'planning' ? state : undefined
  const job = list.find((j) => j.id === (planning ? planning.jobId : lastJob))
  const stage = job?.progress.stage
  const active = !planning ? 2 : stage === 'plan' || stage === 'llm' ? 1 : 0
  return (
    <ToolView title="Director" subtitle="Drafting your video" footer={<CancelButton job={job} />}>
      <RunCard job={draftProgress(job, list)} label="Drafting progress" />
      <Steps steps={STEPS} active={active} />
      {planning?.slow && (
        <div className={styles.callout}>
          <Clock />
          <div>
            <div>
              Still working… <Elapsed since={planning.startedAt} />
            </div>
            <div className={styles.muted}>
              {planning.stage === 'plan' && llm && isLocalEndpoint(llm)
                ? 'Models on this computer can take a few minutes, the first time especially.'
                : 'This is taking longer than usual.'}
            </div>
            {planning.canUseLocal && (
              <Button
                size="sm"
                variant="ghost"
                className={styles.calloutBtn}
                onClick={() => void draftLocally()}
              >
                Use the local draft instead
              </Button>
            )}
          </div>
        </div>
      )}
      <p className={styles.muted}>
        You can keep editing while this runs. Nothing changes on the timeline until the draft is ready.
      </p>
    </ToolView>
  )
}

/** `actionRef` is the view's main action, which takes focus after a Cancel or a redraft; `onRedraft` keeps it. */
interface FocusProps {
  actionRef: RefObject<HTMLButtonElement | null>
  onRedraft: () => void
}

function ReadyView({ state, actionRef, onRedraft }: { state: StateOf<'ready'> } & FocusProps) {
  const description = useDirector((s) => s.description)
  const stoppedId = useId()
  const cost = paidCost(state.cost)
  const spend = useSpend(state.cost, state.confirmRequired, state.actionLabel, state.unit)
  const charged = cost && (
    <>
      <Info /> Charged by fal.ai to your&nbsp;key&nbsp;· prices checked {cost.pricesCheckedOn}
    </>
  )
  return (
    <ToolView
      title="Director"
      subtitle={cost ? 'Plan ready · check the cost' : 'Plan ready'}
      // After a Cancel, the note saying what was kept and the button it describes stay in view together.
      pinFooter={Boolean(state.stopped)}
      footer={
        <>
          {/* Above the button that takes focus after a Cancel, so the two always show together. */}
          {state.stopped && (
            <p id={stoppedId} className={styles.footerNote}>
              {state.stopped}
            </p>
          )}
          <Button
            ref={actionRef}
            variant="primary"
            block
            icon={cost ? <Sparkles /> : <Clapperboard />}
            className={styles.pricedButton}
            onClick={spend.start}
            // Focus lands here after a Cancel; screen readers then read the note that says what was kept.
            aria-describedby={state.stopped ? stoppedId : undefined}
          >
            <PricedLabel label={state.actionLabel} />
          </Button>
          {cost && (
            <Button
              variant="ghost"
              size="sm"
              block
              className={styles.footerAlt}
              onClick={() => void applyDraft({ skipGeneration: true })}
            >
              Apply without AI {state.unit}s
            </Button>
          )}
          {charged && <div className={`${styles.costLine} ${styles.footerCost}`}>{charged}</div>}
        </>
      }
    >
      <p className={styles.lede}>{state.preview.summary}</p>
      <Notes warnings={state.preview.warnings} request={state.request} onRedraft={onRedraft} />
      <PlanList description={description} />
      {charged && <p className={`${styles.costLine} ${styles.bodyCost}`}>{charged}</p>}
      <div className={styles.rowActions}>
        <Button size="sm" variant="ghost" onClick={resetDirector}>
          Start over
        </Button>
      </div>
      {spend.dialog}
    </ToolView>
  )
}

const SHOT_STATE_TEXT: Record<ShotStatus['state'], string> = {
  waiting: 'Waiting',
  sending: 'Sending',
  queued: 'In line',
  generating: 'Generating',
  downloading: 'Downloading',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

function shotStatusText(s: ShotStatus): string {
  if (s.state === 'queued' && s.ahead !== undefined)
    return s.ahead === 0 ? 'Next in line' : `In line · ${s.ahead} ahead`
  if (s.state === 'generating') return `Generating · ${Math.round((s.fraction ?? 0) * 100)}%`
  return SHOT_STATE_TEXT[s.state]
}

const UNDERWAY: ReadonlySet<ShotStatus['state']> = new Set(['sending', 'queued', 'generating', 'downloading'])

/**
 * Each shot underway (its place in fal.ai's line, or its progress; at most one per request in flight), then one row
 * for all that failed, which opens to say why. The card above counts the rest: a row for every shot would push
 * Cancel out of a 720 px window.
 */
function ShotList({ shots, unit }: { shots: ShotStatus[]; unit: GeneratedUnit }) {
  const underway = shots.filter((s) => UNDERWAY.has(s.state))
  const failed = shots.filter((s) => s.state === 'failed')
  if (!underway.length && !failed.length) return null
  return (
    <div className={styles.shots}>
      {underway.length > 0 && (
        <ul className={styles.shotList} aria-label={`${capitalize(unit)}s underway`}>
          {underway.map((s) => (
            <li key={s.shotId} className={styles.shotRow}>
              <span className={styles.shotMark}>
                <Spinner size={11} />
              </span>
              <span className={styles.shotLabel}>{s.label}</span>{' '}
              <span className={`${styles.shotState} tnum`}>{shotStatusText(s)}</span>
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && <FailedShots failed={failed} />}
    </div>
  )
}

/**
 * The failed shots' row: a button that shows why they failed, each reason once with the shots it stopped, so the
 * reasons reach keyboard, touch and screen-reader users too.
 */
function FailedShots({ failed }: { failed: ShotStatus[] }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const byReason = new Map<string, string[]>()
  for (const s of failed) {
    const reason = s.reason ?? 'No reason given'
    const labels = byReason.get(reason)
    if (labels) labels.push(s.label)
    else byReason.set(reason, [s.label])
  }
  return (
    <>
      <button
        type="button"
        className={`${styles.shotRow} ${styles.shotFailed} ${styles.shotToggle}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.shotMark}>
          <AlertTriangle />
        </span>
        <span className={styles.failText}>
          {/* The no-break space keeps the "·" off the start of a wrapped line. */}
          <span className={`${styles.shotState} tnum`}>{failed.length} failed</span>
          {'\u00a0· retry when the run ends'}
        </span>
        <span className={`${styles.shotMark} ${styles.shotChevron}`}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </span>
      </button>
      {open && (
        <ul id={id} className={styles.failReasons}>
          {[...byReason].map(([reason, labels]) => (
            <li key={reason}>
              {reason}
              <span className={styles.muted}>{labels.join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * "Spent about $0.51 of an estimated $3.38": what fal.ai has billed in this run, against its estimate. One line in
 * the narrowest panel, so Cancel stays in view at 1280×720.
 */
function SpentSoFar({ spentUsd, usd }: { spentUsd: number; usd: number }) {
  const estimate = formatUsd(usd)
  return (
    <p className={`${styles.muted} tnum`}>
      Spent {spentUsd > 0 ? formatEstimate({ usd: spentUsd }) : formatUsd(0)} of{' '}
      <span className={styles.nowrap}>
        {estimate.startsWith('under') ? estimate : `an estimated ${estimate}`}
      </span>
    </p>
  )
}

function GeneratingView({ state, onCancel }: { state: StateOf<'generating'>; onCancel: () => void }) {
  const job = useJobs().find((j) => j.id === state.jobId)
  const notice = useDirector((s) => s.cancelNotice)
  const { unit, stopping } = state
  return (
    <ToolView
      title="Director"
      subtitle={stopping ? 'Stopping…' : `Generating the AI ${unit}s`}
      footer={<CancelButton job={job} disabled={Boolean(stopping)} onCancel={onCancel} />}
      pinFooter
    >
      <RunCard
        job={job}
        label={`Generating ${unit}s`}
        note={
          stopping?.keeping
            ? `Keeping ${plural(stopping.keeping, unit).replace(' ', '\u00a0')} that ${stopping.keeping === 1 ? 'is' : 'are'} downloading`
            : undefined
        }
      />
      <div>
        <SpentSoFar spentUsd={state.spentUsd} usd={state.usd} />
        {/* Once the Cancel is taken, the card says what is kept. */}
        {!stopping && <ShotList shots={state.shots} unit={unit} />}
      </div>
      {!stopping && (
        <p className={styles.muted}>
          {notice} {capitalize(unit)}s already made are kept.
        </p>
      )}
    </ToolView>
  )
}

function HiddenTracks({ ids }: { ids: string[] }) {
  const tracks = useProject().tracks
  const hidden = ids.filter((id) => tracks.find((t) => t.id === id)?.hidden)
  if (!hidden.length) return null
  return (
    <div className={styles.callout}>
      <EyeOff />
      <div>
        <div>Your own {hidden.length === 1 ? 'track is' : 'tracks are'} kept below the draft, hidden.</div>
        <Button size="sm" variant="ghost" className={styles.calloutBtn} onClick={() => showTracks(hidden)}>
          Show {hidden.length === 1 ? 'it' : 'them'}
        </Button>
      </div>
    </div>
  )
}

function DoneView({ state, actionRef, onRedraft }: { state: StateOf<'applied'> } & FocusProps) {
  const description = useDirector((s) => s.description)
  const builtIn = !llmLabel(useCloud().llm)
  const [refine, setRefine] = useState('')
  const retryCost = paidCost(state.cost)
  const retryLabel = `Retry ${plural(state.failedShots, `failed ${state.unit}`)}${retryCost ? ` · ${formatEstimate(retryCost)}` : ''}`
  const spend = useSpend(state.cost, state.confirmRequired, retryLabel, state.unit)
  const reasonsId = useId()
  const submit = () => {
    if (!refine.trim()) return
    const prompt = [state.request.prompt, refine.trim()].filter(Boolean).join('. ')
    useDirector.setState({ idea: prompt })
    setRefine('')
    void draftVideo({ ...state.request, prompt })
  }
  return (
    <ToolView
      title="Director"
      subtitle="Draft ready"
      footer={
        <div className={styles.footerRow}>
          <Button variant="secondary" icon={<Undo2 />} onClick={() => void undoDraft()}>
            Undo draft
          </Button>
          <Button
            ref={actionRef}
            variant="primary"
            onClick={() => set({ selection: { type: 'none' }, playhead: 0, playing: true })}
            className={styles.grow}
          >
            Play the draft
          </Button>
        </div>
      }
    >
      <div className={styles.success}>
        <span className={styles.successIcon}>
          <Check />
        </span>
        <div>
          <div className={styles.successTitle}>{description?.placed ?? 'Draft placed'}</div>
          <div className={styles.muted}>
            All of it is normal content on the timeline. Change anything by hand.
          </div>
        </div>
      </div>
      <Notes warnings={state.warnings} request={state.request} onRedraft={onRedraft} />
      <NewClips onRedraft={onRedraft} />
      {state.failedShots > 0 && (
        <div>
          <div className={styles.rowActions}>
            <Button
              size="sm"
              variant="subtle"
              icon={<RotateCcw />}
              onClick={spend.start}
              aria-describedby={state.failedReasons ? reasonsId : undefined}
            >
              {retryLabel}
            </Button>
          </div>
          {state.failedReasons && (
            <ul id={reasonsId} className={styles.failReasons}>
              {state.failedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <HiddenTracks ids={state.hiddenTracks} />
      <PlanList description={description} />
      <Field
        label="Refine the draft"
        hint={
          builtIn
            ? 'The built-in planner takes the look, mood and pace from your words (“faster in the chorus”). Connect a language model in Settings for changes like this.'
            : 'Press Enter to draft again with this change.'
        }
      >
        <TextArea
          rows={2}
          value={refine}
          onChange={(e) => setRefine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="For example: fewer crowd shots, more of the singer in verse 2"
          aria-label="Refine the draft"
        />
      </Field>
      {builtIn && (
        <div className={styles.rowActions}>
          <Button
            size="sm"
            variant="subtle"
            icon={<Shuffle />}
            onClick={() => {
              onRedraft()
              void tryAnotherVersion()
            }}
          >
            Try another version
          </Button>
        </div>
      )}
      {spend.dialog}
    </ToolView>
  )
}

function ErrorView({
  state,
  actionRef,
}: {
  state: StateOf<'error'>
  actionRef: RefObject<HTMLButtonElement | null>
}) {
  const cost = paidCost(state.cost)
  const retryLabel = cost ? `Retry · ${formatEstimate(cost)}` : 'Retry'
  const spend = useSpend(state.cost, state.confirmRequired, retryLabel, state.unit)
  const retry = () => {
    if (state.plan) spend.start()
    else if (state.request) void draftVideo(state.request)
    else resetDirector()
  }
  const kept = state.generatedShots
  return (
    <ToolView
      title="Director"
      subtitle="The draft stopped"
      footer={
        <div className={styles.footerRow}>
          <Button variant="secondary" onClick={state.plan ? backToPlan : resetDirector}>
            {state.plan ? 'Back to the plan' : 'Back'}
          </Button>
          <Button
            ref={actionRef}
            variant="primary"
            icon={<RotateCcw />}
            className={styles.grow}
            onClick={retry}
          >
            {retryLabel}
          </Button>
        </div>
      }
    >
      <div className={styles.failure} role="alert">
        <span className={styles.failureIcon}>
          <AlertTriangle />
        </span>
        <div>
          <div className={styles.successTitle}>{state.title}</div>
          <div className={styles.muted}>
            {sentence(state.message)} Your project is unchanged
            {kept > 0
              ? `, and the ${plural(kept, `AI ${state.unit}`).replace(' ', '\u00a0')} made so far ${kept === 1 ? 'is' : 'are'} kept`
              : ''}
            .
          </div>
        </div>
      </div>
      {state.steps.length > 0 && (
        <>
          <div className={styles.groupLabelInset}>Things that help</div>
          <ul className={styles.tips}>
            {state.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}
      {spend.dialog}
    </ToolView>
  )
}

export function DirectorView() {
  const state = useDirector((s) => s.state)
  const applying = useDirector((s) => s.applying)
  const focus = useKeepFocus(
    state.status === 'planning' || state.status === 'generating' || (state.status === 'ready' && applying),
  )
  switch (state.status) {
    case 'planning':
      return <PlanningView state={state} />
    case 'ready':
      return applying ? (
        <PlanningView state={state} />
      ) : (
        <ReadyView state={state} actionRef={focus.target} onRedraft={focus.keep} />
      )
    case 'generating':
      return <GeneratingView state={state} onCancel={focus.keep} />
    case 'applied':
      return <DoneView state={state} actionRef={focus.target} onRedraft={focus.keep} />
    case 'error':
      return <ErrorView state={state} actionRef={focus.target} />
    default:
      return <IdleView />
  }
}
