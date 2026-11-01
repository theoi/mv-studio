import { beforeEach, expect, it } from 'vitest'
import {
  checkClipsForBlank,
  clipTags,
  footageDownloadNote,
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
