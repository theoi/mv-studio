import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Clock,
  Cpu,
  Info,
  KeyRound,
  Lock,
  RotateCcw,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { isLocalEndpoint } from '../../../../cloud/llm/presets.ts'
import { formatEstimate } from '../../../../cloud/pricing.ts'
import type { DirectorState, PlanDescription } from '../../../../director/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Dialog } from '../../../ds/Dialog.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, TextArea } from '../../../ds/Fields.tsx'
import { plural } from '../../../format.ts'
import { llmLabel, useCloud } from '../../../state/cloud.ts'
import {
  applyDraft,
  directorRequest,
  draftLocally,
  draftVideo,
  resetDirector,
  undoDraft,
  useDirector,
  type ShotSource,
} from '../../../state/director.ts'
import { useJobs } from '../../../state/jobs.ts'
import { sectionName, sectionsOf, useProject } from '../../../state/project.ts'
import { set } from '../../../state/ui.ts'
import { pct } from './jobState.ts'
import { CancelButton, Field, RunCard, Steps, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

type StateOf<S extends DirectorState['status']> = Extract<DirectorState, { status: S }>

/** Status on the Director row of Assist's tool list. */
export function DirectorBadge() {
  const state = useDirector((s) => s.state)
  const list = useJobs()
  if (state.status === 'planning' || state.status === 'generating')
    return <Badge tone="accent">{pct(list.find((j) => j.id === state.jobId))}%</Badge>
  if (state.status === 'ready' && state.cost) return <Badge tone="accent">Plan ready</Badge>
  if (state.status === 'applied') return <Badge tone="success">Done</Badge>
  if (state.status === 'error') return <Badge tone="danger">Failed</Badge>
  return null
}

/** "1:12" since `since`, ticking every second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const s = Math.max(0, Math.round((now - since) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
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

function IdleView() {
  const idea = useDirector((s) => s.idea)
  const shots = useDirector((s) => s.shots)
  const cloud = useCloud()
  const planner = llmLabel(cloud.llm)
  const needsKey = shots !== 'mine' && !cloud.falKey
  const local = !cloud.llm || !planner || isLocalEndpoint(cloud.llm)
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
            onClick={() => void draftVideo(directorRequest(idea, shots))}
          >
            Draft video
          </Button>
          <div className={styles.costLine}>
            {shots !== 'mine' ? (
              <>
                <Info /> Free to plan. AI shots show their price before anything is generated
              </>
            ) : local ? (
              <>
                <Lock /> Runs on this device with your clips · free
              </>
            ) : (
              <>
                <Info /> Your clips · the plan is written by {planner}, billed to your key
              </>
            )}
          </div>
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
  const planning = state.status === 'planning' ? state : undefined
  const job = planning ? list.find((j) => j.id === planning.jobId) : undefined
  const stage = job?.progress.stage
  const active = !planning ? 2 : stage === 'plan' || stage === 'llm' ? 1 : 0
  return (
    <ToolView title="Director" subtitle="Drafting your video" footer={<CancelButton job={job} />}>
      <RunCard job={job} label="Drafting progress" />
      <Steps steps={STEPS} active={active} />
      {planning?.slow && (
        <div className={styles.callout}>
          <Clock />
          <div>
            <div>
              Still working… <Elapsed since={planning.startedAt} />
            </div>
            <div className={styles.muted}>
              {llm && isLocalEndpoint(llm)
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

function ReadyView({ state }: { state: StateOf<'ready'> }) {
  const description = useDirector((s) => s.description)
  const [confirming, setConfirming] = useState(false)
  const cost = state.cost
  const go = () => (state.confirmRequired ? setConfirming(true) : void applyDraft())
  return (
    <ToolView
      title="Director"
      subtitle={cost ? 'Plan ready · check the cost' : 'Plan ready'}
      footer={
        <>
          <Button variant="primary" block icon={cost ? <Sparkles /> : <Clapperboard />} onClick={go}>
            {state.actionLabel}
          </Button>
          {cost && (
            <div className={styles.costLine}>
              <Info /> Charged by fal.ai to your key · prices checked {cost.pricesCheckedOn}
            </div>
          )}
        </>
      }
    >
      <p className={styles.lede}>{state.preview.summary}</p>
      <Notes warnings={state.preview.warnings} />
      <PlanList description={description} />
      <div className={styles.rowActions}>
        {cost && (
          <Button size="sm" variant="subtle" onClick={() => void applyDraft({ skipGeneration: true })}>
            Apply without AI shots
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={resetDirector}>
          Start over
        </Button>
      </div>
      {cost && (
        <Dialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Generate ${plural(cost.count, 'shot')}?`}
          description={`Costs ${formatEstimate(cost)}, charged by fal.ai to your key.`}
          width={440}
          footer={
            <div className={styles.footerRow}>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                className={styles.grow}
                onClick={() => {
                  setConfirming(false)
                  void applyDraft({ confirmSpend: true })
                }}
              >
                {state.actionLabel}
              </Button>
            </div>
          }
        >
          <div className={styles.viewBody}>
            <ul className={styles.tips}>
              {cost.items.slice(0, 6).map((item, i) => (
                <li key={i}>
                  {item.label} · {formatEstimate(item.estimate)}
                </li>
              ))}
              {cost.items.length > 6 && <li>and {plural(cost.items.length - 6, 'more shot')}</li>}
            </ul>
            <p className={styles.muted}>
              Estimates from fal.ai’s prices on {cost.pricesCheckedOn}. Shots already made are kept if you
              cancel.
            </p>
          </div>
        </Dialog>
      )}
    </ToolView>
  )
}

function GeneratingView({ state }: { state: StateOf<'generating'> }) {
  const job = useJobs().find((j) => j.id === state.jobId)
  const notice = useDirector((s) => s.cancelNotice)
  return (
    <ToolView
      title="Director"
      subtitle={`Generating shot ${Math.min(state.done + 1, state.total)} of ${state.total}`}
      footer={<CancelButton job={job} />}
    >
      <RunCard job={job} label="Generating shots" />
      <p className={styles.muted}>{notice} Shots already made are kept.</p>
    </ToolView>
  )
}

function DoneView({ state }: { state: StateOf<'applied'> }) {
  const description = useDirector((s) => s.description)
  const [refine, setRefine] = useState('')
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
            onClick={() => void applyDraft({ confirmSpend: true })}
          >
            Retry {plural(state.failedShots, 'failed shot')}
          </Button>
        </div>
      )}
      <PlanList description={description} />
      <Field label="Refine the draft" hint="Press Enter to draft again with this change.">
        <TextArea
          rows={2}
          value={refine}
          onChange={(e) => setRefine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="For example: fewer crowd shots, more of the singer in verse 2"
          aria-label="Refine the draft"
        />
      </Field>
    </ToolView>
  )
}

function ErrorView({ state }: { state: StateOf<'error'> }) {
  const retry = () => {
    if (state.plan) void applyDraft({ confirmSpend: true })
    else if (state.request) void draftVideo(state.request)
    else resetDirector()
  }
  return (
    <ToolView
      title="Director"
      subtitle="The draft stopped"
      footer={
        <div className={styles.footerRow}>
          <Button variant="secondary" onClick={resetDirector}>
            Back
          </Button>
          <Button variant="primary" icon={<RotateCcw />} className={styles.grow} onClick={retry}>
            Try again
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
            {state.message} Your project is unchanged{state.plan ? ' and shots already made are kept' : ''}.
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
    </ToolView>
  )
}

export function DirectorView() {
  const state = useDirector((s) => s.state)
  const applying = useDirector((s) => s.applying)
  switch (state.status) {
    case 'planning':
      return <PlanningView state={state} />
    case 'ready':
      return applying ? <PlanningView state={state} /> : <ReadyView state={state} />
    case 'generating':
      return <GeneratingView state={state} />
    case 'applied':
      return <DoneView state={state} />
    case 'error':
      return <ErrorView state={state} />
    default:
      return <IdleView />
  }
}
