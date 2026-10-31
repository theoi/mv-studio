import type { GeneratedMediaStore } from '../../../src/cloud/media.ts'
import { falModel, FAL_MODELS } from '../../../src/cloud/fal/catalog.ts'
import { CloudError } from '../../../src/cloud/errors.ts'
import type {
  GenerationRequest,
  GenerationResult,
  MediaGenerationProvider,
} from '../../../src/cloud/types.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { Asset, AudioAnalysis, LyricLine, Project } from '../../../src/model/types.ts'
import { JobError, type JobContext } from '../../../src/shared/jobs.ts'

export const SONG_ID = 'song'
export const SONG_LENGTH = 64

export const SECTIONS = [
  { id: 's-intro', label: 'intro', start: 0, end: 8, energy: 0.15 },
  { id: 's-verse', label: 'verse', start: 8, end: 24, energy: 0.45 },
  { id: 's-chorus1', label: 'chorus', start: 24, end: 40, energy: 0.9, repeatGroup: 1 },
  { id: 's-bridge', label: 'bridge', start: 40, end: 48, energy: 0.35 },
  { id: 's-chorus2', label: 'chorus', start: 48, end: 60, energy: 0.95, repeatGroup: 1 },
  { id: 's-outro', label: 'outro', start: 60, end: 64, energy: 0.1 },
]

/** 120 BPM: a beat every 0.5 s, a bar every 2 s. */
export const BEATS = Array.from({ length: SONG_LENGTH * 2 }, (_, i) => i * 0.5)
export const DOWNBEATS = BEATS.filter((_, i) => i % 4 === 0)

function asset(id: string, kind: Asset['kind'], extra: Partial<Asset> = {}): Asset {
  return {
    id,
    kind,
    name: `${id}.${kind === 'image' ? 'jpg' : kind === 'audio' ? 'mp3' : 'mp4'}`,
    mimeType: kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
    byteSize: 1000,
    storageKey: `media/${id}`,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
    ...extra,
  }
}

export function timedLine(id: string, text: string, start: number): LyricLine {
  const words = text
    .split(' ')
    .map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.35 }))
  return { id, text, start, end: words[words.length - 1]!.end, words }
}

export const LYRICS: LyricLine[] = [
  timedLine('l1', 'Walking through the city lights', 9),
  timedLine('l2', 'Every window holds a story', 13),
  timedLine('l3', 'Hold on hold on tonight', 25),
  timedLine('l4', 'We are burning bright', 29),
  timedLine('l5', 'Hold on hold on tonight', 49),
]

export function analysis(overrides: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    assetId: SONG_ID,
    version: 'test',
    tempo: { bpm: 120, confidence: 0.9 },
    beats: BEATS,
    downbeats: DOWNBEATS,
    sections: SECTIONS,
    ...overrides,
  }
}

export interface FixtureOptions {
  song?: boolean
  analyzed?: boolean
  videos?: number
  images?: number
  lyrics?: LyricLine[] | null
}

export function makeProject(o: FixtureOptions = {}): Project {
  const project = createProject({ name: 'Test', aspect: '16:9', now: new Date(0) })
  const assets: Record<string, Asset> = {}
  if (o.song !== false) assets[SONG_ID] = asset(SONG_ID, 'audio', { duration: SONG_LENGTH })
  const videoLengths = [12, 20, 6, 30, 9, 15]
  for (let i = 0; i < (o.videos ?? 4); i++) {
    const id = `video${i + 1}`
    assets[id] = asset(id, 'video', {
      duration: videoLengths[i % videoLengths.length],
      width: 1920,
      height: 1080,
    })
  }
  for (let i = 0; i < (o.images ?? 0); i++) {
    const id = `image${i + 1}`
    assets[id] = asset(id, 'image', { width: 1600, height: 900 })
  }
  return {
    ...project,
    assets,
    ...(o.song !== false ? { songAssetId: SONG_ID } : {}),
    analysis: {
      audio: o.song !== false && o.analyzed !== false ? { [SONG_ID]: analysis() } : {},
      visual: {},
    },
    ...(o.lyrics === null
      ? {}
      : { lyrics: { audioAssetId: SONG_ID, source: 'pasted', lines: o.lyrics ?? LYRICS } }),
  }
}

