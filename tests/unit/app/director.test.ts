import { describe, expect, it } from 'vitest'
import { directorRequest, draftProgress } from '../../../src/app/state/director.ts'
import { JOB_KINDS } from '../../../src/app/state/jobs.ts'
import type { JobSnapshot } from '../../../src/shared/jobs.ts'

const job = (
  kind: string,
  fraction: number | undefined,
  stage?: string,
  status: JobSnapshot['status'] = 'running',
) => ({ id: kind, kind, title: kind, status, progress: { fraction, stage } }) as JobSnapshot

describe('draftProgress', () => {
  it('shows the song analysis’s progress while the draft waits for it, as the top bar does', () => {
    const draft = job('director.plan', 0.09, 'song')
    const analysis = job(JOB_KINDS.analysis, 0.35)
    expect(draftProgress(draft, [analysis, draft])?.progress).toEqual({ fraction: 0.35, stage: 'song' })
  })

  it('shows the draft’s own progress in its other stages, or without a running analysis', () => {
    const planning = job('director.plan', 0.4, 'plan')
    const waiting = job('director.plan', 0.2, 'song')
    const analysis = job(JOB_KINDS.analysis, 0.35)
    expect(draftProgress(planning, [analysis, planning])).toBe(planning)
    expect(draftProgress(waiting, [job(JOB_KINDS.analysis, 1, undefined, 'succeeded'), waiting])).toBe(
      waiting,
    )
    expect(draftProgress(undefined, [analysis])).toBeUndefined()
  })
})

describe('directorRequest', () => {
  it('asks for AI video clips or images as chosen, and for none with My clips', () => {
    expect(directorRequest('neon city', 'gen', 'video')).toMatchObject({
      prompt: 'neon city',
      useMedia: false,
      generate: { mode: 'video', tier: 'draft' },
    })
    expect(directorRequest('', 'mix', 'video').generate?.mode).toBe('video')
    expect(directorRequest('', 'mix').generate?.mode).toBe('images')
    expect(directorRequest('', 'mine', 'video').generate).toBeUndefined()
  })
})
