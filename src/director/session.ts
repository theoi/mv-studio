/**
 * DirectorSession: the headless state machine behind Assist › Director. It plans (no cost), shows the plan with a
 * change preview and the generation cost, waits for the user to confirm any spend, generates AI shots as a job,
 * then applies everything as one undo step. React: useSyncExternalStore(session.subscribe, session.getState).
 */
import { CloudError, cloudErrorInfo } from '../cloud/errors.ts'
import type { GeneratedMediaStore } from '../cloud/media.ts'
import { formatEstimate } from '../cloud/pricing.ts'
import type { MediaGenerationProvider } from '../cloud/types.ts'
import type { MediaFileSource } from '../engine/types.ts'
import type { ProjectEditor } from '../model/editor.ts'
import { BARS_NOTES } from '../model/queries.ts'
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
import { generatedUnit, shotsToGenerate, type EditPlan, type Pace } from './plan.ts'

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
  /** How long planning (after the song analysis and bars) may take before the state turns slow (default 8000 ms). */
  slowAfterMs?: number
  /**
   * How long waiting for the song analysis or the bars may go without progress before the state turns slow (default
   * 15000 ms). While their progress moves they are not slow, however long they take.
   */
  stallAfterMs?: number
  readAsset?: (assetId: Id) => Promise<Blob>
  /** Reads stored media (`appMedia`), so the director can measure footage brightness under lyrics. */
  media?: MediaFileSource
  /**
   * Waits for the song's bars before planning (the app's `ensureBars`): resolves whether the song has them. Without
   * them the plan cuts on beats and says so.
   */
  ensureBars?: (options: { signal: AbortSignal; progress: (fraction: number) => void }) => Promise<boolean>
  /**
   * Waits for a song analysis that is still running (beats, sections; an import or the setup screen started it), so
   * the plan has them. Reports progress only while it waits.
   */
  waitForSong?: (options: { signal: AbortSignal; progress: (fraction: number) => void }) => Promise<void>
}

/** Share of the plan's progress spent finding the song's bars when they are not found yet (often the longest step). */
const BARS_SHARE = 0.5
/** Share for a pass of finding the bars that starts over from 0 (the beat model's download, then the song's analysis). */
const BARS_PASS_SHARE = 0.2
/** Share spent waiting for the song analysis, when the plan has to. */
const SONG_SHARE = 0.25
/** As the song's row in the Library says while it is analyzed. */
const SONG_NOTE = 'Finding beats and sections…'

export interface PlanPreview {
  /** What the plan makes, e.g. "Beat-cut video with 6 sections, 48 shots, 5 of your clips, Vivid look." */
  summary: string
  /** What applying changes, e.g. "Adds 52 clips and 3 tracks." */
  changes: string
  items: ChangeItem[]
  warnings: string[]
}

export type PlanStage = 'song' | 'bars' | 'plan'

/** What the plan's AI shots are called in the panel: "clip" when they are all videos. */
export type GeneratedUnit = 'shot' | 'clip'

