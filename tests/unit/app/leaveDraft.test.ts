import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerLeaveDraft,
  holdDrafts,
  leaveDraftOk,
  leaveDraftText,
  leaveDraftThen,
  useLeaveDraft,
  type HeldDraft,
} from '../../../src/app/state/leaveDraft.ts'

const unapplied: HeldDraft = { kind: 'unapplied', unit: 'clip', made: 3, missing: 5 }

describe('leaving a project the Director’s draft still needs', () => {
  let held: HeldDraft | null
  let apply: () => Promise<boolean>

  beforeEach(() => {
    held = null
    apply = () => Promise.resolve(true)
    holdDrafts({ held: () => held, apply: () => apply() })
    useLeaveDraft.setState({ ask: null, applying: false })
  })

  it('goes on at once when no draft would be lost', async () => {
    const leave = vi.fn()
    leaveDraftThen(leave)
    expect(leave).toHaveBeenCalledOnce()
    expect(useLeaveDraft.getState().ask).toBeNull()
    await expect(leaveDraftOk()).resolves.toBe(true)
  })

  it('asks first, and Stay keeps the project open', async () => {
    held = unapplied
    const ok = leaveDraftOk()
    expect(useLeaveDraft.getState().ask?.held).toEqual(unapplied)
    await answerLeaveDraft('stay')
    await expect(ok).resolves.toBe(false)
    expect(useLeaveDraft.getState().ask).toBeNull()
  })

  it('Leave anyway goes on without applying', async () => {
    held = unapplied
    const applied = vi.fn(() => Promise.resolve(true))
    apply = applied
    const ok = leaveDraftOk()
    await answerLeaveDraft('leave')
    await expect(ok).resolves.toBe(true)
    expect(applied).not.toHaveBeenCalled()
  })

  it('Apply and leave goes on once the draft is on the timeline, and stays when it couldn’t be applied', async () => {
    held = unapplied
    const first = leaveDraftOk()
    const answered = answerLeaveDraft('apply')
    expect(useLeaveDraft.getState().applying).toBe(true)
    await answered
    await expect(first).resolves.toBe(true)

    apply = () => Promise.resolve(false)
    const second = leaveDraftOk()
    await answerLeaveDraft('apply')
    await expect(second).resolves.toBe(false)
    expect(useLeaveDraft.getState()).toEqual({ ask: null, applying: false })
  })

  it('a second question answers the first with Stay', async () => {
    held = unapplied
    const first = leaveDraftOk()
    const second = leaveDraftOk()
    await expect(first).resolves.toBe(false)
    await answerLeaveDraft('leave')
    await expect(second).resolves.toBe(true)
  })
})

describe('what the question says', () => {
  it('a draft not on the timeline: what is lost, that its AI shots stay in Media, and what applying keeps', () => {
    expect(leaveDraftText(unapplied)).toEqual({
      title: 'Your draft isn’t on the timeline yet',
      text: 'If you leave, the Director’s draft is gone. Its 3 AI clips stay in Media, but drafting again may pay for new ones. Applying keeps it, with placeholders for the 5 clips not made yet.',
      apply: 'Apply and leave',
    })
    expect(leaveDraftText({ kind: 'unapplied', unit: 'shot', made: 1, missing: 0 }).text).toBe(
      'If you leave, the Director’s draft is gone. Its 1 AI shot stays in Media, but drafting again may pay for new ones.',
    )
  })

  it('failed shots waiting for Retry: no apply, since the draft is already on the timeline', () => {
    expect(leaveDraftText({ kind: 'failed', unit: 'clip', failed: 2 })).toEqual({
      title: '2 AI clips still need a retry',
      text: 'If you leave, Retry is gone: making them later means drafting again, which may pay for new clips. The clips already made stay on the timeline and in Media.',
    })
    expect(leaveDraftText({ kind: 'failed', unit: 'shot', failed: 1 }).title).toBe(
      '1 AI shot still needs a retry',
    )
  })
})
