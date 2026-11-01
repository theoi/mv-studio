import { afterEach, describe, expect, it } from 'vitest'
import { SEGMENT, type DemucsModel } from '../../../src/analysis/stems/demucs.ts'
import {
  STEM_MODEL_BYTES,
  StemSeparationService,
  stemEdits,
  type PaceStore,
} from '../../../src/analysis/stems/client.ts'
import { stemJobSeconds, type MeasuredPace } from '../../../src/analysis/stems/device.ts'
import { createStemsApi, type StemSeparationResult } from '../../../src/analysis/stems/worker-api.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createProject } from '../../../src/model/index.ts'
import type { Asset } from '../../../src/model/types.ts'
import { JobError, JobRunner } from '../../../src/shared/jobs.ts'
import {
  createWorkerClient,
  exposeWorker,
  type Endpoint,
  type WorkerCallContext,
} from '../../../src/shared/worker.ts'
import { drumLoop, SR } from './synth.ts'

/** Splits the mix by fixed gains: drums 0.1, bass 0.2, other 0.3, vocals 0.4 (time branch only). */
const gainModel: DemucsModel = {
  async run(mix) {
    const xt = new Float32Array(4 * 2 * SEGMENT)
    for (let s = 0; s < 4; s++)
      for (let i = 0; i < 2 * SEGMENT; i++) xt[s * 2 * SEGMENT + i] = ((s + 1) / 10) * mix[i]
    return { x: new Float32Array(4 * 4 * 2048 * 336), xt }
  },
}

let channel: MessageChannel | undefined
const channels: MessageChannel[] = []

function connect() {
  channel = new MessageChannel()
  const api = createStemsApi({
    demucsModel: async (ctx) => {
      ctx.progress({ stage: 'download', fraction: 1 })
      return { model: gainModel, device: 'wasm' }
    },
    codec: async () => 'pcm-s16',
  })
  exposeWorker(api, channel.port1 as unknown as Endpoint)
  return createWorkerClient<typeof api>(channel.port2 as unknown as Endpoint)
}

afterEach(() => {
  for (const c of [channel, ...channels.splice(0)]) {
    c?.port1.close()
    c?.port2.close()
  }
})

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] as number

describe('stem separation worker API', () => {
  // Two model segments of full-size STFTs: over a second, several when the machine is busy.
  it('returns encoded stems and features measured against the mix', async () => {
    const client = connect()
    // 22.05 kHz input exercises resampling to the model rate.
    const { audio } = drumLoop({ bpm: 120, seconds: 10 })
    const fractions: number[] = []
    const result = await client.call(
      'separate',
      { audio: { sampleRate: SR, channels: [audio] } },
      { onProgress: (p) => fractions.push(p.fraction ?? -1) },
    )
    expect(result.stems.map((s) => s.name)).toEqual(['drums', 'bass', 'other', 'vocals'])
    for (const stem of result.stems) {
      const header = new TextDecoder().decode(new Uint8Array(stem.audio.data, 0, 4))
      expect(header).toBe('RIFF')
      // 10 s of 16-bit stereo at 44.1 kHz plus the header.
      expect(stem.audio.data.byteLength).toBeGreaterThan(10 * 44100 * 4)
      expect(stem.audio.mimeType).toBe('audio/wav')
    }
    const loud = (name: 'drums' | 'vocals') => median(result.stemFeatures[name]?.loudness ?? [])
    // Drums are 20 dB below the mix, vocals 8 dB: only the louder stem approaches full range.
    expect(loud('vocals')).toBeGreaterThan(loud('drums') + 0.25)
    expect(result.stemFeatures.drums?.onsets.length).toBeGreaterThan(15)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(fractions.at(-1)).toBeGreaterThanOrEqual(0.97)
  }, 20_000)

  it('reports an empty song as invalid input', async () => {
    const client = connect()
    const error = (await client
      .call('separate', { audio: { sampleRate: 44100, channels: [new Float32Array(0)] } })
      .catch((e: unknown) => e)) as JobError
    expect(error).toBeInstanceOf(JobError)
    expect(error.code).toBe('invalid-input')
  })
  it('reports a failed allocation in the model as out of memory, so the user can retry', async () => {
    const channel2 = new MessageChannel()
    const api = createStemsApi({
      demucsModel: async () => ({
        model: {
          run: async () => {
            throw new Error('failed to allocate a buffer of size 1409286144')
          },
        },
        device: 'wasm',
      }),
      codec: async () => 'pcm-s16',
    })
    exposeWorker(api, channel2.port1 as unknown as Endpoint)
    const client = createWorkerClient<typeof api>(channel2.port2 as unknown as Endpoint)
    const error = (await client
      .call('separate', { audio: { sampleRate: 44100, channels: [new Float32Array(44100)] } })
      .catch((e: unknown) => e)) as JobError
    channel2.port1.close()
    channel2.port2.close()
    expect(error.code).toBe('out-of-memory')
    expect(error.retryable).toBe(true)
  })
})

