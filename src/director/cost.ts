/**
 * What a plan would cost before anything is spent: one generation request per AI shot (shots with `sameAs` reuse
 * another result for free, and media already generated with the same prompt and model is reused too).
 */
import { needsSpendConfirmation, roundUsd, sumCosts, type CostSummary } from '../cloud/pricing.ts'
import type { GenerationRequest, MediaGenerationProvider } from '../cloud/types.ts'
import type { Asset, Id, Project } from '../model/types.ts'
import { shotsToGenerate, type EditPlan, type GenerateSource, type PlanShot } from './plan.ts'

export interface ShotRequest {
  shot: PlanShot & { source: GenerateSource }
  request: GenerationRequest
  /** An asset in the project made from the same request, used instead of paying again. */
  reuse?: Asset
}

/** The paid shots made with one model. */
export interface ModelCost {
  modelId: string
  /** The provider's name for it ("FLUX.1 schnell"), or its id when the provider doesn't know it. */
  name: string
  kind: 'image' | 'clip'
  count: number
  usd: number
}

export interface PlanCost extends CostSummary {
  /** Shots that will be generated (and paid for). */
  requests: ShotRequest[]
  /** Shots covered by media generated earlier. */
  reused: number
  /** The paid shots by model, the most expensive first. */
  byModel: ModelCost[]
}

/** Stable request seeds so a re-run of the same plan asks for the same pictures. */
function requestSeed(planSeed: number, index: number): number {
  return Math.abs((planSeed * 7919 + index * 104729) % 2147483647)
}

export function generationRequest(
  plan: EditPlan,
  shot: PlanShot & { source: GenerateSource },
  index: number,
): GenerationRequest {
  const s = shot.source
  return {
    task: s.task,
    modelId: s.modelId,
    prompt: s.prompt,
    aspect: plan.aspect,
    ...(s.task !== 'text-to-image'
      ? { duration: s.duration ?? Math.round((shot.end - shot.start) * 10) / 10 }
      : {}),
    seed: requestSeed(plan.seed, index),
  }
}

/** A generated asset in the project with the same model and prompt, so re-running a plan does not pay twice. */
export function findReusableAsset(
  project: Project | undefined,
  request: GenerationRequest,
  exclude?: Set<Id>,
): Asset | undefined {
  if (!project) return undefined
  const kind = request.task === 'text-to-image' ? 'image' : 'video'
  return Object.values(project.assets).find(
    (a) =>
      a.kind === kind &&
      a.origin.type === 'generated' &&
      a.origin.provider === request.modelId &&
      a.origin.prompt === request.prompt &&
      !exclude?.has(a.id) &&
      (kind === 'image' || (a.duration ?? 0) >= (request.duration ?? 0) - 0.5),
  )
}

export function planRequests(plan: EditPlan, project?: Project): ShotRequest[] {
  const used = new Set<Id>()
  return shotsToGenerate(plan).map((shot, i) => {
    const request = generationRequest(plan, shot, i)
    const reuse = findReusableAsset(project, request, used)
    if (reuse) used.add(reuse.id)
    return { shot, request, ...(reuse ? { reuse } : {}) }
  })
}

export function estimatePlanCost(
  plan: EditPlan,
  provider: Pick<MediaGenerationProvider, 'estimate'> & Partial<Pick<MediaGenerationProvider, 'getModel'>>,
  project?: Project,
): PlanCost {
  const all = planRequests(plan, project)
  const requests = all.filter((r) => !r.reuse)
  const items = requests.map((r) => ({
    label: r.shot.label ?? r.request.prompt.slice(0, 40),
    estimate: provider.estimate(r.request),
  }))
  const byModel = new Map<string, ModelCost>()
  requests.forEach((r, i) => {
    const { modelId, task } = r.request
    const group = byModel.get(modelId) ?? {
      modelId,
      name: provider.getModel?.(modelId)?.name ?? modelId,
      kind: task === 'text-to-image' ? ('image' as const) : ('clip' as const),
      count: 0,
      usd: 0,
    }
    group.count++
    group.usd = roundUsd(group.usd + (items[i]?.estimate.usd ?? 0))
    byModel.set(modelId, group)
  })
  return {
    ...sumCosts(items),
    requests,
    reused: all.length - requests.length,
    byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd),
  }
}

export interface SpendPolicy {
  alwaysConfirmPaid: boolean
  confirmAboveUsd: number
  monthlyReminderUsd: number
}

/** True when the user must confirm the spend first (their threshold, or crossing their monthly reminder). */
export function requiresConfirmation(
  usd: number,
  policy: SpendPolicy,
  ledger?: { crossesReminder(usd: number, monthlyReminderUsd: number): boolean },
): boolean {
  if (!(usd > 0)) return false
  return needsSpendConfirmation(usd, policy) || !!ledger?.crossesReminder(usd, policy.monthlyReminderUsd)
}
