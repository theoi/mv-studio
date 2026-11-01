import { describe, expect, it, vi } from 'vitest'
import { ProjectEditor } from '../../../../src/model/editor.ts'
import type { Asset, Project } from '../../../../src/model/types.ts'
import { JobError, JobRunner } from '../../../../src/shared/jobs.ts'
import {
  hasBlankVerdict,
  isBlankClip,
  readClipIndex,
  readClipTags,
  readSubjectTrack,
} from '../../../../src/vision/analysisData.ts'
import {
  createFootageService,
  FOOTAGE_INDEX_JOB,
  STRONG_MATCH,
} from '../../../../src/vision/footage/service.ts'
import type { ModelDownload } from '../../../../src/vision/runtime/downloads.ts'
import type { FrameSource } from '../../../../src/vision/runtime/frames.ts'
import type { SubjectTrack } from '../../../../src/vision/types.ts'
import { CLIPS, clipIndex, fakeMatcher, makeProject, TOPICS } from '../autocut/fixtures.ts'

function videoAsset(id: string, duration = 10): Asset {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    mimeType: 'video/mp4',
    byteSize: 1,
    storageKey: id,
    duration,
    width: 1280,
    height: 720,
    origin: { type: 'import' },
    createdAt: new Date(Date.now()).toISOString(),
  }
}

type TaskArg = { signal?: AbortSignal; onProgress?: (p: { fraction?: number }) => void; fps?: number }

/** Subjects found in a clip: a face, or nobody when the clip id says so. */
function subjectTrack(source: FrameSource): SubjectTrack {
  const nobody = source.mediaId.includes('nobody')
  return {
    version: 1,
    mediaId: source.mediaId,
    sourceSize: { width: source.width, height: source.height },
    samples: [
      {
        t: 0,
        focus: { x: 0.5, y: 0.4 },
        box: nobody ? null : { x: 0.3, y: 0.2, width: 0.4, height: 0.7 },
        confidence: nobody ? 0 : 0.9,
        source: nobody ? 'none' : 'face',
      },
    ],
  }
}

/**
 * A vision stand-in whose indexing waits until the test releases each clip (`release(id)`). Subject tracking
 * finishes at once unless `gateSubjects` is set; then it waits for `release(\`${id}:subjects\`)`. With
 * `peakLuma`, the fast blank check reads a clip's brightest luma from it (throwing fails the clip's check), and with
 * `gateBlank` it waits for `release(\`${id}:blank\`)`.
 */