/** Stores generated blobs in memory and returns Assets like the real media store. */
export function memoryStore(): GeneratedMediaStore & { stored: Asset[] } {
  const stored: Asset[] = []
  return {
    stored,
    async storeBlob(blob, info) {
      const a: Asset = {
        id: `gen-${stored.length + 1}`,
        kind: info.kind,
        name: info.name,
        mimeType: blob.type || 'image/jpeg',
        byteSize: blob.size,
        storageKey: `media/gen-${stored.length + 1}`,
        origin: info.origin,
        createdAt: new Date(0).toISOString(),
        ...(info.kind === 'video' ? { duration: 5 } : {}),
      }
      stored.push(a)
      return a
    },
  }
}

export interface FakeProvider extends MediaGenerationProvider {
  calls: GenerationRequest[]
  /** Return a CloudError for the n-th call (0-based) or every call. */
  failOn?: (index: number, request: GenerationRequest) => CloudError | undefined
  /** Holds the n-th generate call until the promise resolves or the job is cancelled; may report its progress. */
  gate?: (index: number, ctx: JobContext) => Promise<void>
}

/** Behaves like FalProvider with real fal prices, without any network. */
export function fakeProvider(overrides: Partial<Pick<FakeProvider, 'failOn' | 'gate'>> = {}): FakeProvider {
  const provider: FakeProvider = {
    id: 'fal',
    name: 'fal.ai',
    models: FAL_MODELS,
    calls: [],
    ...overrides,
    getModel: (id) => falModel(id),
    estimate(request) {
      const model = falModel(request.modelId)
      if (!model) throw new Error(`unknown model ${request.modelId}`)
      return model.estimate(request)
    },
    async generate(request: GenerationRequest, ctx: JobContext): Promise<GenerationResult> {
      const index = provider.calls.length
      provider.calls.push(request)
      if (provider.gate) {
        const aborted = new Promise<never>((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled'))),
        )
        await Promise.race([provider.gate(index, ctx), aborted])
      }
      ctx.throwIfCancelled()
      const failure = provider.failOn?.(index, request)
      if (failure) throw failure
      const video = request.task !== 'text-to-image'
      return {
        requestId: `req-${index}`,
        modelId: request.modelId,
        task: request.task,
        media: [
          {
            kind: video ? 'video' : 'image',
            blob: new Blob([`media ${index}`], { type: video ? 'video/mp4' : 'image/jpeg' }),
            mimeType: video ? 'video/mp4' : 'image/jpeg',
            sourceUrl: `https://example.invalid/${index}`,
          },
        ],
        estimate: provider.estimate(request),
      }
    },
    validateKey: async () => ({ ok: true, message: 'ok' }),
  }
  return provider
}

export function badKey(): CloudError {
  return new CloudError({
    kind: 'bad-key',
    provider: 'fal',
    title: 'fal.ai rejected the key',
    message: 'Unauthorized',
    status: 401,
  })
}

export function contentPolicy(): CloudError {
  return new CloudError({
    kind: 'content-policy',
    provider: 'fal',
    title: 'Blocked',
    message: 'Prompt was blocked',
  })
}

export function testCtx(
  signal: AbortSignal = new AbortController().signal,
): JobContext & { updates: string[] } {
  const updates: string[] = []
  return {
    signal,
    updates,
    progress: (u) => {
      if (u.message) updates.push(u.message)
    },
    throwIfCancelled: () => {
      if (signal.aborted) throw new JobError('cancelled', 'Cancelled')
    },
  }
}
