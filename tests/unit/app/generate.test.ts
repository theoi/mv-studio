import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GenerationRequest,
  GenerationResult,
  MediaGenerationProvider,
} from '../../../src/cloud/types.ts'
import { createProject, createTrack, createImageClip, type Asset } from '../../../src/model/index.ts'
import { PAID_RESULT_GRACE_MS } from '../../../src/cloud/media.ts'
import { jobs, JobError, type JobContext } from '../../../src/shared/jobs.ts'
import type * as cloudState from '../../../src/app/state/cloud.ts'
import { cloudSettings, spendLedger } from '../../../src/app/state/cloud.ts'
import {
  animateImage,
  gapAt,
  generateForm,
  generateInGap,
  generateOutcome,
  placementCommands,
  setGenerateForm,
  shotStart,
  spendCheck,
  startGenerate,
  undoOutcome,
} from '../../../src/app/state/generate.ts'
import { JOB_KINDS } from '../../../src/app/state/jobs.ts'
import { editor } from '../../../src/app/state/project.ts'
import { buildDemoProject, TRACK_IDS } from '../../../src/app/mock/demoProject.ts'
import { laneItemsAt } from '../../../src/app/screens/editor/timeline/laneMenu.ts'
import { toast } from '../../../src/app/state/ui.ts'

const fake = vi.hoisted(() => ({
  provider: undefined as MediaGenerationProvider | undefined,
  stored: 0,
}))

vi.mock('../../../src/app/state/ui.ts', () => ({
  get: () => ({ playhead: 12 }),
  set: vi.fn(),
  select: vi.fn(),
  toast: vi.fn(),
  editorPreset: vi.fn(),
  maybeStartGuide: vi.fn(),
  openAssist: vi.fn(),
}))

vi.mock('../../../src/app/state/cloud.ts', async (original) => ({
  ...(await original<typeof cloudState>()),
  cloudServices: async () => ({ generation: () => fake.provider }),
}))

vi.mock('../../../src/media/mediaStore.ts', () => ({
  OpfsMediaStore: class {},
  mediaStore: {
    getFile: async () => new Blob(),
    storeBlob: async (
      blob: Blob,
      info: Pick<Asset, 'kind' | 'name' | 'origin'>,
      ctx?: JobContext,
    ): Promise<Asset> => {
      // Like the real store, which checks for a cancel before it writes.
      ctx?.throwIfCancelled()
      return {
        id: `gen-${++fake.stored}`,
        kind: info.kind,
        name: info.name,
        origin: info.origin,
        mimeType: blob.type,
        byteSize: blob.size,
        storageKey: `media/gen-${fake.stored}`,
        createdAt: '2026-10-31T00:00:00.000Z',
      }
    },
  },
}))

function image(id: string): Asset {
  return {
    id,
    kind: 'image',
    name: id,
    mimeType: 'image/jpeg',
    byteSize: 1,
    storageKey: `media/${id}`,
    origin: { type: 'generated' },
    createdAt: '2026-10-31T00:00:00.000Z',
  }
}

function provider(progress: number[][] = [], failOnCall?: number): MediaGenerationProvider {
  let calls = 0
  return {
    id: 'fal',
    name: 'fal.ai',
    models: [],
    getModel: () => undefined,
    estimate: () => ({ usd: 0.003, approximate: false, breakdown: '1 MP × $0.003', pricesCheckedOn: '' }),
    validateKey: async () => ({ ok: true, message: '' }),
    async generate(request: GenerationRequest, ctx): Promise<GenerationResult> {
      if (calls + 1 === failOnCall) throw new Error('fal.ai is down')
      const seen: number[] = []
      progress.push(seen)
      ctx.progress({ stage: 'generate', fraction: 0.5, etaSeconds: 3 })
      seen.push(jobs.list().find((j) => j.kind === JOB_KINDS.generate)?.progress.fraction ?? -1)
      ctx.progress({ stage: 'download', fraction: 1 })
      seen.push(jobs.list().find((j) => j.kind === JOB_KINDS.generate)?.progress.fraction ?? -1)
      calls++
      return {
        requestId: `r${calls}`,
        modelId: request.modelId,
        task: request.task,
        media: [
          {
            kind: 'image',
            blob: new Blob(['x'], { type: 'image/jpeg' }),
            mimeType: 'image/jpeg',
            sourceUrl: '',
          },
        ],
        estimate: { usd: 0.003, approximate: false, breakdown: '', pricesCheckedOn: '' },
      }
    },
  }
}

