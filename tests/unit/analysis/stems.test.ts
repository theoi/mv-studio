import { afterEach, describe, expect, it } from 'vitest'
import { SEGMENT, type DemucsModel } from '../../../src/analysis/stems/demucs.ts'
import { stemEdits } from '../../../src/analysis/stems/client.ts'
import { createStemsApi } from '../../../src/analysis/stems/worker-api.ts'
import type { Asset } from '../../../src/model/types.ts'
import { JobError } from '../../../src/shared/jobs.ts'
import { createWorkerClient, exposeWorker, type Endpoint } from '../../../src/shared/worker.ts'
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
  channel?.port1.close()
  channel?.port2.close()
})

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] as number

describe('stem separation worker API', () => {
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
  })

  it('reports an empty song as invalid input', async () => {
    const client = connect()
    const error = (await client
      .call('separate', { audio: { sampleRate: 44100, channels: [new Float32Array(0)] } })
      .catch((e: unknown) => e)) as JobError
    expect(error).toBeInstanceOf(JobError)
    expect(error.code).toBe('invalid-input')
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
