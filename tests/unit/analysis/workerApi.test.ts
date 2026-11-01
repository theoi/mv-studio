import { afterEach, describe, expect, it } from 'vitest'
import type { BeatThisModel } from '../../../src/analysis/beats/beatThis.ts'
import { createAnalysisApi } from '../../../src/analysis/worker-api.ts'
import { JobError } from '../../../src/shared/jobs.ts'
import { createWorkerClient, exposeWorker, type Endpoint } from '../../../src/shared/worker.ts'
import { drumLoop, fmeasure, SR } from './synth.ts'

/**
 * Stands in for the Beat This! network: a beat wherever the log-mel energy jumps sharply (kicks and snares),
 * a downbeat on none.
 */
const fakeBeatThis: BeatThisModel = {
  async run(spect, frames) {
    const energy = Array.from({ length: frames }, (_, f) => {
      let s = 0
      for (let b = 0; b < 128; b++) s += spect[f * 128 + b] as number
      return s
    })
    const rise = energy.map((e, f) => (f > 0 ? Math.max(0, e - (energy[f - 1] as number)) : 0))
    const threshold = 0.5 * Math.max(...rise)
    const beat = Float32Array.from(rise, (r) => (r > threshold ? 5 : -5))
    return { beat, downbeat: new Float32Array(frames).fill(-5) }
  },
}

let channel: MessageChannel | undefined
let modelLoads = 0

function connect() {
  modelLoads = 0
  channel = new MessageChannel()
  const api = createAnalysisApi({
    beatThisModel: async () => {
      modelLoads++
      return fakeBeatThis
    },
  })
  exposeWorker(api, channel.port1 as unknown as Endpoint)
  return createWorkerClient<typeof api>(channel.port2 as unknown as Endpoint)
}

afterEach(() => {
  channel?.port1.close()
  channel?.port2.close()
})

const song = (seed: number) => {
  const { audio, beats } = drumLoop({ bpm: 120, seconds: 20, offset: 0.3, seed })
  return { audio: { sampleRate: SR, channels: [audio] }, beats }
}