function result(request: GenerationRequest, n: number): GenerationResult {
  const video = request.task !== 'text-to-image'
  return {
    requestId: `r${n}`,
    modelId: request.modelId,
    task: request.task,
    media: [
      {
        kind: video ? 'video' : 'image',
        blob: new Blob(['x'], { type: video ? 'video/mp4' : 'image/jpeg' }),
        mimeType: video ? 'video/mp4' : 'image/jpeg',
        sourceUrl: '',
      },
    ],
    estimate: { usd: 0.003, approximate: false, breakdown: '', pricesCheckedOn: '' },
  }
}

/** Like FalProvider: each request reports its stage and waits to be released, and a cancel that reaches it rejects it. */
function heldProvider(stages: string[] = []) {
  const release: (() => void)[] = []
  const held: MediaGenerationProvider = {
    ...provider(),
    async generate(request, ctx) {
      const n = release.length
      ctx.progress({ stage: stages[n] ?? 'generate', fraction: 0.5 })
      await new Promise<void>((resolve, reject) => {
        release.push(resolve)
        ctx.signal.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled')), {
          once: true,
        })
      })
      ctx.progress({ stage: 'download', fraction: 0.95, message: 'Downloading the video' })
      return result(request, n)
    },
  }
  return { held, release }
}

const runningJob = () => jobs.list().find((j) => j.kind === JOB_KINDS.generate && j.status === 'running')
const statusOf = (id: string) => jobs.list().find((j) => j.id === id)?.status
const generatedAssets = () => Object.keys(editor.getProject().assets).filter((id) => id.startsWith('gen-'))
const generatedClips = () =>
  Object.values(editor.getProject().clips).filter((c) => 'assetId' in c && c.assetId.startsWith('gen-'))
const toasts = () => vi.mocked(toast).mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.mocked(toast).mockClear()
  editor.load(createProject({ name: 'Test' }))
  cloudSettings.update({
    falKey: 'id:secret',
    alwaysConfirmPaid: false,
    confirmAboveUsd: 1,
    monthlyReminderUsd: 0,
  })
})

describe('placementCommands', () => {
  it('adds the assets and places them one after another, sharing a new track when every track is busy', () => {
    const project = createProject({ name: 'Busy' })
    const track = createTrack('visual', 'Video')
    const busy = createImageClip({ trackId: track.id, assetId: 'x', start: 0, duration: 60 })
    const withClip = {
      ...project,
      tracks: [...project.tracks.filter((t) => t.kind !== 'visual'), track],
      clips: { [busy.id]: busy },
    }
    const commands = placementCommands(withClip, [image('a'), image('b')], 10)
    expect(commands.map((c) => c.type)).toEqual([
      'asset.add',
      'track.add',
      'clip.add',
      'asset.add',
      'clip.add',
    ])
    const clips = commands.flatMap((c) => (c.type === 'clip.add' ? [c.clip] : []))
    expect(clips.map((c) => ['assetId' in c ? c.assetId : '', c.start])).toEqual([
      ['a', 10],
      ['b', 14],
    ])
    expect(clips[0]?.trackId).toBe(clips[1]?.trackId)
    expect(clips[0]?.trackId).not.toBe(track.id)
  })

  it('gives each run at a time where every track is taken its own numbered track: Video 2, then Video 3', () => {
    const project = createProject({ name: 'Busy' })
    const track = createTrack('visual', 'Video')
    const busy = createImageClip({ trackId: track.id, assetId: 'x', start: 0, duration: 60 })
    editor.load({
      ...project,
      tracks: [...project.tracks.filter((t) => t.kind !== 'visual'), track],
      clips: { [busy.id]: busy },
    })
    for (const id of ['a', 'b']) editor.dispatch(placementCommands(editor.getProject(), [image(id)], 12))
    const p = editor.getProject()
    const trackOf = (assetId: string) =>
      p.tracks.find((t) =>
        Object.values(p.clips).some((c) => 'assetId' in c && c.assetId === assetId && c.trackId === t.id),
      )
    expect([trackOf('a')?.name, trackOf('b')?.name]).toEqual(['Video 2', 'Video 3'])
  })
})

