import { afterEach, describe, expect, it } from 'vitest'
import { LyricsService, type LyricsDeps } from '../../../src/analysis/lyrics/client.ts'
import type { CtcVocabulary } from '../../../src/analysis/lyrics/align.ts'
import type { CtcEmissions } from '../../../src/analysis/lyrics/ctc.ts'
import { alignmentKey } from '../../../src/analysis/lyrics/text.ts'
import type { AlignTextArgs, TranscribeArgs } from '../../../src/analysis/lyrics/worker-api.ts'
import { STEM_MODEL_BYTES, StemSeparationService } from '../../../src/analysis/stems/client.ts'
import type { StemSeparationResult } from '../../../src/analysis/stems/worker-api.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createProject, type Asset, type LyricsDoc } from '../../../src/model/index.ts'
import { JobError, JobRunner } from '../../../src/shared/jobs.ts'
import {
  exposeWorker,
  type Endpoint,
  type WorkerApi,
  type WorkerCallContext,
} from '../../../src/shared/worker.ts'

// Decoded lengths (seconds) by file content, so each test sees which file reached the aligner.
const SECONDS: Record<string, number> = { song: 8, 'separated vocals': 3, 'stored vocals': 5 }
const decode = async (file: Blob, sampleRate: number) => ({
  sampleRate,
  channels: [new Float32Array(sampleRate * (SECONDS[await file.text()] ?? 0))],
})

const channels: MessageChannel[] = []
function worker(api: WorkerApi): () => Worker {
  return () => {
    const channel = new MessageChannel()
    channels.push(channel)
    exposeWorker(api, channel.port1 as unknown as Endpoint)
    return channel.port2 as unknown as Worker
  }
}
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close()
    c.port2.close()
  }
})

const emissions = () => ({ logProbs: new Float32Array(4), frames: 2, vocab: 2, frameSeconds: 0.02 })
const vocab = { ids: { A: 1 }, blank: 0 }

interface Call {
  method: string
  seconds: number
  sampleRate: number
  reusedEmissions: boolean
}

/** What the aligner heard in the vocals, for the `emissions` worker call. */
interface Heard {
  emissions: CtcEmissions
  vocab: CtcVocabulary
  voiced: { start: number; end: number }[]
}

function setup(options: { storedVocals?: boolean; alignFails?: boolean; heard?: Heard } = {}) {
  const calls: Call[] = []
  const record = (method: string, args: { vocals: { sampleRate: number; channels: Float32Array[] } }) =>
    calls.push({
      method,
      seconds: (args.vocals.channels[0]?.length ?? 0) / args.vocals.sampleRate,
      sampleRate: args.vocals.sampleRate,
      reusedEmissions: 'emissions' in args && args.emissions !== undefined,
    })
  const lyricsApi = {
    async align(args: AlignTextArgs, ctx: WorkerCallContext) {
      record('align', args)
      ctx.progress({ stage: 'align', fraction: 0.5 })
      if (options.alignFails) throw new JobError('model-load', 'Aligner failed')
      const lines = args.lines.map((l, i) => ({
        id: `l${i}`,
        text: l.text,
        start: i,
        end: i + 0.5,
        words: [],
      }))
      return { lines, emissions: emissions(), vocab }
    },
    async emissions(args: { vocals: { sampleRate: number; channels: Float32Array[] } }) {
      record('emissions', args)
      return options.heard ?? { emissions: emissions(), vocab, voiced: [] }
    },
    async transcribe(args: TranscribeArgs) {
      record('transcribe', args)
      return {
        words: [{ text: 'Bonjour', start: 1, end: 1.5 }],
        segmentStarts: [1],
        language: 'fr',
        languageProbability: 0.9,
        device: 'wasm',
        emissions: emissions(),
        vocab,
      }
    },
  }
  let separations = 0
  const stemsApi = {
    async separate(_args: unknown, ctx: WorkerCallContext): Promise<StemSeparationResult> {
      separations++
      ctx.progress({ stage: 'separate', fraction: 0.5 })
      ctx.progress({ stage: 'separate', fraction: 1 })
      const audio = (text: string) => ({
        data: new TextEncoder().encode(text).buffer,
        mimeType: 'audio/wav',
        extension: '.wav',
      })
      return {
        device: 'wasm',
        seconds: 1,
        stems: [
          { name: 'vocals', audio: audio('separated vocals') },
          { name: 'drums', audio: audio('drums') },
        ],
        stemFeatures: {},
      }
    },
  }

  const asset = (id: string, storageKey: string, origin: Asset['origin']): Asset => ({
    id,
    kind: 'audio',
    name: `${id}.wav`,
    mimeType: 'audio/wav',
    byteSize: 1,
    storageKey,
    duration: 8,
    origin,
    createdAt: new Date(0).toISOString(),
  })
  const editor = new ProjectEditor(createProject())
  const song = asset('song', 'song', { type: 'import' })
  editor.dispatch({ type: 'asset.add', asset: song })
  if (options.storedVocals) {
    editor.dispatch({ type: 'asset.add', asset: asset('v', 'stored vocals', { type: 'stem' }) })
    editor.dispatch(
      { type: 'analysis.setStems', assetId: song.id, stems: { vocals: 'v' }, stemFeatures: {} },
      { history: 'skip' },
    )
  }
  let stored = 0
  const store: LyricsDeps['store'] = {
    getFile: async (a) => new File([a.storageKey], a.name),
    storeBlob: async (blob, info) => ({
      ...asset(`stem${stored++}`, await blob.text(), info.origin),
      ...info,
    }),
  }
  const runner = new JobRunner()
  const service = new LyricsService({
    runner,
    decode,
    createWorker: worker(lyricsApi),
    stems: new StemSeparationService({ runner, decode, createWorker: worker(stemsApi) }),
  })
  return { service, editor, song, deps: { editor, store }, calls, separations: () => separations }
}

