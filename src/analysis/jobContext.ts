import type { JobContext } from '../shared/jobs.ts'

/** A view of `ctx` whose progress fractions map onto `from`..`to` of the whole job. */
export function part(ctx: JobContext, from: number, to: number): JobContext {
  return {
    signal: ctx.signal,
    throwIfCancelled: () => ctx.throwIfCancelled(),
    progress: (p) =>
      ctx.progress(p.fraction === undefined ? p : { ...p, fraction: from + p.fraction * (to - from) }),
  }
}