export type DirectorState =
  | { status: 'idle' }
  | {
      status: 'planning'
      request: DirectorRequest
      jobId: string
      message: string
      /**
       * What the draft is doing: waiting for the song analysis ('song') or the bars ('bars'), which report measured
       * progress, or planning ('plan').
       */
      stage: PlanStage
      /** Still planning after a few seconds: show "Still working" with Cancel. */
      slow: boolean
      /**
       * The AI model is planning; offer "Use the local draft instead" (useLocalDraft()). Never while the song analysis
       * or the bars are still running: the local draft would wait for them too.
       */
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
      unit: GeneratedUnit
    }
  | {
      status: 'generating'
      request: DirectorRequest
      plan: EditPlan
      jobId: string
      /** Shots finished (made or failed) and failed so far, of `total`. */
      done: number
      failed: number
      total: number
      fraction: number
      message: string
      unit: GeneratedUnit
      /** Set once Cancel was pressed while results fal.ai already made are downloading: how many are kept. */
      stopping?: { keeping: number }
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
      /** The first failure in its source's words, for a tooltip ("fal.ai said: …" when from fal.ai); the warning stays plain. */
      failedReason?: string
      /** What retrying the failed shots costs, and whether that needs the user's OK first. */
      cost: PlanCost | null
      confirmRequired: boolean
      /** The user's tracks under the draft that it hid (nothing is deleted; undo shows them again). */
      hiddenTracks: Id[]
      unit: GeneratedUnit
    }
  | {
      status: 'error'
      request?: DirectorRequest
      plan?: EditPlan
      error: SerializedJobError
      title: string
      message: string
      steps: string[]
      /** With a plan: what finishing it costs, and whether that needs the user's OK first. */
      cost: PlanCost | null
      confirmRequired: boolean
      /** AI shots already made for the plan; they are kept. */
      generatedShots: number
      unit: GeneratedUnit
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
    const provider = request.generate ? this.deps.provider?.() : undefined
    const local = (input: PlannerInput) => planLocally(input)
    const planner = options.local ? local : (this.deps.planner ?? local)
    const aiPlanner = planner !== local
    const handle = this.deps.jobs.run({
      kind: 'director.plan',
      // As the Director panel's subtitle says, so the top bar's job reads as the same job in every stage.
      title: 'Drafting your video',
      run: async (jobCtx) => {
        // Each stage reports its own fraction, and finding the bars can start a second pass from 0: the bar never moves
        // back, while the slow check sees each stage's own progress.
        let shown = 0
        const ctx: JobContext = {
          signal: jobCtx.signal,
          throwIfCancelled: () => jobCtx.throwIfCancelled(),
          progress: (p) => {
            if (p.stage !== undefined) onStage(p.stage, p.fraction)
            if (p.fraction === undefined) return jobCtx.progress(p)
            shown = Math.max(shown, p.fraction)
            jobCtx.progress({ ...p, fraction: shown })
          },
        }
        // The song analysis and the bars report progress only while they run; the rest of the plan then gets the rest
        // of the bar.
        let share = 0
        if (this.deps.waitForSong)
          await this.deps.waitForSong({
            signal: ctx.signal,
            progress: (f) => {
              share = SONG_SHARE
              ctx.progress({ stage: 'song', fraction: SONG_SHARE * f, message: SONG_NOTE })
            },
          })
        // Each pass that starts over gets the next band above the last, so the bar keeps moving through it.
        let barsFrom = share
        let barsTo = BARS_SHARE
        let lastBars = 0
        const bars = this.deps.ensureBars
          ? await this.deps.ensureBars({
              signal: ctx.signal,
              progress: (f) => {
                // Planning keeps at least a tenth of the bar.
                if (f < lastBars) [barsFrom, barsTo] = [barsTo, Math.min(0.9, barsTo + BARS_PASS_SHARE)]
                lastBars = f
                share = barsTo
                ctx.progress({
                  stage: 'bars',
                  fraction: barsFrom + (barsTo - barsFrom) * f,
                  message: BARS_NOTES.finding,
                })
              },
            })
          : true
        const planCtx: JobContext =
          share === 0
            ? ctx
            : {
                signal: ctx.signal,
                throwIfCancelled: () => ctx.throwIfCancelled(),
                progress: (p) =>
                  ctx.progress(
                    p.fraction === undefined ? p : { ...p, fraction: share + p.fraction * (1 - share) },
                  ),
              }
        planCtx.progress({ stage: 'gather', fraction: 0.05, message: 'Reading the song and your media' })
        const project = this.deps.editor.getProject()
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
        planCtx.progress({ stage: 'plan', fraction: 0.3, message: 'Planning shots, text and effects' })
        const plan = await planner(input, planCtx)
        return bars || !input.song.beats.length
          ? plan
          : { ...plan, warnings: [...plan.warnings, BARS_NOTES.beatsOnly] }
      },
    })
    this.job = handle
    this.set({
      status: 'planning',
      request,
      jobId: handle.id,
      message: 'Planning your video',
      stage: 'plan',
      slow: false,
      canUseLocal: aiPlanner,
      startedAt: Date.now(),
    })
    const planning = (patch: {
      message?: string
      slow?: boolean
      stage?: PlanStage
      canUseLocal?: boolean
    }) => {
      if (this.job === handle && this.state.status === 'planning') this.set({ ...this.state, ...patch })
    }
    // Slow is judged per stage: waiting for the song analysis or the bars only when their progress stalls, planning
    // when it runs past the time a plan usually takes. Each stage starts its own clock.
    const slowAfter = this.deps.slowAfterMs ?? 8000
    const stallAfter = this.deps.stallAfterMs ?? 15000
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => planning({ slow: true }), ms)
    }
    const notSlow = () => {
      if (this.state.status === 'planning' && this.state.slow) planning({ slow: false })
    }
    let stage: PlanStage | undefined
    let fraction: number | undefined
    // Called from the job's progress with each stage's own fraction, before the bar's no-going-back clamp: a second
    // pass that starts lower is still progress.
    const onStage = (name: string, f: number | undefined) => {
      const next: PlanStage = name === 'song' || name === 'bars' ? name : 'plan'
      if (next !== stage) {
        stage = next
        fraction = f
        planning({ stage: next, slow: false, canUseLocal: aiPlanner && next === 'plan' })
        arm(next === 'plan' ? slowAfter : stallAfter)
      } else if (next !== 'plan' && f !== fraction) {
        fraction = f
        notSlow()
        arm(stallAfter)
      }
    }
    const unsubscribe = handle.subscribe((snapshot) => {
      const { message } = snapshot.progress
      if (message && this.state.status === 'planning' && message !== this.state.message) planning({ message })
    })
    if (stage === undefined) arm(slowAfter)
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

  /** What generating the plan's remaining AI shots costs, and whether the spend policy asks first. */
  private spendFor(plan: EditPlan): { cost: PlanCost | null; confirmRequired: boolean; toMake: number } {
    const done = this.generatedFor(plan)
    const cost = this.costOf(plan, done)
    const confirmRequired = requiresConfirmation(
      cost?.usd ?? 0,
      this.deps.spendPolicy?.() ?? DEFAULT_POLICY,
      this.deps.ledger,
    )
    const toMake = cost?.requests.filter((r) => !done.has(r.shot.id)).length ?? 0
    return { cost, confirmRequired, toMake }
  }

  private readyState(request: DirectorRequest, plan: EditPlan, extraWarnings: string[] = []): DirectorState {
    const project = this.deps.editor.getProject()
    const done = this.generatedFor(plan)
    const compiled = compilePlan(plan, project, {
      catalog: this.catalog(),
      generated: done,
      placeholderNote: 'if-skipped',
    })
    const preview = previewCommands(project, compiled.commands)
    const { cost, confirmRequired, toMake } = this.spendFor(plan)
    const usd = cost?.usd ?? 0
    const unit = generatedUnit(plan)
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
        toMake > 0 ? `Generate ${plural(toMake, unit)} · ${formatEstimate({ usd })}` : 'Make video',
      generatedShots: done.size,
      unit,
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
    const unit = generatedUnit(plan)
    if (needsGeneration && (!provider || !this.deps.store)) {
      throw new DirectorError(
        'no-provider',
        `Connect fal.ai in Settings to generate ${unit}s, or apply with placeholders.`,
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
    let failedReason: string | undefined
    const warnings: string[] = []
    if (needsGeneration && provider && this.deps.store) {
      const store = this.deps.store
      const total = cost?.count ?? 0
      const handle = this.deps.jobs.run({
        kind: 'director.generate',
        title: total
          ? `Generating ${plural(total, unit)} · ${formatEstimate({ usd })}`
          : `Preparing ${unit}s`,
        run: (ctx) =>
          generatePlanShots({
            plan,
            provider,
            store,
            ctx,
            project: this.deps.editor.getProject(),
            done,
            readAsset: this.deps.readAsset,
            onShot: (shotId, asset) => {
              done.set(shotId, asset)
              this.keep(asset)
            },
            onBilled: (usd) => this.deps.ledger?.record(usd, `Director: ${plan.title}`),
            onProgress: (counts) => {
              if (this.job === handle && this.state.status === 'generating')
                this.set({ ...this.state, done: counts.done, failed: counts.failed })
            },
            onStopping: (keeping) => {
              if (this.job === handle && this.state.status === 'generating')
                this.set({ ...this.state, stopping: { keeping } })
            },
          }),
      })
      this.job = handle
      const unsubscribe = handle.subscribe((snap) => {
        if (this.job !== handle || this.state.status !== 'generating') return
        this.set({
          ...this.state,
          fraction: snap.progress.fraction ?? 0,
          message: snap.progress.message ?? '',
        })
      })
      this.set({
        status: 'generating',
        request,
        plan,
        jobId: handle.id,
        done: 0,
        failed: 0,
        total,
        fraction: 0,
        message: 'Starting',
        unit,
      })
      try {
        const result = await handle.promise
        for (const [id, asset] of result.assets) done.set(id, asset)
        failed = result.failed.length
        const first = result.failed[0]?.error
        if (first?.message)
          failedReason =
            first instanceof CloudError && first.provider === 'fal'
              ? `fal.ai said: ${first.message}`
              : first.message
        if (failed) {
          // The no-break space keeps "place" from ending up alone on the note's last line in the narrow panel.
          warnings.push(
            failed === 1
              ? `1 ${unit} couldn’t be generated. Retry it below; a dark placeholder marks its\u00a0place.`
              : `${plural(failed, unit)} couldn’t be generated. Retry them below; dark placeholders mark their\u00a0place.`,
          )
        }
      } catch (error) {
        if (this.job !== handle) return this.state
        const err = JobError.from(error)
        if (err.code === 'cancelled') {
          const kept = done.size
            ? ` ${plural(done.size, unit)} made so far ${done.size === 1 ? 'is' : 'are'} kept.`
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
      compiled = compilePlan(plan, project, {
        catalog: this.catalog(),
        generated: done,
        ...(failed ? { placeholderNote: 'none' as const } : {}),
      })
      this.deps.editor.dispatch(compiled.commands, { label: compiled.label })
    } catch (error) {
      this.failOrReset(error, request, plan)
      return this.state
    }
    this.appliedLabel = compiled.label
    const retry = failed > 0 ? this.spendFor(plan) : { cost: null, confirmRequired: false }
    this.set({
      status: 'applied',
      request,
      plan,
      label: compiled.label,
      summary: plan.summary,
      warnings: [...new Set([...plan.warnings, ...compiled.warnings, ...warnings])],
      failedShots: failed,
      ...(failed && failedReason ? { failedReason } : {}),
      cost: retry.cost,
      confirmRequired: retry.confirmRequired,
      hiddenTracks: compiled.stats.hiddenTracks,
      unit,
    })
    return this.state
  }

  /**
   * Paid media goes into the project's media as soon as it is made, outside any undo step, so undoing or replacing
   * a draft never throws away what the user paid for; later plans with the same request reuse it.
   */
  private keep(asset: Asset) {
    const editor = this.deps.editor
    if (editor.getProject().assets[asset.id]) return
    editor.dispatch({ type: 'asset.add', asset }, { history: 'skip' })
  }

  /** From a failed generation: back to the plan, with its price and "apply without AI shots". */
  backToPlan(): DirectorState {
    const current = this.state
    if (current.status === 'error' && current.plan && current.request)
      this.set(this.readyState(current.request, current.plan))
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
    const spend = plan ? this.spendFor(plan) : { cost: null, confirmRequired: false }
    this.set({
      status: 'error',
      ...(request ? { request } : {}),
      ...(plan ? { plan } : {}),
      cost: spend.cost,
      confirmRequired: spend.confirmRequired,
      generatedShots: plan ? this.generatedFor(plan).size : 0,
      unit: plan ? generatedUnit(plan) : 'shot',
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
