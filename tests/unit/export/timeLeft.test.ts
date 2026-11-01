import { describe, expect, it, vi } from 'vitest'
import type * as Export from '../../../src/engine/export.ts'
import type { ExportOptions } from '../../../src/engine/export.ts'
import type { ExpectedTime } from '../../../src/engine/exportTime.ts'
import { exportOutputs, newOutput, type ExportPaceStore } from '../../../src/export/index.ts'
import { createProject, createSolidClip } from '../../../src/model/index.ts'
import type { JobContext, JobProgress } from '../../../src/shared/jobs.ts'

const h = vi.hoisted(() => ({
  /** What each output's export reports, in order. */
  reports: [] as JobProgress[][],
  expected: [] as (ExpectedTime | undefined)[],
}))

vi.mock('../../../src/engine/export.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Export>()),
  exportProject: async (_project: unknown, _settings: unknown, ctx: JobContext, options: ExportOptions) => {
    const i = h.expected.length
    h.expected.push(options.expected)
    for (const report of h.reports[i] ?? []) ctx.progress(report)
    return { file: new File([], 'out.mp4'), durationSeconds: 60, videoCodec: 'avc', audioCodec: 'none' }
  },
}))

const measure = (text: string, font: string) => text.length * Number(/([\d.]+)px/.exec(font)?.[1]) * 0.5
const noPaces: ExportPaceStore = { get: () => undefined, set: () => undefined }

function project() {
  const p = createProject({ name: 'Time left' })
  const solid = createSolidClip({ trackId: p.tracks[0]!.id, color: '#333333', start: 0, duration: 60 })
  p.clips[solid.id] = solid
  p.duration = 60
  return p
}

async function timesLeft(estimates: (seconds: number | undefined, i: number) => number | undefined) {
  const p = project()
  const specs = [newOutput(p, 'video'), newOutput(p, 'video', { aspect: '9:16' })]
  const expected: ExpectedTime = { seconds: 400 }
  h.expected = []
  h.reports = [
    [
      { stage: 'prepare', fraction: 0 },
      { stage: 'mix', fraction: 0.01 },
      // A render without a trial's expected time says nothing over its first frames.
      { stage: 'render', fraction: 0.05 },
      { stage: 'render', fraction: 0.5, etaSeconds: 300 },
      { stage: 'finalize', fraction: 0.99 },
    ],
    [
      { stage: 'prepare', fraction: 0 },
      { stage: 'render', fraction: 0.5, etaSeconds: 30 },
    ],
  ]
  const seen: (number | undefined)[] = []
  const ctx: JobContext = {
    signal: new AbortController().signal,
    progress: (p) => void seen.push(p.etaSeconds),
    throwIfCancelled: () => undefined,
  }
  const own = [600, 120]
  const known = specs.flatMap((spec, i) => {
    const seconds = estimates(own[i], i)
    return seconds === undefined ? [] : [[spec.id, { seconds, ...(i === 0 ? { expected } : {}) }] as const]
  })
  await exportOutputs(p, specs, ctx, { measure, pace: noPaces, estimates: Object.fromEntries(known) })
  return { seen, expected: h.expected, trial: expected }
}

describe('the time left in an export of several files', () => {
  it("is the rendering file's own time left plus the estimates of the files after it", async () => {
    const r = await timesLeft((seconds) => seconds)
    expect(r.seen).toEqual([600 + 120, 600 + 120, undefined, 300 + 120, 120, 120, 30])
    // The first file's export starts its time left from what its trial expected.
    expect(r.expected).toEqual([r.trial, undefined])
  })

  it('shows none while a file after the one rendering has no estimate', async () => {
    const r = await timesLeft((seconds, i) => (i === 1 ? undefined : seconds))
    expect(r.seen).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 30])
  })
})
