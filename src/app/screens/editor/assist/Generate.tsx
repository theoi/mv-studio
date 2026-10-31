import { useState, type ReactNode, type RefObject } from 'react'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Info,
  KeyRound,
  LocateFixed,
  RotateCcw,
  Settings,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { cloudErrorInfo } from '../../../../cloud/errors.ts'
import { formatEstimate, formatUsd, PRICES_CHECKED_ON } from '../../../../cloud/pricing.ts'
import type { JobSnapshot } from '../../../../shared/jobs.ts'
import { Button } from '../../../ds/Button.tsx'
import { Dialog } from '../../../ds/Dialog.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, Select, TextArea } from '../../../ds/Fields.tsx'
import { formatTime, plural } from '../../../format.ts'
import { useCloud } from '../../../state/cloud.ts'
import {
  durationOf,
  estimateOf,
  generateCancelNotice,
  generateOutcome,
  generateRun,
  IMAGE_COUNTS,
  lengthsFor,
  modelOf,
  modelsFor,
  setGenerateForm,
  spendCheck,
  startGenerate,
  startImages,
  taskOf,
  undoOutcome,
  useGenerateForm,
  type GenerateKind,
} from '../../../state/generate.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { useProject } from '../../../state/project.ts'
import { showClips } from '../../../state/reveal.ts'
import { set, toast } from '../../../state/ui.ts'
import { dismiss, pct, useFocusAfterCancel, useJob } from './jobState.ts'
import { CancelButton, Field, RunCard, Steps, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Generate row of Assist's tool list. */
export function GenerateBadge() {
  const cloud = useCloud()
  const { job, phase } = useJob(JOB_KINDS.generate)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  if (!cloud.falKey) return <Badge icon={<KeyRound />}>fal.ai</Badge>
  return null
}

export function GenerateView() {
  const { job, phase } = useJob(JOB_KINDS.generate)
  const focus = useFocusAfterCancel(phase === 'running')
  if (phase === 'running') return <Running job={job} onCancel={focus.cancelled} />
  if (phase === 'done') return <Done job={job} />
  if (phase === 'failed') return <Failed job={job} />
  return <Setup actionRef={focus.target} />
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const openSettings = () => set({ dialog: 'settings', settingsPage: 'ai' })

/** Starts a generation, asking first when the spend policy says so. Render `dialog` wherever this is used. */
function useStartGenerate(): { start: (at?: number) => void; starting: boolean; dialog: ReactNode } {
  const project = useProject()
  const f = useGenerateForm()
  const [check, setCheck] = useState<{
    spend: NonNullable<ReturnType<typeof spendCheck>>
    at?: number
  } | null>(null)
  const [starting, setStarting] = useState(false)
  const estimate = estimateOf(f, project)
  const what = modelOf(f).output === 'video' ? 'a video' : f.count > 1 ? `${f.count} images` : 'an image'
  const run = (at?: number) => {
    setCheck(null)
    setStarting(true)
    void startGenerate(at).finally(() => setStarting(false))
  }
  const start = (at?: number) => {
    const spend = spendCheck(estimate.usd)
    if (spend) setCheck({ spend, at })
    else run(at)
  }
  const dialog = (
    <Dialog
      open={check !== null}
      onOpenChange={(open) => !open && setCheck(null)}
      title={`Generate ${what} for ${formatEstimate(estimate)}?`}
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={() => setCheck(null)}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Sparkles />} onClick={() => run(check?.at)}>
            Generate · {formatEstimate(estimate)}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.lede}>
          {estimate.breakdown}, charged by fal.ai to your key. Prices checked {PRICES_CHECKED_ON}.
        </p>
        {check && check.spend.reminderUsd > 0 && (
          <p className={styles.lede}>
            This takes your estimated fal.ai spend this month past your {formatUsd(check.spend.reminderUsd)}{' '}
            reminder ({formatEstimate({ usd: check.spend.monthTotal })} so far).
          </p>
        )}
        <p className={styles.muted}>Choose when to be asked in Settings › AI and cloud.</p>
      </div>
    </Dialog>
  )
  return { start, starting, dialog }
}