describe('StemSeparationService', () => {
  const song: Asset = {
    id: 'song',
    kind: 'audio',
    name: 'My Song.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 1,
    storageKey: 'song',
    duration: 8,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }

  function setup(
    whileSeparating?: (editor: ProjectEditor) => void,
    options: { songSeconds?: number; separateSeconds?: number } = {},
  ) {
    const editor = new ProjectEditor(createProject())
    editor.dispatch({ type: 'asset.add', asset: { ...song, duration: options.songSeconds ?? song.duration } })
    const decoded: { file: string; sampleRate: number }[] = []
    const decode = async (file: Blob, sampleRate: number) => {
      decoded.push({ file: await file.text(), sampleRate })
      return { sampleRate, channels: [new Float32Array(sampleRate * (options.songSeconds ?? 1))] }
    }
    const stemsApi = {
      async separate(_args: unknown, ctx: WorkerCallContext): Promise<StemSeparationResult> {
        ctx.progress({ stage: 'separate', fraction: 0.5 })
        whileSeparating?.(editor)
        const audio = { data: new ArrayBuffer(8), mimeType: 'audio/wav', extension: '.wav' }
        const seconds = options.separateSeconds ?? 1
        return { device: 'wasm', seconds, stems: [{ name: 'vocals', audio }], stemFeatures: {} }
      },
    }
    const ch = new MessageChannel()
    channels.push(ch)
    exposeWorker(stemsApi, ch.port1 as unknown as Endpoint)
    const store = {
      getFile: async (a: Asset) => new File([a.storageKey], a.name),
      storeBlob: async (_blob: Blob, info: Pick<Asset, 'kind' | 'name' | 'origin'>) =>
        ({ ...song, ...info, id: 'vocals-asset', storageKey: 'vocals' }) as Asset,
    }
    let stored: MeasuredPace | undefined
    const pace: PaceStore = { get: () => stored, set: (p) => (stored = p) }
    const service = new StemSeparationService({
      runner: new JobRunner(),
      decode,
      createWorker: () => ch.port2 as unknown as Worker,
      pace,
    })
    return { editor, service, store, decoded, pace }
  }

  it('separates the song from the store and attaches its stems without an undo step', async () => {
    const { editor, service, store, decoded } = setup()
    const undoLabel = editor.undoLabel()
    const handle = service.separateSong(song.id, { editor, store })
    const stages: (string | undefined)[] = []
    handle.subscribe((s) => stages.push(s.progress.stage))
    await handle.promise
    expect(handle.snapshot().kind).toBe('analysis.stems')
    expect(decoded).toEqual([{ file: 'song', sampleRate: 44100 }])
    expect(editor.getProject().analysis.audio[song.id]?.stems).toEqual({ vocals: 'vocals-asset' })
    expect(editor.getProject().assets['vocals-asset']?.origin).toEqual({
      type: 'stem',
      parentAssetId: song.id,
    })
    expect(editor.undoLabel()).toBe(undoLabel)
    expect(stages.at(-1)).toBe('save')
  })

  it('attaches nothing when the song was removed while separating', async () => {
    const { editor, service, store } = setup((e) => e.dispatch({ type: 'asset.remove', assetId: song.id }))
    const handle = service.separateSong(song.id, { editor, store })
    await expect(handle.promise).rejects.toMatchObject({ code: 'invalid-input' })
    expect(editor.getProject().analysis.audio[song.id]?.stems).toBeUndefined()
    expect(editor.getProject().assets['vocals-asset']).toBeUndefined()
  })

  it('estimates the model download until it is cached, and the time from the song length and threads', async () => {
    const { editor, service } = setup()
    const estimate = await service.estimate(editor.getProject(), song.id)
    expect(estimate.downloadBytes).toBe(STEM_MODEL_BYTES)
    expect(estimate.device).toBe('wasm')
    // Tests are not cross-origin isolated, so ONNX Runtime would get one thread.
    expect(estimate.seconds).toBe(stemJobSeconds(song.duration ?? 0, 'wasm', 1))
    expect(estimate.seconds).toBeGreaterThan(stemJobSeconds(song.duration ?? 0, 'wasm', 3))
  })

  it('estimates later separations from the pace this device measured', async () => {
    const { editor, service, store, pace } = setup(undefined, { songSeconds: 60, separateSeconds: 144 })
    const before = await service.estimate(editor.getProject(), song.id)
    await service.separateSong(song.id, { editor, store }).promise
    expect(pace.get()).toEqual({ secondsPerSecond: 2.4, device: 'wasm', threads: 1 })
    const after = await service.estimate(editor.getProject(), song.id)
    expect(after.seconds).toBeLessThan(before.seconds)
    // The separation stage at 2.4 s per second of song plus a 10% margin, plus reading and saving.
    expect(after.seconds).toBeGreaterThanOrEqual(144 * 1.1)
    expect(after.seconds).toBeLessThan(175)
    expect(await service.slowdown()).toBeLessThan(1)
  })

  it('keeps the defaults after separating a song too short to measure a pace', async () => {
    const { editor, service, store, pace } = setup(undefined, { songSeconds: 8, separateSeconds: 30 })
    await service.separateSong(song.id, { editor, store }).promise
    expect(pace.get()).toBeUndefined()
    expect(await service.slowdown()).toBe(1)
  })
})

