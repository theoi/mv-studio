/**
 * DirectorSession: the headless state machine behind Assist › Director. It plans (no cost), shows the plan with a
 * change preview and the generation cost, waits for the user to confirm any spend, generates AI shots as a job,
 * then applies everything as one undo step. React: useSyncExternalStore(session.subscribe, session.getState).
 */
import { cloudErrorInfo } from '../cloud/errors.ts'
import type { GeneratedMediaStore } from '../cloud/media.ts'
import { formatEstimate } from '../cloud/pricing.ts'
import type { MediaGenerationProvider } from '../cloud/types.ts'
import type { MediaFileSource } from '../engine/types.ts'
import type { ProjectEditor } from '../model/editor.ts'
import type { Asset, Id } from '../model/types.ts'
import {
  JobError,
  type JobContext,
  type JobHandle,
  type JobRunner,
  type SerializedJobError,
} from '../shared/jobs.ts'
import { DEFAULT_CATALOG, type DirectorCatalog } from './catalog.ts'
import { compilePlan, type CompiledPlan } from './compile.ts'
import { estimatePlanCost, requiresConfirmation, type PlanCost, type SpendPolicy } from './cost.ts'
import { previewCommands, type ChangeItem } from './diff.ts'
import { DirectorError } from './expand.ts'
import { generatePlanShots, generationOptionsFor, type GenerationChoice } from './generate.ts'
import {
  buildPlannerInput,
  type FootageMatcher,
  type FootageRanker,
  type PlannerInput,
  type VideoKind,
} from './inputs.ts'
import { planLocally } from './local-planner.ts'
import { shotsToGenerate, type EditPlan, type Pace } from './plan.ts'

export interface DirectorRequest {
  kind: VideoKind
  prompt?: string
  pace?: Pace
  seed?: number
  /** Use the user's clips and images (default true). */
  useMedia?: boolean
  /** Generate AI shots; needs a configured provider. */
  generate?: GenerationChoice
}

export type Planner = (input: PlannerInput, ctx: JobContext) => Promise<EditPlan>

export interface SpendLedgerLike {
  record(usd: number, label: string): void
  crossesReminder(usd: number, monthlyReminderUsd: number): boolean
}

export interface DirectorDeps {
  editor: ProjectEditor
  jobs: JobRunner
  /** The configured generation provider, e.g. () => cloud.generation(). */
  provider?: () => MediaGenerationProvider | undefined
  store?: GeneratedMediaStore
  /** Footage tags (labels, motion, mood) for the LLM brief: createDirectorFootageMatcher() from src/vision. */
  matcher?: () => FootageMatcher | undefined
  /** src/vision's footage matcher, `() => vision.matcher`, for choosing a clip per shot. */
  footage?: () => FootageRanker | undefined
  catalog?: () => DirectorCatalog
  spendPolicy?: () => SpendPolicy
  ledger?: SpendLedgerLike
  /** Defaults to the local rule planner. */
  planner?: Planner
  /** When the planning state turns slow (default 8000 ms). */
  slowAfterMs?: number
  readAsset?: (assetId: Id) => Promise<Blob>
  /** Reads stored media (`appMedia`), so the director can measure footage brightness under lyrics. */
  media?: MediaFileSource
}

export interface PlanPreview {
  /** What the plan makes, e.g. "Beat-cut video with 6 sections, 48 shots, 5 of your clips, Vivid look." */
  summary: string
  /** What applying changes, e.g. "Adds 52 clips and 3 tracks." */
  changes: string
  items: ChangeItem[]
  warnings: string[]
}