describe('analysis worker API', () => {
  it('analyzes a song, then refines its beats from the kept state', async () => {
    const client = connect()
    const { audio, beats } = song(1)
    const stages = new Set<string>()
    const analysis = await client.call(
      'analyzeFast',
      { assetId: 'a', audio },
      { onProgress: (p) => stages.add(p.stage ?? '') },
    )
    expect(analysis.assetId).toBe('a')
    expect(analysis.tempo?.bpm).toBeCloseTo(120, 0)
    expect(stages).toContain('beats')

    const refined = await client.call('refineBeats', { assetId: 'a' })
    expect(modelLoads).toBe(1)
    expect(refined.tempo?.bpm).toBeCloseTo(120, 0)
    expect(fmeasure(refined.beats ?? [], beats)).toBeGreaterThan(0.95)
    expect(refined.sections?.length).toBeGreaterThan(0)
  })

  // Analyzing 31 s of audio takes over half a second, several when the machine is busy.
  it('never sends progress back when the beat model downloads first', async () => {
    channel = new MessageChannel()
    const api = createAnalysisApi({
      beatThisModel: async (ctx) => {
        for (const fraction of [0, 0.5, 1]) ctx.progress({ stage: 'download', fraction })
        return fakeBeatThis
      },
    })
    exposeWorker(api, channel.port1 as unknown as Endpoint)
    const client = createWorkerClient<typeof api>(channel.port2 as unknown as Endpoint)
    // Just over Beat This!'s 30 s window, so it runs in two windows and reports each.
    const loop = drumLoop({ bpm: 120, seconds: 31, offset: 0.3, seed: 5 })
    const fractions: number[] = []
    await client.call(
      'refineBeats',
      { assetId: 'a', audio: { sampleRate: SR, channels: [loop.audio] } },
      { onProgress: (p) => fractions.push(p.fraction ?? NaN) },
    )
    // The download fills the first half of the bar and the two windows the second.
    expect(fractions).toEqual([0, 0, 0.25, 0.5, 0.75, 1])
  }, 20_000)

  it('says how long Beat This! still needs from the windows it has run, leaving the download out', async () => {
    channel = new MessageChannel()
    let clock = 0
    const api = createAnalysisApi({
      beatThisModel: async (ctx) => {
        ctx.progress({ stage: 'download', fraction: 0 })
        clock += 60_000
        ctx.progress({ stage: 'download', fraction: 1 })
        // Each window takes 8 s.
        return {
          run: (spect, frames) => {
            clock += 8_000
            return fakeBeatThis.run(spect, frames)
          },
        }
      },
      now: () => clock,
    })
    exposeWorker(api, channel.port1 as unknown as Endpoint)
    const client = createWorkerClient<typeof api>(channel.port2 as unknown as Endpoint)
    // Just over Beat This!'s 30 s window, so it runs in two windows.
    const loop = drumLoop({ bpm: 120, seconds: 31, offset: 0.3, seed: 5 })
    const seen: (number | undefined)[] = []
    await client.call(
      'refineBeats',
      { assetId: 'a', audio: { sampleRate: SR, channels: [loop.audio] } },
      { onProgress: (p) => seen.push(p.etaSeconds) },
    )
    // Nothing while the model downloads; 8 s after the first window, then 0.
    expect(seen).toEqual([undefined, undefined, undefined, 8, 0])
  }, 20_000)

  it('needs the audio again to refine a song it does not hold', async () => {
    const client = connect()
    const error = await client.call('refineBeats', { assetId: 'unknown' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JobError)
    expect((error as JobError).code).toBe('invalid-input')
    expect(modelLoads).toBe(0)

    const { audio } = song(2)
    const refined = await client.call('refineBeats', { assetId: 'unknown', audio })
    expect(refined.beats?.length).toBeGreaterThan(30)
  })

  it('runs Beat This! once per song and fits its bars to a tempo the user taps', async () => {
    const client = connect()
    const { audio, beats } = song(4)
    await client.call('analyzeFast', { assetId: 'a', audio })
    expect((await client.call('trackAtTempo', { assetId: 'a', bpm: 120 })).downbeats).toBeUndefined()

    const refined = await client.call('refineBeats', { assetId: 'a' })
    expect(refined.downbeats?.length).toBeGreaterThan(3)
    await client.call('refineBeats', { assetId: 'a' })
    expect(modelLoads).toBe(1)

    const tracked = await client.call('trackAtTempo', { assetId: 'a', bpm: 121 })
    expect(fmeasure(tracked.beats ?? [], beats)).toBeGreaterThan(0.95)
    expect(fmeasure(tracked.downbeats ?? [], refined.downbeats ?? [])).toBeGreaterThan(0.9)
    expect(tracked.downbeats?.every((d) => tracked.beats?.includes(d))).toBe(true)

    // A released song is read again, but its Beat This! output is kept.
    await client.call('release', { assetId: 'a' })
    await client.call('refineBeats', { assetId: 'a', audio: song(4).audio })
    expect(modelLoads).toBe(1)
  })

  it('forgets released songs and keeps at most two', async () => {
    const client = connect()
    for (const id of ['a', 'b', 'c']) await client.call('analyzeFast', { assetId: id, audio: song(3).audio })
    expect(await client.call('release', { assetId: 'a' })).toBe(false)
    expect(await client.call('release', { assetId: 'b' })).toBe(true)
    expect(await client.call('release', { assetId: 'b' })).toBe(false)
    expect(await client.call('release', { assetId: 'c' })).toBe(true)
  })

  it('reports an empty song as invalid input', async () => {
    const client = connect()
    const error = (await client
      .call('analyzeFast', { assetId: 'e', audio: { sampleRate: SR, channels: [new Float32Array(0)] } })
      .catch((e: unknown) => e)) as JobError
    expect(error.code).toBe('invalid-input')
  })
})