function setup(
  project: Project = makeProject({ clips: CLIPS.map((c) => ({ ...c, indexed: false })) }),
  options: { gateSubjects?: boolean; peakLuma?: (id: string) => number; gateBlank?: boolean } = {},
) {
  const editor = new ProjectEditor(project)
  const jobs = new JobRunner()
  const matcher = fakeMatcher()
  const gates = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>()
  const started: string[] = []
  const disposed: string[] = []
  const gate = (key: string, o: TaskArg) =>
    new Promise<void>((resolve, reject) => {
      gates.set(key, { resolve, reject })
      o.signal?.addEventListener('abort', () => {
        gates.delete(key)
        reject(new JobError('cancelled', 'Cancelled'))
      })
    })
  const indexClip = vi.fn(async (source: FrameSource, o: TaskArg = {}) => {
    started.push(source.mediaId)
    o.onProgress?.({ fraction: 0.5 })
    await gate(source.mediaId, o)
    const topic = Object.keys(TOPICS).find((t) => source.mediaId.includes(t))
    return clipIndex(source.mediaId, source.duration, topic ? (TOPICS[topic] as number) : null, 2)
  })
  const subjects = vi.fn(async (source: FrameSource, o: TaskArg = {}) => {
    o.onProgress?.({ fraction: 0.5 })
    if (options.gateSubjects) await gate(`${source.mediaId}:subjects`, o)
    return subjectTrack(source)
  })
  const peakLuma = vi.fn(async (source: FrameSource, o: { frames?: number } = {}) => {
    started.push(`${source.mediaId}:blank`)
    if (options.gateBlank) await gate(`${source.mediaId}:blank`, {})
    void o
    return options.peakLuma!(source.mediaId)
  })
  let downloads: ((d: ModelDownload) => void) | undefined
  const watchDownloads = (listener: (d: ModelDownload) => void) => {
    downloads = listener
    return () => {
      downloads = undefined
    }
  }
  const service = createFootageService({
    editor,
    vision: {
      matcher,
      indexClip,
      subjects,
      watchDownloads,
      ...(options.peakLuma ? { peakLuma } : {}),
    } as never,
    media: { getFile: async () => new Blob() },
    jobs,
    frameSource: async (asset) => ({
      mediaId: asset.id,
      width: asset.width ?? 1,
      height: asset.height ?? 1,
      duration: asset.duration ?? 1,
      frameRate: 30,
      frameAt: () => Promise.reject(new Error('not used')),
      dispose: () => void disposed.push(asset.id),
    }),
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const release = async (id: string, error?: unknown) => {
    for (let i = 0; i < 20 && !gates.has(id); i++) await tick()
    const gate = gates.get(id)
    if (!gate) throw new Error(`${id} never started`)
    gates.delete(id)
    if (error) gate.reject(error)
    else gate.resolve()
    await tick()
    await tick()
  }
  const indexed = () =>
    Object.keys(editor.getProject().analysis.visual).filter((id) =>
      readClipIndex(editor.getProject().analysis.visual[id]),
    )
  const download = (d: ModelDownload) => downloads?.(d)
  return {
    editor,
    jobs,
    service,
    started,
    disposed,
    release,
    tick,
    indexed,
    indexClip,
    subjects,
    peakLuma,
    download,
  }
}

describe('background footage analysis', () => {
  it('analyzes every clip in one job, without adding undo steps', async () => {
    const { editor, jobs, service, release, indexed, disposed } = setup()
    editor.dispatch({ type: 'project.rename', name: 'Before' })
    const stop = service.indexing.start()
    await new Promise((r) => setTimeout(r, 0))
    expect(service.indexing.getState()).toMatchObject({ status: 'indexing', total: 4, done: 0 })
    expect(service.indexing.statusOf('city')).toBe('indexing')
    expect(service.indexing.statusOf('ocean')).toBe('queued')
    for (const id of ['city', 'ocean', 'crowd', 'misc']) await release(id)
    expect(indexed().sort()).toEqual(['city', 'crowd', 'misc', 'ocean'])
    expect(service.indexing.getState().status).toBe('idle')
    expect(service.indexing.statusOf('misc')).toBe('indexed')
    expect(
      jobs
        .list()
        .filter((j) => j.kind === FOOTAGE_INDEX_JOB)
        .map((j) => j.status),
    ).toEqual(['succeeded'])
    expect(disposed).toHaveLength(4)
    expect(editor.undoLabel()).toBe('Rename project')
    editor.undo()
    expect(editor.getProject().name).not.toBe('Before')
    expect(indexed()).toHaveLength(4)
    stop()
  })

  it('says which model the run downloads and how far it is, until the download ends', async () => {
    const { service, release, tick, download } = setup()
    service.indexing.start()
    await tick()
    const message = 'Downloading the footage tagger (154 MB, once)'
    const tagger: ModelDownload = {
      stage: 'download',
      model: 'tagger',
      message,
      fraction: 0.4,
      bytesLoaded: 61_000_000,
      bytesTotal: 153_000_000,
    }
    download(tagger)
    expect(service.indexing.getState().download).toEqual({ message, fraction: 0.4 })
    download({ ...tagger, fraction: 1, done: true })
    expect(service.indexing.getState().download).toBeUndefined()
    download({ ...tagger, model: 'depth' })
    expect(service.indexing.getState().download).toBeUndefined()
    for (const id of ['city', 'ocean', 'crowd', 'misc']) await release(id)
  })

  it('picks up clips imported while it runs, and analyzes each clip only once', async () => {
    const { editor, service, release, indexClip, tick } = setup()
    service.indexing.start()
    await tick()
    editor.dispatch({ type: 'asset.add', asset: videoAsset('late-city') })
    await release('city')
    expect(service.indexing.getState()).toMatchObject({ total: 5, done: 1 })
    for (const id of ['ocean', 'crowd', 'misc', 'late-city']) await release(id)
    expect(indexClip).toHaveBeenCalledTimes(5)
    expect(service.indexing.getState().status).toBe('idle')
  })

  it('pauses on cancel, and resumes on request or with the next import', async () => {
    const { editor, service, release, tick, indexed } = setup()
    service.indexing.start()
    await release('city')
    service.indexing.cancel()
    await tick()
    await tick()
    expect(service.indexing.getState().status).toBe('paused')
    expect(service.indexing.statusOf('ocean')).toBe('paused')
    expect(indexed()).toEqual(['city'])
    service.indexing.resume()
    await release('ocean')
    service.indexing.cancel()
    await tick()
    await tick()
    editor.dispatch({ type: 'asset.add', asset: videoAsset('new') })
    await release('crowd')
    expect(service.indexing.getState().status).toBe('indexing')
  })

  it('skips a clip that fails to decode, and stops the run when the model cannot load', async () => {
    const { service, release, tick } = setup()
    service.indexing.start()
    await release('city', new JobError('decode', 'Broken file'))
    expect(service.indexing.statusOf('city')).toBe('failed')
    await release('ocean', new JobError('model-load', 'Download failed'))
    await tick()
    expect(service.indexing.getState()).toMatchObject({
      status: 'error',
      error: { code: 'model-load', message: 'Download failed' },
      failed: [{ assetId: 'city', message: 'Broken file' }],
    })
    service.indexing.resume({ retryFailed: true })
    await release('city')
    expect(service.indexing.statusOf('city')).toBe('indexed')
  })

  it('tracks the people in each clip right after matching it, in the same job and without undo steps', async () => {
    const project = makeProject({
      clips: [
        { id: 'city', duration: 10, indexed: false },
        { id: 'nobody', duration: 10, indexed: false },
        { id: 'still', image: true, indexed: false },
      ],
    })
    const { editor, jobs, service, release, subjects } = setup(project, { gateSubjects: true })
    service.indexing.start()
    await release('city')
    expect(service.indexing.getState().current).toMatchObject({ assetId: 'city', step: 'subjects' })
    expect(service.indexing.getState().current!.fraction).toBeGreaterThanOrEqual(0.5)
    expect(jobs.list()[0]!.progress).toMatchObject({ stage: 'subjects', message: 'Clip 1 of 3 · city.mp4' })
    expect(service.indexing.statusOf('city')).toBe('indexed')
    expect(service.indexing.subjectStatusOf('city')).toBe('analyzing')
    expect(service.indexing.subjectStatusOf('nobody')).toBe('queued')
    await release('city:subjects')
    expect(service.indexing.subjectStatusOf('city')).toBe('analyzed')
    expect(readSubjectTrack(editor.getProject().analysis.visual.city)?.samples[0]?.source).toBe('face')
    expect(readClipIndex(editor.getProject().analysis.visual.city)).not.toBeNull()
    for (const id of ['nobody', 'nobody:subjects', 'still', 'still:subjects']) await release(id)
    expect(service.indexing.subjectStatusOf('nobody')).toBe('no-subject')
    expect(service.indexing.subjectStatusOf('still')).toBe('analyzed')
    expect(service.indexing.subjectStatusOf('song')).toBe('unsupported')
    expect(subjects.mock.calls.map(([s, o]) => [s.mediaId, o?.fps])).toEqual([
      ['city', undefined],
      ['nobody', undefined],
      ['still', 1],
    ])
    expect(jobs.list().map((j) => j.status)).toEqual(['succeeded'])
    expect(editor.canUndo()).toBe(false)
  })

  it('adds subject tracking to clips indexed before, without indexing them again', async () => {
    const { service, indexClip, subjects, tick } = setup(makeProject())
    service.indexing.start()
    for (let i = 0; i < 10; i++) await tick()
    expect(indexClip).not.toHaveBeenCalled()
    expect(subjects).toHaveBeenCalledTimes(CLIPS.length)
    expect(CLIPS.map((c) => service.indexing.subjectStatusOf(c.id))).toEqual(CLIPS.map(() => 'analyzed'))
    expect(service.indexing.getState().status).toBe('idle')
  })

  it('keeps the matching of a clip whose subject tracking fails, and stops when the model cannot load', async () => {
    const { service, release } = setup(undefined, { gateSubjects: true })
    service.indexing.start()
    await release('city')
    await release('city:subjects', new JobError('decode', 'Broken frame'))
    expect(service.indexing.statusOf('city')).toBe('indexed')
    expect(service.indexing.subjectStatusOf('city')).toBe('failed')
    expect(service.indexing.getState().status).toBe('indexing')
    await release('ocean')
    await release('ocean:subjects', new JobError('model-load', 'Segmenter download failed'))
    expect(service.indexing.getState()).toMatchObject({
      status: 'error',
      error: { code: 'model-load' },
      failed: [{ assetId: 'city', message: 'Broken frame' }],
    })
    expect(service.indexing.subjectStatusOf('ocean')).toBe('paused')
  })

  it('tags each clip from its index after matching, and tags clips matched before without decoding them', async () => {
    const { editor, service, release, tick, disposed, indexClip } = setup()
    service.indexing.start()
    for (const id of ['city', 'ocean', 'crowd', 'misc']) await release(id)
    const tags = (id: string) => readClipTags(editor.getProject().analysis.visual[id])
    expect(tags('city')).toContain('city')
    expect(tags('crowd')).toContain('crowd')
    expect(tags('ocean')).toContain('water')
    expect(editor.canUndo()).toBe(false)
    expect(disposed).toHaveLength(4)

    // A clip analyzed before tags existed gets them from its stored index: no decoding, no new matching.
    const analysis = editor.getProject().analysis.visual.city!
    const { tags: _dropped, ...data } = analysis.data
    editor.dispatch({ type: 'analysis.setVisual', analysis: { ...analysis, data } }, { history: 'skip' })
    expect(tags('city')).toBeNull()
    editor.dispatch({ type: 'project.rename', name: 'Any edit' })
    for (let i = 0; i < 10; i++) await tick()
    expect(tags('city')).toContain('city')
    expect(disposed).toHaveLength(4)
    expect(indexClip).toHaveBeenCalledTimes(4)
  })
  it('drops the run of a project that was closed', async () => {
    const { editor, service, tick, indexed } = setup()
    service.indexing.start()
    await tick()
    editor.load(makeProject({ clips: [] }))
    await tick()
    await tick()
    expect(service.indexing.getState().status).toBe('idle')
    expect(indexed()).toEqual([])
  })
})

describe('fast blank check', () => {
  const crowdIsBlack = (id: string) => (id === 'crowd' ? 3 : 120)
  const blank = (editor: ProjectEditor) =>
    Object.keys(editor.getProject().analysis.visual).filter((id) =>
      isBlankClip(editor.getProject().analysis.visual[id]),
    )

  it('checks every clip before analyzing any further, so a clip that shows nothing is flagged at once', async () => {
    const { editor, service, started, release, tick, peakLuma, indexed } = setup(undefined, {
      peakLuma: crowdIsBlack,
    })
    service.indexing.start()
    for (let i = 0; i < 10; i++) await tick()
    // The first clip's analysis is still running (its matching never finishes until released).
    expect(started).toEqual(['city:blank', 'ocean:blank', 'crowd:blank', 'misc:blank', 'city'])
    expect(blank(editor)).toEqual(['crowd'])
    expect(service.indexing.getState()).toMatchObject({ status: 'indexing', total: 4 })
    expect(editor.canUndo()).toBe(false)
    for (const id of ['city', 'ocean', 'crowd', 'misc']) await release(id)
    expect(indexed()).toHaveLength(4)
    expect(peakLuma).toHaveBeenCalledTimes(4)
    expect(peakLuma.mock.calls.map(([, o]) => o?.frames)).toEqual([8, 8, 8, 8])
  })

  it('checks on request where background analysis is off, once per clip, and shares a check already running', async () => {
    const { editor, service, peakLuma, release, started, tick } = setup(undefined, {
      peakLuma: crowdIsBlack,
      gateBlank: true,
    })
    const progress: number[] = []
    const all = service.checkBlank(undefined, { progress: (f) => progress.push(f) })
    const crowd = service.checkBlank(['crowd'])
    let crowdDone = false
    void crowd.then(() => (crowdDone = true))
    await release('city:blank')
    await release('ocean:blank')
    expect(crowdDone).toBe(false)
    await release('crowd:blank')
    await tick()
    expect(crowdDone).toBe(true)
    expect(blank(editor)).toEqual(['crowd'])
    await release('misc:blank')
    await all
    expect(progress).toEqual([0, 0.25, 0.5, 0.75])
    expect(started).toEqual(['city:blank', 'crowd:blank', 'ocean:blank', 'misc:blank'])
    await service.checkBlank()
    expect(peakLuma).toHaveBeenCalledTimes(4)
    expect(service.indexing.getState().status).toBe('idle')
  })

  it('leaves a clip it cannot decode unchecked, checks stills from one frame, and stops waiting when cancelled', async () => {
    const project = makeProject({
      clips: [
        { id: 'city', duration: 10, indexed: false },
        { id: 'broken', duration: 10, indexed: false },
        { id: 'still', image: true, indexed: false },
      ],
    })
    const { editor, service, peakLuma } = setup(project, {
      peakLuma: (id) => {
        if (id === 'broken') throw new JobError('decode', 'Broken file')
        return 0
      },
    })
    await service.checkBlank()
    const visual = editor.getProject().analysis.visual
    expect(blank(editor)).toEqual(['city', 'still'])
    expect(hasBlankVerdict(visual.broken)).toBe(false)
    expect(peakLuma.mock.calls.map(([s, o]) => [s.mediaId, o?.frames])).toEqual([
      ['city', 8],
      ['broken', 8],
      ['still', 1],
    ])
    const stop = new AbortController()
    stop.abort()
    editor.dispatch({ type: 'asset.add', asset: videoAsset('late') }, { history: 'skip' })
    await expect(service.checkBlank(undefined, { signal: stop.signal })).rejects.toMatchObject({
      code: 'cancelled',
    })
  })
})

describe('footage search and suggestions', () => {
  it('finds clips by description with their best range', async () => {
    const { service } = setup(makeProject())
    const results = await service.search('a busy city street')
    expect(results[0]).toMatchObject({ assetId: 'city', kind: 'video' })
    expect(results[0]!.score).toBeGreaterThanOrEqual(STRONG_MATCH)
    expect(results[0]!.range.end).toBeGreaterThan(results[0]!.range.start)
    expect(results.slice(1).every((r) => r.score < results[0]!.score)).toBe(true)
    expect(await service.search('   ')).toEqual([])
    expect(
      (await service.search('city', { assetIds: ['ocean', 'crowd'] })).map((r) => r.assetId),
    ).not.toContain('city')
  })

  it('suggests clips for a lyric line and for a section', async () => {
    const { service } = setup(makeProject())
    expect((await service.suggestForLine('l2'))[0]?.assetId).toBe('ocean')
    expect((await service.suggestForSection('chorus'))[0]?.assetId).toBe('crowd')
    expect(await service.suggestForLine('missing')).toEqual([])
  })

  it('returns nothing until clips are analyzed', async () => {
    const { service } = setup()
    expect(await service.search('city')).toEqual([])
  })
})