it('never puts media on the Lyrics track, even where it is free', () => {
  const project = buildDemoProject()
  const commands = placementCommands(project, [image('a')], 12)
  const clip = commands.flatMap((c) => (c.type === 'clip.add' ? [c.clip] : []))[0]
  expect(clip?.trackId).toBe(TRACK_IDS.overlay)
})

describe('spendCheck', () => {
  it('asks above the threshold, always when set, and when the monthly reminder would be crossed', () => {
    expect(spendCheck(0.2)).toBeNull()
    expect(spendCheck(1.5)).not.toBeNull()
    cloudSettings.update({ alwaysConfirmPaid: true })
    expect(spendCheck(0.2)).not.toBeNull()
    cloudSettings.update({ alwaysConfirmPaid: false, monthlyReminderUsd: spendLedger.monthTotal() + 0.1 })
    expect(spendCheck(0.2)).toMatchObject({ reminderUsd: spendLedger.monthTotal() + 0.1 })
  })
})

describe('startGenerate', () => {
  it('runs one job for several images, adds them at the playhead as one undo step, and records the spend', async () => {
    const progress: number[][] = []
    fake.provider = provider(progress)
    setGenerateForm({ kind: 'image', prompt: 'neon city', count: 2 })
    const before = spendLedger.monthTotal()
    await startGenerate()
    const job = jobs.list().find((j) => j.kind === JOB_KINDS.generate && j.status !== 'succeeded')
    expect(job).toBeDefined()
    await vi.waitFor(() => expect(jobs.list().find((j) => j.id === job?.id)?.status).toBe('succeeded'))

    // Each image's progress fills its own half of the bar.
    expect(progress[0]?.every((f) => f > 0 && f <= 0.5)).toBe(true)
    expect(progress[1]?.every((f) => f > 0.5 && f <= 1)).toBe(true)

    const project = editor.getProject()
    const clips = Object.values(project.clips).filter((c) => 'assetId' in c && c.assetId.startsWith('gen-'))
    expect(clips.map((c) => c.start).sort((a, b) => a - b)).toEqual([12, 16])
    expect(editor.undoLabel()).toBe('Generate 2 images')
    expect(spendLedger.monthTotal()).toBeCloseTo(before + 0.006, 6)

    const outcome = generateOutcome(job?.id)
    expect(outcome?.assets).toHaveLength(2)
    expect(undoOutcome(outcome!)).toBe(true)
    expect(Object.keys(editor.getProject().assets).some((id) => id.startsWith('gen-'))).toBe(false)
    expect(
      Object.values(editor.getProject().clips).some((c) => 'assetId' in c && c.assetId.startsWith('gen-')),
    ).toBe(false)
  })

  it('leaves the project unchanged when a later image fails, but still records what fal.ai charged', async () => {
    fake.provider = provider([], 2)
    setGenerateForm({ kind: 'image', prompt: 'neon city', count: 2 })
    const before = spendLedger.monthTotal()
    const clipsBefore = Object.keys(editor.getProject().clips).length
    await startGenerate()
    const job = jobs.list().find((j) => j.kind === JOB_KINDS.generate && j.status === 'running')
    expect(job).toBeDefined()
    await vi.waitFor(() => expect(jobs.list().find((j) => j.id === job?.id)?.status).toBe('failed'))
    expect(Object.keys(editor.getProject().clips)).toHaveLength(clipsBefore)
    expect(spendLedger.monthTotal()).toBeCloseTo(before + 0.003, 6)
  })

  it('keeps the images made before a failure in Media, as one undo step, and records them once', async () => {
    // The third of four requests fails at fal.ai.
    fake.provider = provider([], 3)
    setGenerateForm({ kind: 'image', prompt: 'neon city', count: 4, target: null })
    const before = spendLedger.monthTotal()
    await startGenerate()
    const job = runningJob()!
    await vi.waitFor(() => expect(statusOf(job.id)).toBe('failed'))
    expect(generatedAssets()).toHaveLength(2)
    expect(generatedClips()).toEqual([])
    expect(editor.undoLabel()).toBe('Generate 4 images')
    expect(spendLedger.monthTotal()).toBeCloseTo(before + 0.006, 6)
    expect(toasts()).toEqual(['Generation failed. 2\u00a0images made so far are kept in Media.'])
    // The failed view says the same, and one undo takes both out again.
    const kept = generateOutcome(job.id)!
    expect(kept.kept).toBe('2\u00a0images made so far are kept in Media.')
    expect(undoOutcome(kept)).toBe(true)
    expect(generatedAssets()).toEqual([])
  })
})

