import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  analysisReady,
  checkClipsForBlank,
  clipTags,
  footageDownloadNote,
  holdAnalysisUntil,
  holdAnalysisWhile,
  waitForMatching,
} from '../../../src/app/state/footage.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { VISION_ANALYSIS_VERSION } from '../../../src/vision/analysisData.ts'
import type { AssetIndexStatus, IndexingState } from '../../../src/vision/index.ts'

beforeEach(() => loadDemoProject())

const setTags = (assetId: string, tags: string[]) =>
  editor.dispatch(
    {
      type: 'analysis.setVisual',
      analysis: { assetId, version: VISION_ANALYSIS_VERSION, data: { duration: 4, tags } },
    },
    { history: 'skip' },
  )

it('says how far the model footage analysis downloads is, and that the clips are analyzed next', () => {
  const downloading: IndexingState = {
    status: 'indexing',
    total: 10,
    done: 0,
    failed: [],
    download: { message: 'Downloading the footage tagger (154 MB, once)', fraction: 0.4 },
  }
  expect(footageDownloadNote(downloading)).toBe(
    'Downloading the footage tagger (154 MB, once)… 40%. Your clips are analyzed next.',
  )
  expect(footageDownloadNote({ ...downloading, done: 3 })).toBe(
    'Downloading the footage tagger (154 MB, once)… 40%. The rest of your clips are analyzed next.',
  )
  const { download: _, ...analyzing } = downloading
  expect(footageDownloadNote(analyzing)).toBeUndefined()
  expect(footageDownloadNote({ ...downloading, status: 'paused' })).toBeUndefined()
})

it('shows the tags footage analysis stored, at most five, over the sample’s own descriptions', () => {
  const sample = clipTags(editor.getProject(), 'm-city')
  expect(sample.length).toBeGreaterThan(0)
  setTags('m-city', ['crowd', 'lights', 'night', 'energetic', 'fast', 'extra'])
  expect(clipTags(editor.getProject(), 'm-city')).toEqual(['crowd', 'lights', 'night', 'energetic', 'fast'])
  setTags('m-city', [])
  expect(clipTags(editor.getProject(), 'm-city')).toEqual([])
})

it('has no tags for a clip of the user’s own until it is analyzed', () => {
  editor.dispatch({
    type: 'asset.add',
    asset: {
      id: 'mine',
      kind: 'video',
      name: 'mine.mp4',
      mimeType: 'video/mp4',
      byteSize: 1,
      storageKey: 'media/mine',
      duration: 3,
      width: 640,
      height: 360,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
    },
  })
  expect(clipTags(editor.getProject(), 'mine')).toEqual([])
  setTags('mine', ['city'])
  expect(clipTags(editor.getProject(), 'mine')).toEqual(['city'])
})

it('starts no blank check for the sample’s own clips, which are drawn and never blank', () => {
  const project = editor.getProject()
  expect(Object.values(project.assets).some((a) => a.kind === 'video' || a.kind === 'image')).toBe(true)
  expect(checkClipsForBlank()).toBeUndefined()
})

/** An indexer that updates only when the test says so. */
function fakeIndexer(statuses: Record<string, AssetIndexStatus>) {
  const listeners = new Set<(s: IndexingState) => void>()
  const indexer = {
    statuses,
    cancelled: 0,
    subscribe(listener: (s: IndexingState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    statusOf: (id: string) => statuses[id] ?? 'queued',
    cancel() {
      indexer.cancelled++
    },
    update(state: Partial<IndexingState> = {}) {
      for (const l of [...listeners]) l({ status: 'indexing', total: 2, done: 0, failed: [], ...state })
    },
    listening: () => listeners.size,
  }
  return indexer
}

it('waits until every clip asked for is matched or failed, or analysis stops', async () => {
  const indexer = fakeIndexer({ a: 'queued', b: 'queued', other: 'queued' })
  let done = false
  const wait = waitForMatching(indexer, ['a', 'b']).then(() => (done = true))
  indexer.statuses.a = 'indexed'
  indexer.update({ done: 1 })
  await Promise.resolve()
  expect(done).toBe(false)
  indexer.statuses.b = 'failed'
  indexer.update({ done: 1 })
  await wait
  expect(indexer.listening()).toBe(0)

  const stopped = waitForMatching(indexer, ['other'])
  indexer.update({ status: 'paused' })
  await stopped
  expect(indexer.listening()).toBe(0)
})

it('stops waiting on abort, and cancels the analysis only when the wait started it', async () => {
  for (const cancelOnAbort of [true, false]) {
    const indexer = fakeIndexer({ a: 'queued' })
    const controller = new AbortController()
    const wait = waitForMatching(indexer, ['a'], { signal: controller.signal, cancelOnAbort })
    controller.abort()
    await expect(wait).rejects.toMatchObject({ code: 'cancelled' })
    expect(indexer.cancelled).toBe(cancelOnAbort ? 1 : 0)
    expect(indexer.listening()).toBe(0)
  }
})

describe('holding footage analysis', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Whether `promise` has resolved, once pending callbacks have run. */
  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false
    void promise.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    return done
  }

  it('makes its next frame wait until the hold’s work is done, or has failed', async () => {
    vi.useFakeTimers()
    expect(await settled(analysisReady())).toBe(true)
    let finish = () => {}
    holdAnalysisUntil(new Promise<void>((resolve) => (finish = resolve)))
    const waiting = analysisReady()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await settled(waiting)).toBe(false)
    finish()
    expect(await settled(waiting)).toBe(true)
    let fail = (_error: Error) => {}
    holdAnalysisUntil(new Promise<void>((_, reject) => (fail = reject)))
    const failing = analysisReady()
    expect(await settled(failing)).toBe(false)
    fail(new Error('The draft failed'))
    expect(await settled(failing)).toBe(true)
  })

  it('waits 5 s at most for a hold unless told otherwise, and for holds made while it waits', async () => {
    vi.useFakeTimers()
    holdAnalysisUntil(new Promise(() => undefined))
    const waiting = analysisReady()
    await vi.advanceTimersByTimeAsync(3_000)
    holdAnalysisUntil(new Promise(() => undefined), 4_000)
    // The first hold is over at 5 s; the second goes on until 7 s.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await settled(waiting)).toBe(false)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(await settled(waiting)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(waiting)).toBe(true)
    expect(await settled(analysisReady())).toBe(true)
  })

  it('holds while a still is pending, 5 s at most each time, and not again until it is no longer pending', async () => {
    vi.useFakeTimers()
    let pending = false
    const listeners = new Set<() => void>()
    const setPending = (next: boolean) => {
      pending = next
      for (const listener of listeners) listener()
    }
    const stop = holdAnalysisWhile(
      () => pending,
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    )
    expect(await settled(analysisReady())).toBe(true)
    setPending(true)
    const waiting = analysisReady()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await settled(waiting)).toBe(false)
    setPending(false)
    expect(await settled(waiting)).toBe(true)

    // A seek that never ends: held for 5 s, then not while it stays pending, though the stage says so again.
    setPending(true)
    const long = analysisReady()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(await settled(long)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(long)).toBe(true)
    setPending(true)
    expect(await settled(analysisReady())).toBe(true)

    // The next still pending after it is held again, until stop.
    setPending(false)
    setPending(true)
    const next = analysisReady()
    expect(await settled(next)).toBe(false)
    stop()
    expect(await settled(next)).toBe(true)
    setPending(false)
    setPending(true)
    expect(await settled(analysisReady())).toBe(true)
  })
})