const TEXT = '[Verse]\nWe were young\n\nHold on tight\n'

describe('LyricsService.run', () => {
  it('separates stems first when the song has none, keeps them without an undo step and times the vocals', async () => {
    const { service, editor, song, deps, calls } = setup()
    const undoLabel = editor.undoLabel()
    const handle = service.run(song.id, { kind: 'time', text: TEXT }, deps)
    const progress: { stage?: string; fraction: number }[] = []
    handle.subscribe((s) => {
      if (s.progress.fraction !== undefined)
        progress.push({ stage: s.progress.stage, fraction: s.progress.fraction })
    })
    const { doc } = await handle.promise

    expect(doc.source).toBe('pasted')
    expect(doc.audioAssetId).toBe(song.id)
    expect(doc.lines.map((l) => l.text)).toEqual(['We were young', 'Hold on tight'])
    expect(calls).toEqual([{ method: 'align', seconds: 3, sampleRate: 16000, reusedEmissions: false }])
    const project = editor.getProject()
    const stems = project.analysis.audio[song.id]?.stems ?? {}
    expect(Object.keys(stems).sort()).toEqual(['drums', 'vocals'])
    expect(project.assets[stems.vocals ?? '']?.origin).toEqual({ type: 'stem', parentAssetId: song.id })
    expect(editor.undoLabel()).toBe(undoLabel)
    // One progress bar for the whole flow: separation fills its first part, the lyrics step the rest.
    const fractions = progress.map((p) => p.fraction)
    for (let i = 1; i < fractions.length; i++)
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] ?? 0)
    const separate = progress.filter((p) => p.stage === 'separate').map((p) => p.fraction)
    const align = progress.filter((p) => p.stage === 'align').map((p) => p.fraction)
    expect(separate).toHaveLength(2)
    expect(Math.max(...separate)).toBeLessThan(align[0] ?? 0)
    expect(align[0]).toBeLessThan(1)
    expect(fractions.at(-1)).toBe(1)
  })

  it('uses the stored vocals stem without separating, and reuses the aligner output on the next run', async () => {
    const { service, song, deps, calls, separations } = setup({ storedVocals: true })
    await service.run(song.id, { kind: 'time', text: TEXT }, deps).promise
    await service.run(song.id, { kind: 'time', text: 'We were young' }, deps).promise
    expect(separations()).toBe(0)
    expect(calls.map((c) => [c.seconds, c.reusedEmissions])).toEqual([
      [5, false],
      [5, true],
    ])
    expect(service.canRealign(song.id)).toBe(true)
  })

  it('drafts on the vocals and returns the detected language', async () => {
    const { service, song, deps, calls } = setup({ storedVocals: true })
    const result = await service.run(song.id, { kind: 'draft' }, deps).promise
    expect(calls).toEqual([{ method: 'transcribe', seconds: 5, sampleRate: 16000, reusedEmissions: false }])
    expect(result.language).toBe('fr')
    expect(result.languageProbability).toBe(0.9)
    expect(result.doc.source).toBe('transcribed')
    expect(result.doc.audioAssetId).toBe(song.id)
    expect(result.doc.lines.flatMap((l) => l.words.map((w) => w.text))).toEqual(['Bonjour'])
  })

  it('returns the chorus relabel when the lyrics repeat and the song has sections', async () => {
    const { service, editor, song, deps } = setup({ storedVocals: true })
    editor.dispatch(
      {
        type: 'analysis.setDetected',
        analysis: {
          assetId: song.id,
          version: '1',
          sections: [{ id: 's', start: 0, end: 8, label: 'verse' }],
        },
      },
      { history: 'skip' },
    )
    const text = 'Hold on tight\nWe are almost there\nA verse\nHold on tight\nWe are almost there\n'
    const { chorus } = await service.run(song.id, { kind: 'time', text }, deps).promise
    expect(chorus).toMatchObject({ type: 'analysis.setRefined', assetId: song.id })
    expect((await service.run(song.id, { kind: 'time', text: TEXT }, deps).promise).chorus).toBeNull()
  })

  it('keeps the separated stems when the lyrics step fails', async () => {
    const { service, editor, song, deps } = setup({ alignFails: true })
    await expect(service.run(song.id, { kind: 'time', text: TEXT }, deps).promise).rejects.toMatchObject({
      code: 'model-load',
    })
    expect(editor.getProject().analysis.audio[song.id]?.stems?.vocals).toBeDefined()
  })

  it('rejects lyrics without words before separating anything', async () => {
    const { service, song, deps, separations } = setup()
    await expect(
      service.run(song.id, { kind: 'time', text: '[Chorus]\n\n' }, deps).promise,
    ).rejects.toMatchObject({
      code: 'invalid-input',
    })
    expect(separations()).toBe(0)
  })
})