describe('a Cancel after fal.ai made something', () => {
  it('keeps a video whose download the Cancel lands in, in Media only, and records its price once', async () => {
    const { held, release } = heldProvider(['download'])
    fake.provider = held
    setGenerateForm({ kind: 'video', prompt: 'neon city', startImageId: null, target: null })
    const before = spendLedger.monthTotal()
    await startGenerate()
    const job = runningJob()!
    await vi.waitFor(() => expect(release).toHaveLength(1))
    jobs.cancel(job.id)
    // The Cancel took: the job's line says so while the paid video lands.
    expect(jobs.list().find((j) => j.id === job.id)?.progress).toMatchObject({
      stage: 'stopping',
      message: 'Stopping…',
    })
    release[0]!()
    await vi.waitFor(() => expect(statusOf(job.id)).toBe('cancelled'))
    expect(jobs.list().find((j) => j.id === job.id)?.progress).toMatchObject({
      stage: 'stopping',
      message: 'Stopping…',
    })
    expect(generatedAssets()).toHaveLength(1)
    expect(generatedClips()).toEqual([])
    expect(editor.undoLabel()).toBe('Generate video')
    expect(spendLedger.monthTotal()).toBeCloseTo(before + 0.003, 6)
    expect(toasts()).toEqual(['Generation stopped. The video is kept in Media.'])
  })

  it('keeps an image that came back just before the Cancel, saves it all the same, and asks for no more', async () => {
    let calls = 0
    fake.provider = {
      ...provider(),
      async generate(request, ctx) {
        ctx.progress({ stage: 'download', fraction: 1 })
        // The Cancel lands as the result comes back, before it is saved.
        queueMicrotask(() => jobs.cancel(runningJob()!.id))
        return result(request, calls++)
      },
    }
    setGenerateForm({ kind: 'image', prompt: 'neon city', count: 2, target: null })
    const before = spendLedger.monthTotal()
    await startGenerate()
    const job = runningJob()!
    await vi.waitFor(() => expect(statusOf(job.id)).toBe('cancelled'))
    expect(generatedAssets()).toHaveLength(1)
    expect(generatedClips()).toEqual([])
    expect(spendLedger.monthTotal()).toBeCloseTo(before + 0.003, 6)
    expect(toasts()).toEqual(['Generation stopped. 1\u00a0image made so far is kept in Media.'])
    expect(calls).toBe(1)
  })

  it('keeps the images made before the Cancel in a run of four, as one undo step, each charged once', async () => {
    const { held, release } = heldProvider()
    fake.provider = held
    setGenerateForm({ kind: 'image', prompt: 'neon city', count: 4, target: null })
    const before = spendLedger.monthTotal()
    await startGenerate()
    const job = runningJob()!
    for (const n of [1, 2]) {
      await vi.waitFor(() => expect(release).toHaveLength(n))
      release[n - 1]!()
    }
    await vi.waitFor(() => expect(release).toHaveLength(3))
    jobs.cancel(job.id)
    await vi.waitFor(() => expect(statusOf(job.id)).toBe('cancelled'))
    expect(generatedAssets()).toHaveLength(2)
    expect(generatedClips()).toEqual([])
    expect(spendLedger.monthTotal()).toBeCloseTo(before + 0.006, 6)
    expect(toasts()).toEqual(['Generation stopped. 2\u00a0images made so far are kept in Media.'])
    expect(editor.undoLabel()).toBe('Generate 4 images')
    expect(editor.undo()).toBe(true)
    expect(generatedAssets()).toEqual([])
  })

  it('gives up on a download still stalled 30 s after the Cancel, and still records what fal.ai billed', async () => {
    const { held, release } = heldProvider(['download'])
    fake.provider = held
    setGenerateForm({ kind: 'image', prompt: 'neon city', count: 1, target: null })
    const before = spendLedger.monthTotal()
    await startGenerate()
    const job = runningJob()!
    await vi.waitFor(() => expect(release).toHaveLength(1))
    vi.useFakeTimers()
    try {
      jobs.cancel(job.id)
      await vi.advanceTimersByTimeAsync(PAID_RESULT_GRACE_MS - 1)
      expect(statusOf(job.id)).toBe('running')
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(statusOf(job.id)).toBe('cancelled'))
    expect(generatedAssets()).toEqual([])
    expect(spendLedger.monthTotal()).toBeCloseTo(before + 0.003, 6)
    expect(toasts()).toEqual([])
  })

  it('says nothing and changes nothing when the Cancel stops the only request before fal.ai finished', async () => {
    const { held, release } = heldProvider()
    fake.provider = held
    setGenerateForm({ kind: 'image', prompt: 'neon city', count: 1, target: null })
    const before = spendLedger.monthTotal()
    await startGenerate()
    const job = runningJob()!
    await vi.waitFor(() => expect(release).toHaveLength(1))
    jobs.cancel(job.id)
    await vi.waitFor(() => expect(statusOf(job.id)).toBe('cancelled'))
    expect(generatedAssets()).toEqual([])
    expect(spendLedger.monthTotal()).toBeCloseTo(before, 6)
    expect(toasts()).toEqual([])
  })
})