/** `actionRef` is the Generate button, which takes focus after a Cancel. */
function Setup({ actionRef }: { actionRef: RefObject<HTMLButtonElement | null> }) {
  const cloud = useCloud()
  const project = useProject()
  const f = useGenerateForm()
  const { start, starting, dialog } = useStartGenerate()
  const task = taskOf(f)
  const model = modelOf(f)
  const estimate = estimateOf(f, project)
  const images = startImages(project)
  const video = f.kind === 'video'
  const connected = cloud.falKey.length > 0
  const ready = f.prompt.trim().length > 0 || task === 'image-to-video'
  const duration = durationOf(f, model)
  const each = video ? estimate.usd : estimate.usd / f.count
  return (
    <ToolView
      title="Generate"
      subtitle="AI images and clips with fal.ai"
      footer={
        connected ? (
          <>
            <Button
              ref={actionRef}
              variant="primary"
              block
              icon={<Sparkles />}
              disabled={!ready || starting}
              onClick={() => start()}
            >
              Generate · {formatEstimate(estimate)}
            </Button>
            <div className={styles.costLine}>
              <Info /> {estimate.breakdown}, charged by fal.ai to your key
            </div>
            {dialog}
          </>
        ) : (
          <>
            <Button variant="primary" block icon={<KeyRound />} onClick={openSettings}>
              Connect fal.ai to generate
            </Button>
            <div className={styles.costLine}>
              <Info /> {capitalize(formatEstimate({ usd: each }))} per{' '}
              {video ? `${duration} s clip` : 'image'}, charged by fal.ai to your key
            </div>
          </>
        )
      }
    >
      <Segmented
        block
        value={f.kind}
        onChange={(kind: GenerateKind) => setGenerateForm({ kind })}
        ariaLabel="What to generate"
        options={[
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video clip' },
        ]}
      />
      <Field label="Describe the shot">
        <TextArea
          rows={3}
          value={f.prompt}
          onChange={(e) => setGenerateForm({ prompt: e.target.value })}
          placeholder="For example: slow aerial over a neon city at night, light rain, cinematic"
          aria-label="Describe the shot"
        />
      </Field>
      {video && (
        <Field label="Start from" hint="Optional. Animate one of your images.">
          <Select
            value={f.startImageId ?? 'none'}
            onChange={(v) => setGenerateForm({ startImageId: v === 'none' ? null : v })}
            ariaLabel="Start image"
            options={[
              { value: 'none', label: 'Text only' },
              ...images.map((a) => ({ value: a.id, label: `${a.name.replace(/\.[^.]+$/, '')} (image)` })),
            ]}
          />
        </Field>
      )}
      <div className={styles.twoCol}>
        <Field label="Model">
          <Select
            value={model.id}
            onChange={(id) => setGenerateForm({ models: { ...f.models, [task]: id } })}
            ariaLabel="Model"
            options={modelsFor(task).map((m) => ({
              value: m.id,
              label: `${m.name} · ${m.tier === 'draft' ? 'fast' : 'high quality'}`,
              description: `${m.description} ${m.priceLabel}.`,
            }))}
          />
        </Field>
        <Field label={video ? 'Length' : 'Count'}>
          {video ? (
            <Select
              value={String(duration)}
              onChange={(v) => setGenerateForm({ duration: Number(v) })}
              ariaLabel="Length"
              options={lengthsFor(model).map((s) => ({ value: String(s), label: `${s} s` }))}
            />
          ) : (
            <Select
              value={String(f.count)}
              onChange={(v) => setGenerateForm({ count: Number(v) })}
              ariaLabel="Count"
              options={IMAGE_COUNTS.map((n) => ({ value: String(n), label: plural(n, 'image') }))}
            />
          )}
        </Field>
      </div>
      {f.target ? (
        <>
          <p className={styles.muted}>Results land in Media › Generated and {f.target.where}.</p>
          <div className={styles.linkRow}>
            <Button size="sm" variant="ghost" onClick={() => setGenerateForm({ target: null })}>
              Use the playhead instead
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.muted}>Results land in Media › Generated and at the playhead as normal clips.</p>
      )}
    </ToolView>
  )
}

const STEP_OF_STAGE: Record<string, number> = {
  upload: 0,
  submit: 1,
  queue: 1,
  generate: 2,
  download: 3,
  store: 3,
  stopping: 3,
}

function Running({ job, onCancel }: { job?: JobSnapshot; onCancel: () => void }) {
  const run = generateRun(job?.id)
  const stopping = Boolean(job?.stopping)
  // After a Cancel, a result fal.ai already made is still downloading, to be kept in Media.
  const keeping = job?.progress.stage === 'stopping'
  const upload = run?.task === 'image-to-video'
  const steps = [
    ...(upload ? ['Upload the image'] : []),
    'Wait in line at fal.ai',
    run?.task === 'text-to-image' ? 'Generate the image' : 'Generate the video',
    'Download and save to Media',
  ]
  const stepOf = STEP_OF_STAGE[job?.progress.stage ?? 'submit'] ?? 1
  const active = upload ? stepOf : Math.max(0, stepOf - 1)
  return (
    <ToolView
      title="Generate"
      subtitle={stopping ? 'Stopping…' : (job?.title.split(' · ')[0] ?? 'Generating')}
      footer={
        <>
          <CancelButton job={job} disabled={stopping} onCancel={onCancel} />
          {!stopping && generateCancelNotice() && (
            <div className={styles.costLine}>
              <Info /> {generateCancelNotice()}
            </div>
          )}
        </>
      }
    >
      <RunCard
        job={job}
        label="Generation progress"
        note={
          keeping
            ? `Keeping 1 ${run?.task === 'text-to-image' ? 'image' : 'video'} that is downloading`
            : undefined
        }
      />
      <Steps steps={steps} active={active} />
      {!stopping && (
        <p className={styles.muted}>
          Keep editing. The result lands at {formatTime(run?.start ?? 0)} on the timeline when it’s ready.
        </p>
      )}
    </ToolView>
  )
}

