import { afterEach, describe, expect, it } from 'vitest'
import {
  refinedAnalysisCommand,
  refinedBarsCommand,
  SongAnalysisService,
} from '../../../src/analysis/client.ts'
import { ProjectEditor, createProject, type AudioAnalysis } from '../../../src/model/index.ts'
import { JobRunner } from '../../../src/shared/jobs.ts'
import { closeFakeWorkers, FakeWorker } from '../shared/fakeWorker.ts'

afterEach(() => closeFakeWorkers())

describe('SongAnalysisService', () => {
  it('replaces an analysis worker that crashed, so the next analysis runs', async () => {
    const workers: FakeWorker[] = []
    const service = new SongAnalysisService({
      runner: new JobRunner(),
      createWorker: () => {
        const first = workers.length === 0
        const worker = new FakeWorker({
          analyzeFast: (args: { assetId: string }) =>
            first ? new Promise<never>(() => undefined) : { assetId: args.assetId },
        })
        workers.push(worker)
        return worker.asWorker()
      },
    })
    const audio = () => ({ sampleRate: 44_100, channels: [new Float32Array(16)] })
    const crashed = service.analyze('song', audio())
    await expect.poll(() => workers.length).toBe(1)
    workers[0]?.crash('Uncaught RangeError: Array buffer allocation failed')
    await expect(crashed.promise).rejects.toMatchObject({ code: 'out-of-memory' })
    await expect(service.analyze('song', audio()).promise).resolves.toEqual({ assetId: 'song' })
    expect(workers).toHaveLength(2)
    service.dispose()
  })
  it('reads the song file to refine only when the worker no longer holds the song', async () => {
    const held = new Set<string>(['kept'])
    const calls: { assetId: string; audio: boolean }[] = []
    let reads = 0
    const service = new SongAnalysisService({
      runner: new JobRunner(),
      decode: async () => ({ sampleRate: 44_100, channels: [new Float32Array(16)] }),
      createWorker: () =>
        new FakeWorker({
          holds: (args: { assetId: string }) => held.has(args.assetId),
          refineBeats: (args: { assetId: string; audio?: unknown }) => {
            calls.push({ assetId: args.assetId, audio: args.audio !== undefined })
            return { downbeats: [0] }
          },
        }).asWorker(),
    })
    const file = async () => {
      reads++
      return new Blob()
    }
    await service.refine('kept', file).promise
    await service.refine('gone', file).promise
    expect(calls).toEqual([
      { assetId: 'kept', audio: false },
      { assetId: 'gone', audio: true },
    ])
    expect(reads).toBe(1)
    service.dispose()
  })

  describe('worker lifetime', () => {
    const logits = { beat: Float32Array.of(1, 2), downbeat: Float32Array.of(3, 4) }
    const audio = () => ({ sampleRate: 44_100, channels: [new Float32Array(16)] })

    /** Fake workers that hold the songs they analyzed; `gate` makes a song's fast analysis wait for its promise. */
    function setup(gate: Record<string, Promise<void>> = {}) {
      const workers: FakeWorker[] = []
      const calls: { worker: number; method: string; assetId: string; audio: boolean; logits: unknown }[] = []
      const runner = new JobRunner()
      const service = new SongAnalysisService({
        runner,
        decode: async () => audio(),
        createWorker: () => {
          const index = workers.length
          const held = new Set<string>()
          const seen = new Map<string, unknown>()
          type Args = { assetId: string; audio?: unknown; logits?: unknown }
          const record = (method: string, args: Args) => {
            calls.push({
              worker: index,
              method,
              assetId: args.assetId,
              audio: !!args.audio,
              logits: args.logits,
            })
            if (args.audio) held.add(args.assetId)
            if (args.logits) seen.set(args.assetId, args.logits)
          }
          const worker = new FakeWorker({
            holds: (args: Args) => held.has(args.assetId),
            analyzeFast: async (args: Args) => {
              record('analyzeFast', args)
              await gate[args.assetId]
              return { assetId: args.assetId }
            },
            refineBeats: (args: Args) => {
              record('refineBeats', args)
              seen.set(args.assetId, seen.get(args.assetId) ?? logits)
              return { downbeats: [index] }
            },
            trackAtTempo: (args: Args & { bpm: number }) => {
              record('trackAtTempo', args)
              return { tempo: { bpm: args.bpm, confidence: 1 }, beats: [], downbeats: seen.get(args.assetId) }
            },
            logitsOf: (args: Args) => seen.get(args.assetId) ?? null,
            release: (args: Args) => held.delete(args.assetId),
          })
          workers.push(worker)
          return worker.asWorker()
        },
      })
      const file = async () => new Blob()
      return { service, workers, calls, runner, file }
    }

    it('lets the worker go once no job is left and it may have loaded Beat This!, and gives the next one its output', async () => {
      const { service, workers, calls, file } = setup()
      await service.analyze('song', audio()).promise
      expect(workers[0]?.terminated).toBe(false)
      await expect(service.refine('song').promise).resolves.toEqual({ downbeats: [0] })
      expect(workers[0]?.terminated).toBe(true)

      // The fresh worker no longer holds the song: the file is read again, and the bars of the tapped tempo come from
      // the first worker's Beat This! output.
      const tracked = await service.trackAtTempo('song', 121, file).promise
      expect(tracked.downbeats).toEqual(logits)
      expect(workers).toHaveLength(2)
      // Given that output, refining the song again does not load the model: the worker and the song it holds stay.
      await service.refine('song', file).promise
      await expect(service.analyzeAgain('song', file).promise).resolves.toEqual({
        assetId: 'song',
        downbeats: [1],
      })
      expect(workers[1]?.terminated).toBe(false)
      // Another song needs the model.
      await service.analyzeAgain('other', file).promise
      expect(workers[1]?.terminated).toBe(true)
      expect(workers).toHaveLength(2)
      expect(calls.filter((c) => c.method !== 'analyzeFast')).toEqual([
        { worker: 0, method: 'refineBeats', assetId: 'song', audio: false, logits: undefined },
        { worker: 1, method: 'trackAtTempo', assetId: 'song', audio: true, logits },
        { worker: 1, method: 'refineBeats', assetId: 'song', audio: false, logits },
        { worker: 1, method: 'refineBeats', assetId: 'song', audio: false, logits },
        { worker: 1, method: 'refineBeats', assetId: 'other', audio: false, logits: undefined },
      ])
    })

    it('keeps the worker while another song analysis is still running', async () => {
      let finish = () => {}
      const { service, workers } = setup({ other: new Promise<void>((resolve) => (finish = resolve)) })
      const other = service.analyze('other', audio())
      await service.refine('song', audio()).promise
      expect(workers[0]?.terminated).toBe(false)
      finish()
      await expect(other.promise).resolves.toEqual({ assetId: 'other' })
      expect(workers[0]?.terminated).toBe(true)
      expect(workers).toHaveLength(1)
    })

    it('runs a job started as the refinement ends to the end, on the same worker or a fresh one', async () => {
      const { service, workers, calls, runner, file } = setup()
      // Started while the refinement's job reports it succeeded, before its promise settles: the same worker, let go
      // once this job ends too.
      let tempo: Promise<unknown> | undefined
      let started = false
      runner.subscribe((list) => {
        if (started || !list.some((j) => j.kind === 'analysis.downbeats' && j.status === 'succeeded')) return
        started = true
        tempo = service.trackAtTempo('song', 90, file).promise
      })
      await service.refine('song', audio()).promise
      expect(workers[0]?.terminated).toBe(false)
      await expect(tempo).resolves.toMatchObject({ tempo: { bpm: 90 }, downbeats: logits })
      expect(workers[0]?.terminated).toBe(true)

      // Started when the refinement's promise settles, right after the worker was let go: a fresh one.
      const refine = service.refine('two', file)
      const next = refine.promise.then(() => service.analyze('next', audio()).promise)
      await expect(next).resolves.toEqual({ assetId: 'next' })
      expect(calls.map((c) => [c.worker, c.method, c.assetId, c.audio])).toEqual([
        [0, 'refineBeats', 'song', true],
        [0, 'trackAtTempo', 'song', false],
        [1, 'refineBeats', 'two', true],
        [2, 'analyzeFast', 'next', true],
      ])
      expect(workers.map((w) => w.terminated)).toEqual([true, true, false])
      service.dispose()
    })
  })
})