describe('a shot in a gap of the timeline', () => {
  const overlay = () =>
    Object.values(editor.getProject().clips).filter((c) => c.trackId === TRACK_IDS.overlay)

  it('finds the empty stretch around a time, and none on a clip', () => {
    const project = buildDemoProject()
    // The title ends at 0:09 and the first spectrum starts at 1:04.
    expect(gapAt(project, TRACK_IDS.overlay, 30)).toEqual({ start: 9, end: 64 })
    expect(gapAt(project, TRACK_IDS.overlay, 70)).toBeNull()
    expect(gapAt(project, TRACK_IDS.overlay, 300)).toMatchObject({ end: Infinity })
  })

  it('starts at the gap when right-clicked near its start, else on the nearest beat', () => {
    const project = buildDemoProject()
    const gap = { start: 9, end: 64 }
    expect(shotStart(project, gap, 9.3)).toBe(9)
    // The sample is at 120 BPM: beats every half second.
    expect(shotStart(project, gap, 30.2)).toBeCloseTo(30, 6)
    expect(shotStart(project, gap, 30.4)).toBeCloseTo(30.5, 6)
  })

  it('places results on the gap’s track trimmed to the gap, then on the first free track once the gap is full', () => {
    const project = buildDemoProject()
    const commands = placementCommands(project, [image('a'), image('b')], 61, {
      trackId: TRACK_IDS.overlay,
      end: 64,
    })
    const clips = commands.flatMap((c) => (c.type === 'clip.add' ? [c.clip] : []))
    expect(clips[0]).toMatchObject({ trackId: TRACK_IDS.overlay, start: 61, duration: 3 })
    expect(clips[1]?.start).toBe(64)
    expect(clips[1]?.trackId).not.toBe(TRACK_IDS.overlay)
  })

  it('Generate a shot here lands the result in the gap, and the next run goes to the playhead again', async () => {
    editor.load(buildDemoProject())
    fake.provider = provider()
    setGenerateForm({ kind: 'image', prompt: 'neon rain', count: 1 })
    generateInGap(TRACK_IDS.overlay, 61.1)
    expect(generateForm().target).toMatchObject({ start: 61, trackId: TRACK_IDS.overlay, end: 64 })
    const before = overlay().length
    await startGenerate()
    await vi.waitFor(() => expect(generateForm().target).toBeNull())
    const added = overlay().filter((c) => 'assetId' in c && c.assetId.startsWith('gen-'))
    expect(overlay()).toHaveLength(before + 1)
    expect(added).toMatchObject([{ start: 61, duration: 3 }])
  })
})