describe('LyricsService.estimate', () => {
  it('counts the stem model and separation time only when the song has no stems', async () => {
    const without = setup()
    const time = await without.service.estimate(without.editor.getProject(), without.song.id, {
      kind: 'time',
    })
    const draft = await without.service.estimate(without.editor.getProject(), without.song.id, {
      kind: 'draft',
    })
    const withStems = setup({ storedVocals: true })
    const timeWithStems = await withStems.service.estimate(withStems.editor.getProject(), withStems.song.id, {
      kind: 'time',
    })

    expect(time.separatesStems).toBe(true)
    expect(time.downloads).toEqual([
      { name: 'HTDemucs stem separator', bytes: STEM_MODEL_BYTES },
      { name: 'wav2vec2 lyrics aligner', bytes: expect.any(Number) },
    ])
    expect(draft.downloads.map((d) => d.name)).toEqual([
      'HTDemucs stem separator',
      'wav2vec2 lyrics aligner',
      'Whisper small',
    ])
    expect(draft.downloadBytes).toBeGreaterThan(time.downloadBytes + 200e6)
    expect(draft.seconds).toBeGreaterThan(time.seconds)
    expect(timeWithStems.separatesStems).toBe(false)
    expect(timeWithStems.downloads.map((d) => d.name)).toEqual(['wav2vec2 lyrics aligner'])
    expect(timeWithStems.seconds).toBeGreaterThan(0)
    expect(timeWithStems.seconds).toBeLessThan(time.seconds)
  })
})

describe('LyricsService.prepareRealign', () => {
  it('listens to the stored vocals once, so words re-align without the model afterwards', async () => {
    const { service, song, deps, calls, separations } = setup({ storedVocals: true })
    expect(service.canRealign(song.id)).toBe(false)
    const handle = service.prepareRealign(song.id, deps)
    expect(handle.snapshot().kind).toBe('analysis.realign')
    await handle.promise
    await service.prepareRealign(song.id, deps).promise
    expect(service.canRealign(song.id)).toBe(true)
    expect(calls.map((c) => [c.method, c.seconds, c.sampleRate])).toEqual([['emissions', 5, 16000]])
    expect(separations()).toBe(0)
  })

  it('re-times a dragged word with the voice regions it heard, so the next lines stay out of an instrumental', async () => {
    const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ'"
    const letters: CtcVocabulary = {
      ids: Object.fromEntries([...LETTERS].map((c, i) => [c, i + 2])),
      blank: 0,
      wordDelimiter: 1,
    }
    const V = LETTERS.length + 2
    const em: CtcEmissions = {
      logProbs: new Float32Array(1600 * V).fill(Math.log(0.01 / (V - 1))),
      frames: 1600,
      vocab: V,
      frameSeconds: 0.02,
    }
    for (let f = 0; f < em.frames; f++) em.logProbs[f * V] = Math.log(0.99)
    const spell = (word: string, frame: number, p: number) =>
      [...alignmentKey(word)].forEach((c, k) => {
        const row = (frame + 2 * k) * V
        em.logProbs[row] = Math.log(0.99 - p)
        em.logProbs[row + (letters.ids[c] as number)] = Math.log(p)
      })
    // "go" is sung at 30 s; at 10 s, in an instrumental, bleed from the separation sounds even more like it.
    spell('no', 50, 0.9)
    spell('go', 500, 0.9)
    spell('go', 1500, 0.6)
    const voiced = [
      { start: 0.5, end: 2 },
      { start: 29.5, end: 31 },
    ]
    const { service, song, deps } = setup({
      storedVocals: true,
      heard: { emissions: em, vocab: letters, voiced },
    })
    await service.prepareRealign(song.id, deps).promise
    const line = (id: string, text: string, start: number) => ({
      id,
      text,
      start,
      end: start + 0.3,
      words: [{ text, start, end: start + 0.3 }],
    })
    const doc: LyricsDoc = {
      audioAssetId: song.id,
      source: 'pasted',
      lines: [line('a', 'no', 1.4), line('b', 'go', 10)],
    }
    const fixed = service.realignFrom(doc, 0, 0, 1)
    expect(fixed?.lines[0]?.start).toBe(1)
    expect(fixed?.lines[1]?.start).toBe(30)
    // Timing an untimed line after an edit uses them too.
    const edited: LyricsDoc = { ...doc, lines: [line('a', 'no', 1), { id: 'b', text: 'go', words: [] }] }
    expect(service.realignLine(edited, 1)?.lines[1]?.start).toBe(30)
  })
})