function Done({ job }: { job?: JobSnapshot }) {
  const outcome = generateOutcome(job?.id)
  const assets = outcome?.assets ?? []
  const name = assets.length === 1 ? (assets[0]?.name ?? 'the result') : plural(assets.length, 'image')
  return (
    <ToolView
      title="Generate"
      subtitle="Added to your project"
      footer={
        <div className={styles.footerRow}>
          <Button
            variant="secondary"
            icon={<Undo2 />}
            onClick={() => {
              if (outcome && undoOutcome(outcome)) toast('Removed from the timeline and Media')
              else toast('The project changed since. Delete the clip on the timeline instead.')
              dismiss(job)
            }}
          >
            Undo
          </Button>
          <Button variant="primary" icon={<Sparkles />} className={styles.grow} onClick={() => dismiss(job)}>
            Generate another
          </Button>
        </div>
      }
    >
      <div className={styles.success}>
        <span className={styles.successIcon}>
          <Check />
        </span>
        <div>
          <div className={styles.successTitle}>Added {name}</div>
          <div className={styles.muted}>
            In Media › Generated and at {formatTime(outcome?.start ?? 0)} on the timeline, as{' '}
            {assets.length === 1 ? 'a normal clip' : 'normal clips'}.{' '}
            {capitalize(formatEstimate({ usd: outcome?.usd ?? 0 }))}, charged by fal.ai.
          </div>
          <Button
            size="sm"
            icon={<LocateFixed />}
            className={styles.successAction}
            disabled={!outcome}
            onClick={() => outcome && showClips(outcome.clipIds, { openInspector: false })}
          >
            Show
          </Button>
        </div>
      </div>
    </ToolView>
  )
}

function Failed({ job }: { job?: JobSnapshot }) {
  const { start, starting, dialog } = useStartGenerate()
  const info = cloudErrorInfo(job?.error)
  const kind = info?.kind
  const keyProblem = kind === 'missing-key' || kind === 'bad-key'
  const canRetry = keyProblem ? false : (job?.error?.retryable ?? false) || kind === 'insufficient-credit'
  const title = info?.title ?? job?.error?.message ?? 'Generation failed'
  const message = job?.error?.message && job.error.message !== title ? job.error.message : ''
  // What fal.ai made before the failure went to Media, as the toast said.
  const kept = generateOutcome(job?.id)?.kept
  const back = (
    <Button variant="secondary" onClick={() => dismiss(job)}>
      Back
    </Button>
  )
  return (
    <ToolView
      title="Generate"
      subtitle="Generation stopped"
      footer={
        keyProblem ? (
          <div className={styles.footerRow}>
            {back}
            <Button
              variant="primary"
              icon={<Settings />}
              className={styles.grow}
              onClick={() => {
                dismiss(job)
                openSettings()
              }}
            >
              Open Settings
            </Button>
          </div>
        ) : canRetry ? (
          <div className={styles.footerRow}>
            {back}
            <Button
              variant="primary"
              icon={<RotateCcw />}
              className={styles.grow}
              disabled={starting}
              onClick={() => start(generateRun(job?.id)?.start)}
            >
              Try again
            </Button>
            {dialog}
          </div>
        ) : (
          <Button variant="primary" block onClick={() => dismiss(job)}>
            Change and try again
          </Button>
        )
      }
    >
      <div className={styles.failure} role="alert">
        <span className={styles.failureIcon}>
          <AlertTriangle />
        </span>
        <div>
          <div className={styles.successTitle}>{title}</div>
          <div className={styles.muted}>
            {message} {kept ? `The timeline is unchanged. ${kept}` : 'Your project is unchanged.'}
          </div>
        </div>
      </div>
      {info && info.steps.length > 0 && (
        <>
          <div className={styles.groupLabelInset}>What to do</div>
          <ol className={styles.tips}>
            {info.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </>
      )}
      {info?.helpUrl && (
        <div className={styles.linkRow}>
          <Button
            size="sm"
            variant="ghost"
            icon={<ExternalLink />}
            onClick={() => window.open(info.helpUrl, '_blank', 'noopener,noreferrer')}
          >
            {kind === 'insufficient-credit' ? 'fal.ai billing' : 'fal.ai keys'}
          </Button>
        </div>
      )}
    </ToolView>
  )
}
