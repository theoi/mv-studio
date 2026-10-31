import type { JobContext } from '../shared/jobs.ts'

/**
 * A view of `ctx` whose progress fractions map onto `from`..`to` of the whole job. `laterSeconds`, the expected
 * time of the steps after this part, is added to its remaining-time estimates.
 */
export function part(ctx: JobContext, from: number, to: number, laterSeconds = 0): JobContext {
  return {
    signal: ctx.signal,
    throwIfCancelled: () => ctx.throwIfCancelled(),
    progress: (p) =>
      ctx.progress({
        ...p,
        ...(p.fraction === undefined ? {} : { fraction: from + p.fraction * (to - from) }),
        ...(p.etaSeconds === undefined ? {} : { etaSeconds: p.etaSeconds + laterSeconds }),
      }),
  }
}
