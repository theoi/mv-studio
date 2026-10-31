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

  it('puts the bars on beats the user set or changed meanwhile, keeping those beats', () => {
    const halved: AudioAnalysis = {
      ...fast,
      tempo: { bpm: 60, confidence: 1 },
      beats: beats.filter((_, i) => i % 2 === 1),
    }
    const after = apply(halved, refinedBarsCommand(halved, fast, refined))
    expect(after?.beats).toEqual(halved.beats)
    expect(after?.tempo).toEqual(halved.tempo)
    expect(after?.downbeats).toEqual(beats.filter((_, i) => i % 4 === 1))
    // The user's own tempo, not changed since the refinement started, keeps its beats too.
    const tapped: AudioAnalysis = { ...fast, tempo: { bpm: 120, confidence: 1 } }
    expect(apply(tapped, refinedBarsCommand(tapped, tapped, refined))?.beats).toEqual(beats)
  })

  it('stores nothing when bars exist or the refined bars fit none of the beats', () => {
    expect(refinedBarsCommand({ ...fast, downbeats: [0.5] }, fast, refined)).toBeNull()
    const offbeat: AudioAnalysis = {
      ...fast,
      tempo: { bpm: 120, confidence: 1 },
      beats: beats.map((t) => t + 0.25),
    }
    expect(refinedBarsCommand(offbeat, fast, refined)).toBeNull()
    expect(refinedBarsCommand(fast, fast, { ...refined, downbeats: undefined })).toBeNull()
  })
})