describe('stemEdits', () => {
  it('stores each stem as an asset derived from the song and attaches stems and features', async () => {
    const stored: { name: string; type: string; parent?: string }[] = []
    const store = {
      async storeBlob(blob: Blob, info: Pick<Asset, 'kind' | 'name' | 'origin'>) {
        stored.push({ name: info.name, type: blob.type, parent: info.origin.parentAssetId })
        return { id: `asset-${stored.length}`, ...info } as Asset
      },
    }
    const audio = { data: new ArrayBuffer(8), mimeType: 'audio/webm', extension: '.webm' }
    const result = {
      device: 'wasm' as const,
      seconds: 1,
      stems: [
        { name: 'vocals' as const, audio },
        { name: 'drums' as const, audio },
      ],
      stemFeatures: {
        vocals: { rate: 50, loudness: [0.5], bands: [[0.5]], bandEdgesHz: [20, 60], onsets: [] },
      },
    }
    const commands = await stemEdits(result, { id: 'song', name: 'My Song.mp3' }, store)
    expect(stored).toEqual([
      { name: 'My Song (vocals).webm', type: 'audio/webm', parent: 'song' },
      { name: 'My Song (drums).webm', type: 'audio/webm', parent: 'song' },
    ])
    expect(commands.map((c) => c.type)).toEqual(['asset.add', 'asset.add', 'analysis.setStems'])
    expect(commands[2]).toEqual({
      type: 'analysis.setStems',
      assetId: 'song',
      stems: { vocals: 'asset-1', drums: 'asset-2' },
      stemFeatures: result.stemFeatures,
    })
  })
})