export type DirectorState =
  | { status: 'idle' }
  | {
      status: 'planning'
      request: DirectorRequest
      jobId: string
      message: string
      /** Still planning after a few seconds: show "Still working" with Cancel. */
      slow: boolean
      /** The AI model is planning; offer "Use the local draft instead" (useLocalDraft()). */
      canUseLocal: boolean
      /** Date.now() when planning started, for an elapsed-time counter. */
      startedAt: number
    }
  | {
      status: 'ready'
      request: DirectorRequest
      plan: EditPlan
      preview: PlanPreview
      /** Null when nothing needs generating. */
      cost: PlanCost | null
      /** The apply button must open a cost confirmation first. */
      confirmRequired: boolean
      /** e.g. "Make video" or "Generate 12 shots · about $2.40". */
      actionLabel: string
      /** AI shots already generated for this plan (kept after a cancel). */
      generatedShots: number
    }
  | {
      status: 'generating'
      request: DirectorRequest
      plan: EditPlan
      jobId: string
      done: number
      total: number
      fraction: number
      message: string
    }
  | {
      status: 'applied'
      request: DirectorRequest
      plan: EditPlan
      /** Undo menu label. */
      label: string
      summary: string
      warnings: string[]
      /** AI shots that failed and show as placeholders; apply again to retry just those. */
      failedShots: number
    }
  | {
      status: 'error'
      request?: DirectorRequest
      plan?: EditPlan
      error: SerializedJobError
      title: string
      message: string
      steps: string[]
    }