const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
const fast: AudioAnalysis = {
  assetId: 'song',
  version: 'test',
  tempo: { bpm: 120, confidence: 0.6 },
  beats,
  sections: [{ id: 's', start: 0, end: 8, label: 'verse' }],
}
const refined = {
  tempo: { bpm: 120.5, confidence: 0.95 },
  beats: beats.map((t) => t + 0.01),
  downbeats: beats.filter((_, i) => i % 4 === 1).map((t) => t + 0.01),
  sections: [{ id: 'r', start: 0, end: 8, label: 'chorus' }],
}

/** The song's analysis after dispatching `command` (as a background write) onto `analysis`. */
function apply(analysis: AudioAnalysis, command: ReturnType<typeof refinedBarsCommand>) {
  const editor = new ProjectEditor(createProject())
  editor.dispatch({ type: 'analysis.setDetected', analysis }, { history: 'skip' })
  if (command) editor.dispatch(command, { history: 'skip' })
  return editor.getProject().analysis.audio.song
}

describe('refined bars', () => {
  it('lands on a first analysis that stored no downbeats, grid and sections', () => {
    expect(apply(fast, refinedAnalysisCommand(fast, refined))).toMatchObject(refined)
    expect(apply(fast, refinedBarsCommand(fast, fast, refined, { sections: true }))).toMatchObject(refined)
  })

  it('replaces untouched detected beats but keeps sections that may hold edits', () => {
    const after = apply(fast, refinedBarsCommand(fast, fast, refined))
    expect(after?.downbeats).toEqual(refined.downbeats)
    expect(after?.beats).toEqual(refined.beats)
    expect(after?.sections).toEqual(fast.sections)
  })

  it('puts the bars on beats the user set or changed meanwhile, keeping those beats, as bars of four', () => {
    const doubled: AudioAnalysis = {
      ...fast,
      tempo: { bpm: 240, confidence: 1 },
      beats: beats.flatMap((t, i) => (i + 1 < beats.length ? [t, t + 0.25] : [t])),
    }
    const after = apply(doubled, refinedBarsCommand(doubled, fast, refined))
    expect(after?.beats).toEqual(doubled.beats)
    expect(after?.tempo).toEqual(doubled.tempo)
    // The refined bars span eight of the doubled beats, so a bar also starts halfway, and four beats after the last.
    expect(after?.downbeats).toEqual(beats.filter((_, i) => i % 2 === 1))
    // On halved beats they span two, and which beat of each pair starts a bar is unknown: no bars.
    const halved: AudioAnalysis = {
      ...fast,
      tempo: { bpm: 60, confidence: 1 },
      beats: beats.filter((_, i) => i % 2 === 1),
    }
    expect(refinedBarsCommand(halved, fast, refined)).toBeNull()
    // The user's own tempo, not changed since the refinement started, keeps its beats too.
    const tapped: AudioAnalysis = { ...fast, tempo: { bpm: 120, confidence: 1 } }
    expect(apply(tapped, refinedBarsCommand(tapped, tapped, refined))?.beats).toEqual(beats)
  })

  it('stores nothing when bars exist or the refined bars fit none of the beats', () => {
    expect(refinedBarsCommand({ ...fast, downbeats: [0.5, 2.5] }, fast, refined)).toBeNull()
    const offbeat: AudioAnalysis = {
      ...fast,
      tempo: { bpm: 120, confidence: 1 },
      beats: beats.map((t) => t + 0.25),
    }
    expect(refinedBarsCommand(offbeat, fast, refined)).toBeNull()
    expect(refinedBarsCommand(fast, fast, { ...refined, downbeats: undefined })).toBeNull()
  })
})