describe('Animate with AI', () => {
  it('makes a video from the image that lands at the image’s start', () => {
    const project = buildDemoProject()
    editor.load(project)
    const clip = Object.values(project.clips).find((c) => c.type === 'image')
    if (clip?.type !== 'image') throw new Error('The sample has no image clip')
    setGenerateForm({ kind: 'image', startImageId: null })
    animateImage(clip)
    expect(generateForm()).toMatchObject({
      kind: 'video',
      startImageId: clip.assetId,
      target: { start: clip.start },
    })
  })
})

describe('the lane menu', () => {
  const spot = (trackId: string, time: number) => laneItemsAt(buildDemoProject(), { trackId, time })

  it('offers Generate a shot here on an empty stretch of a video or overlay track only, after Paste here', () => {
    const labels = (trackId: string, time: number) => spot(trackId, time).map((i) => i.label)
    expect(labels(TRACK_IDS.overlay, 30)).toEqual(['Paste here', 'Generate a shot here'])
    expect(labels(TRACK_IDS.overlay, 70)).toEqual(['Paste here'])
    expect(labels(TRACK_IDS.lyrics, 2)).toEqual(['Paste here'])
    expect(labels(TRACK_IDS.song, 30)).toEqual(['Paste here'])
  })

  it('shows Paste here disabled until clips are copied', () => {
    const project = buildDemoProject()
    const at = { trackId: TRACK_IDS.overlay, time: 30 }
    const paste = laneItemsAt(project, at).find((i) => i.label === 'Paste here')
    expect(paste?.disabled?.(project, at)).toBe(true)
    expect(paste?.description?.(project, at)).toBe('Copy clips first')
  })

  it('says when fal.ai is missing, and why a locked track can’t take a shot', () => {
    const project = buildDemoProject()
    const at = { trackId: TRACK_IDS.overlay, time: 30.2 }
    const item = laneItemsAt(project, at).find((i) => i.label === 'Generate a shot here')
    expect(item?.description?.(project, at)).toBe('AI image or clip at 0:30')
    cloudSettings.update({ falKey: '' })
    expect(item?.description?.(project, at)).toBe('AI image or clip at 0:30 · needs fal.ai')
    expect(item?.disabled?.(project, at)).toBe(false)
    const locked = {
      ...project,
      tracks: project.tracks.map((t) => (t.id === TRACK_IDS.overlay ? { ...t, locked: true } : t)),
    }
    expect(item?.description?.(locked, at)).toBe('The track is locked')
    expect(item?.disabled?.(locked, at)).toBe(true)
  })
})