const DEFAULT_POLICY: SpendPolicy = { alwaysConfirmPaid: false, confirmAboveUsd: 1, monthlyReminderUsd: 0 }

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export class DirectorSession {
  private state: DirectorState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private readonly deps: DirectorDeps
  private job?: JobHandle<unknown>
  /** Paid results by plan id and shot id; kept until a new plan replaces them. */
  private generated = new Map<string, Map<string, Asset>>()
  private appliedLabel?: string

  constructor(deps: DirectorDeps) {
    this.deps = deps
  }

  getState = (): DirectorState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(state: DirectorState) {
    this.state = state
    for (const l of this.listeners) l()
  }

  private catalog(): DirectorCatalog {
    return this.deps.catalog?.() ?? DEFAULT_CATALOG
  }

  private generatedFor(plan: EditPlan): Map<string, Asset> {
    let map = this.generated.get(plan.id)
    if (!map) {
      map = new Map()
      this.generated.set(plan.id, map)
    }
    return map
  }

  /** Makes a plan. Costs nothing: generation only happens in apply(). */
  async plan(request: DirectorRequest, options: { local?: boolean } = {}): Promise<DirectorState> {
    this.job?.cancel()
    const project = this.deps.editor.getProject()
    const provider = request.generate ? this.deps.provider?.() : undefined
    const local = (input: PlannerInput) => planLocally(input)
    const planner = options.local ? local : (this.deps.planner ?? local)
    const handle = this.deps.jobs.run({
      kind: 'director.plan',
      title: 'Planning your video',
      run: async (ctx) => {
        ctx.progress({ stage: 'gather', fraction: 0.05, message: 'Reading the song and your media' })
        const input = await buildPlannerInput(project, {
          kind: request.kind,
          prompt: request.prompt,
          pace: request.pace,
          seed: request.seed,
          useMedia: request.useMedia,
          catalog: this.catalog(),
          matcher: this.deps.matcher?.(),
          footage: this.deps.footage?.(),
          ...(this.deps.media ? { media: this.deps.media } : {}),
          generation:
            provider && request.generate ? generationOptionsFor(provider, request.generate) : undefined,
        })
        ctx.throwIfCancelled()
        ctx.progress({ stage: 'plan', fraction: 0.3, message: 'Planning shots, text and effects' })
        return planner(input, ctx)
      },
    })
    this.job = handle
    this.set({
      status: 'planning',
      request,
      jobId: handle.id,
      message: 'Planning your video',
      slow: false,
      canUseLocal: planner !== local,
      startedAt: Date.now(),
    })
    const planning = (patch: { message?: string; slow?: boolean }) => {
      if (this.job === handle && this.state.status === 'planning') this.set({ ...this.state, ...patch })
    }
    const unsubscribe = handle.subscribe((snapshot) => {
      const message = snapshot.progress.message
      if (message && this.state.status === 'planning' && message !== this.state.message) planning({ message })
    })
    const timer = setTimeout(() => planning({ slow: true }), this.deps.slowAfterMs ?? 8000)
    try {
      const plan = await handle.promise
      if (this.job !== handle) return this.state
      this.generated = new Map()
      this.set(this.readyState(request, plan))
    } catch (error) {
      if (this.job !== handle) return this.state
      this.failOrReset(error, request)
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
    return this.state
  }

  /** While the AI model plans: stop waiting for it and make the draft with the built-in planner instead. */
  useLocalDraft(): Promise<DirectorState> {
    if (this.state.status !== 'planning' || !this.state.canUseLocal) return Promise.resolve(this.state)
    return this.plan(this.state.request, { local: true })
  }

  /** Plans again with another seed: different clip picks, prompts and camera moves. */
  tryAnother(): Promise<DirectorState> {
    const request = 'request' in this.state ? this.state.request : undefined
    if (!request) return Promise.resolve(this.state)
    return this.plan({ ...request, seed: (request.seed ?? 1) + 1 })
  }

  private readyState(request: DirectorRequest, plan: EditPlan, extraWarnings: string[] = []): DirectorState {
    const project = this.deps.editor.getProject()
    const done = this.generatedFor(plan)
    const compiled = compilePlan(plan, project, { catalog: this.catalog(), generated: done })
    const preview = previewCommands(project, compiled.commands)
    const cost = this.costOf(plan, done)
    const usd = cost?.usd ?? 0
    const confirmRequired = requiresConfirmation(
      usd,
      this.deps.spendPolicy?.() ?? DEFAULT_POLICY,
      this.deps.ledger,
    )
    const toMake = cost?.requests.filter((r) => !done.has(r.shot.id)).length ?? 0
    return {
      status: 'ready',
      request,
      plan,
      preview: {
        summary: plan.summary,
        changes: preview.ok ? preview.summary : preview.message,
        items: preview.ok ? preview.items : [],
        warnings: [...new Set([...plan.warnings, ...compiled.warnings, ...extraWarnings])],
      },
      cost,
      confirmRequired,
      actionLabel:
        toMake > 0 ? `Generate ${plural(toMake, 'shot')} · ${formatEstimate({ usd })}` : 'Make video',
      generatedShots: done.size,
    }
  }

  private costOf(plan: EditPlan, done: Map<string, Asset>): PlanCost | null {
    if (shotsToGenerate(plan).length === 0) return null
    const provider = this.deps.provider?.()
    if (!provider) return null
    const remaining: EditPlan = { ...plan, shots: plan.shots.filter((s) => !done.has(s.id)) }
    const cost = estimatePlanCost(remaining, provider, this.deps.editor.getProject())
    return cost.count > 0 || cost.reused > 0 ? cost : null
  }

  /**
   * Generates any AI shots, then applies the plan as one undo step. Throws DirectorError('needs-confirmation')
   * when the cost needs the user's OK and `confirmSpend` is not set, so nothing is ever spent silently.
   * With `skipGeneration`, AI shots that are not generated yet become placeholders.
   */
  async apply(options: { confirmSpend?: boolean; skipGeneration?: boolean } = {}): Promise<DirectorState> {
    const current = this.state
    const plan = 'plan' in current ? current.plan : undefined
    const request = 'request' in current ? current.request : undefined
    if (!plan || !request || current.status === 'planning' || current.status === 'generating') {
      throw new DirectorError('no-plan', 'Make a plan first.')
    }
    const done = this.generatedFor(plan)
    const cost = options.skipGeneration ? null : this.costOf(plan, done)
    const usd = cost?.usd ?? 0
    const needsGeneration = !options.skipGeneration && shotsToGenerate(plan).some((s) => !done.has(s.id))
    const provider = this.deps.provider?.()
    if (needsGeneration && (!provider || !this.deps.store)) {
      throw new DirectorError(
        'no-provider',
        'Connect fal.ai in Settings to generate shots, or apply with placeholders.',
      )
    }
    if (
      usd > 0 &&
      !options.confirmSpend &&
      requiresConfirmation(usd, this.deps.spendPolicy?.() ?? DEFAULT_POLICY, this.deps.ledger)
    ) {
      throw new DirectorError(
        'needs-confirmation',
        `Generating costs ${formatEstimate({ usd })}. Confirm to continue.`,
      )
    }

    let failed = 0
    const warnings: string[] = []
    if (needsGeneration && provider && this.deps.store) {
      const store = this.deps.store
      const total = cost?.count ?? 0
      const handle = this.deps.jobs.run({
        kind: 'director.generate',
        title: total ? `Generating ${plural(total, 'shot')} · ${formatEstimate({ usd })}` : 'Preparing shots',
        run: (ctx) =>
          generatePlanShots({
            plan,
            provider,
            store,
            ctx,
            project: this.deps.editor.getProject(),
            done,
            readAsset: this.deps.readAsset,
            onShot: (shotId, asset, spent) => {
              done.set(shotId, asset)
              this.deps.ledger?.record(spent, `Director: ${plan.title}`)
            },
          }),
      })
      this.job = handle
      const unsubscribe = handle.subscribe((snap) => {
        if (this.job !== handle || this.state.status !== 'generating') return
        const fraction = snap.progress.fraction ?? 0
        this.set({
          ...this.state,
          fraction,
          done: Math.round(fraction * total),
          message: snap.progress.message ?? '',
        })
      })
      this.set({
        status: 'generating',
        request,
        plan,
        jobId: handle.id,
        done: 0,
        total,
        fraction: 0,
        message: 'Starting',
      })
      try {
        const result = await handle.promise
        for (const [id, asset] of result.assets) done.set(id, asset)
        failed = result.failed.length
        if (failed) {
          const reason = result.failed[0]?.error.message
          warnings.push(
            `${plural(failed, 'shot')} couldn't be generated${reason ? ` (${reason})` : ''}. Apply again to retry just those.`,
          )
        }
      } catch (error) {
        if (this.job !== handle) return this.state
        const err = JobError.from(error)
        if (err.code === 'cancelled') {
          const kept = done.size
            ? ` ${plural(done.size, 'shot')} made so far ${done.size === 1 ? 'is' : 'are'} kept.`
            : ''
          this.set(this.readyState(request, plan, [`Generation stopped.${kept}`]))
        } else {
          this.failOrReset(err, request, plan)
        }
        return this.state
      } finally {
        unsubscribe()
      }
      if (this.job !== handle) return this.state
    }

    const project = this.deps.editor.getProject()
    let compiled: CompiledPlan
    try {
      compiled = compilePlan(plan, project, { catalog: this.catalog(), generated: done })
      this.deps.editor.dispatch(compiled.commands, { label: compiled.label })
    } catch (error) {
      this.failOrReset(error, request, plan)
      return this.state
    }
    this.appliedLabel = compiled.label
    this.set({
      status: 'applied',
      request,
      plan,
      label: compiled.label,
      summary: plan.summary,
      warnings: [...new Set([...plan.warnings, ...compiled.warnings, ...warnings])],
      failedShots: failed,
    })
    return this.state
  }

  /** Undoes the applied draft if it is still the latest change. Generated media stays reusable. */
  undo(): boolean {
    const current = this.state
    if (current.status !== 'applied' || this.deps.editor.undoLabel() !== this.appliedLabel) return false
    this.deps.editor.undo()
    this.appliedLabel = undefined
    this.set(this.readyState(current.request, current.plan))
    return true
  }

  /** Stops planning or generation. Shots already generated are kept. */
  cancel(): void {
    this.job?.cancel()
  }

  reset(): void {
    this.job?.cancel()
    this.job = undefined
    this.generated = new Map()
    this.set({ status: 'idle' })
  }

  private failOrReset(error: unknown, request?: DirectorRequest, plan?: EditPlan) {
    const err = JobError.from(error)
    if (err.code === 'cancelled') {
      this.set(plan && request ? this.readyState(request, plan) : { status: 'idle' })
      return
    }
    const cloud = cloudErrorInfo(err)
    this.set({
      status: 'error',
      ...(request ? { request } : {}),
      ...(plan ? { plan } : {}),
      error: err.toJSON(),
      title:
        cloud?.title ??
        (err instanceof DirectorError
          ? 'The director needs something first'
          : "The director couldn't finish"),
      message: err.message,
      steps: cloud?.steps ?? [],
    })
  }
}
