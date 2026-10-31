import { useId, useState, type ReactNode, type RefObject } from 'react'
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Clock,
  Cpu,
  EyeOff,
  Info,
  KeyRound,
  Lock,
  RotateCcw,
  Shuffle,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { isLocalEndpoint } from '../../../../cloud/llm/presets.ts'
import { formatEstimate } from '../../../../cloud/pricing.ts'
import type { DirectorState, GeneratedUnit, PlanCost, PlanDescription } from '../../../../director/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Dialog } from '../../../ds/Dialog.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, TextArea } from '../../../ds/Fields.tsx'
import { plural } from '../../../format.ts'
import { llmLabel, useCloud } from '../../../state/cloud.ts'
import {
  applyDraft,
  backToPlan,
  directorRequest,
  draftLocally,
  draftProgress,
  draftVideo,
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
import { pct, useFocusAfterCancel } from './jobState.ts'
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

const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** Ends a sentence that came from elsewhere (an error message) so the next one doesn't run into it. */
function sentence(text: string): string {
  const t = text.trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

function Notes({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return (
    <ul className={styles.tips}>
      {warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
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
          Estimates from fal.ai’s prices on {paid.pricesCheckedOn}. {capitalized(unit)}s already made are kept
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

function ReadyView({
  state,
  actionRef,
}: {
  state: StateOf<'ready'>
  /** The Generate button, which takes focus after a Cancel. */
  actionRef: RefObject<HTMLButtonElement | null>
}) {
  const description = useDirector((s) => s.description)
  const stoppedId = useId()
  const cost = paidCost(state.cost)
  const spend = useSpend(state.cost, state.confirmRequired, state.actionLabel, state.unit)
  return (
    <ToolView
      title="Director"
      subtitle={cost ? 'Plan ready · check the cost' : 'Plan ready'}
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
            onClick={spend.start}
            // Focus lands here after a Cancel; screen readers then read the note that says what was kept.
            aria-describedby={state.stopped ? stoppedId : undefined}
          >
            {state.actionLabel}
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
          {cost && (
            <div className={styles.costLine}>
              <Info /> Charged by fal.ai to your key&nbsp;· prices checked {cost.pricesCheckedOn}
            </div>
          )}
        </>
      }
    >
      <p className={styles.lede}>{state.preview.summary}</p>
      <Notes warnings={state.preview.warnings} />
      <PlanList description={description} />
      <div className={styles.rowActions}>
        <Button size="sm" variant="ghost" onClick={resetDirector}>
          Start over
        </Button>
      </div>
      {spend.dialog}
    </ToolView>
  )
}

function GeneratingView({ state, onCancel }: { state: StateOf<'generating'>; onCancel: () => void }) {
  const job = useJobs().find((j) => j.id === state.jobId)
  const notice = useDirector((s) => s.cancelNotice)
  const { unit, failed, stopping } = state
  return (
    <ToolView
      title="Director"
      subtitle={
        stopping
          ? 'Stopping…'
          : `Generating ${unit} ${Math.min(state.done + 1, state.total)} of ${state.total}`
      }
      footer={<CancelButton job={job} disabled={Boolean(stopping)} onCancel={onCancel} />}
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
      {failed > 0 && (
        <div className={styles.callout}>
          <AlertTriangle />
          <div>
            {plural(failed, unit)} couldn’t be generated. The others go on, and you can retry{' '}
            {failed === 1 ? 'it' : 'them'} when they’re done.
          </div>
        </div>
      )}
      {/* Once the Cancel is taken, the card says what is kept. */}
      {!stopping && (
        <p className={styles.muted}>
          {notice} {capitalized(unit)}s already made are kept.
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

function DoneView({ state }: { state: StateOf<'applied'> }) {
  const description = useDirector((s) => s.description)
  const builtIn = !llmLabel(useCloud().llm)
  const [refine, setRefine] = useState('')
  const retryCost = paidCost(state.cost)
  const retryLabel = `Retry ${plural(state.failedShots, `failed ${state.unit}`)}${retryCost ? ` · ${formatEstimate(retryCost)}` : ''}`
  const spend = useSpend(state.cost, state.confirmRequired, retryLabel, state.unit)
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
      <Notes warnings={state.warnings} />
      {state.failedShots > 0 && (
        <div className={styles.rowActions}>
          <Button
            size="sm"
            variant="subtle"
            icon={<RotateCcw />}
            onClick={spend.start}
            title={state.failedReason}
          >
            {retryLabel}
          </Button>
        </div>
      )}
      <HiddenTracks ids={state.hiddenTracks} />
      <PlanList description={description} />
      <Field
        label="Refine the draft"
        hint={
          builtIn
            ? 'The built-in planner takes the look and mood from your words. Connect a language model in Settings for changes like this.'
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
          <Button size="sm" variant="subtle" icon={<Shuffle />} onClick={() => void tryAnotherVersion()}>
            Try another version
          </Button>
        </div>
      )}
      {spend.dialog}
    </ToolView>
  )
}

function ErrorView({ state }: { state: StateOf<'error'> }) {
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
          <Button variant="primary" icon={<RotateCcw />} className={styles.grow} onClick={retry}>
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
  const focus = useFocusAfterCancel(state.status === 'generating')
  switch (state.status) {
    case 'planning':
      return <PlanningView state={state} />
    case 'ready':
      return applying ? <PlanningView state={state} /> : <ReadyView state={state} actionRef={focus.target} />
    case 'generating':
      return <GeneratingView state={state} onCancel={focus.cancelled} />
    case 'applied':
      return <DoneView state={state} />
    case 'error':
      return <ErrorView state={state} />
    default:
      return <IdleView />
  }
}
