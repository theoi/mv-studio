/// <reference types="vite/client" />
/**
 * Chorus accuracy with and without pasted lyrics on the JamendoLyrics songs from scripts/fetch-analysis-fixtures.sh.
 * The reference chorus is each song's most repeated stanza (blank-line paragraphs grouped when their word sets overlap
 * by more than 60%), timed with the reference word times. With `--reference to-next`, each of its stanzas runs on
 * until the next stanza starts, at most twice its sung length, as a section would.
 *
 *   node scripts/eval-chorus.ts --cache ~/devdata/cache [--reference stanza|to-next] [--src ../other-checkout]
 *     [--songs a,b] [--data dir] [--vocab vocab.json] [--tsv out.tsv] [--verbose]
 *
 * Each song is analyzed as the app does it, with the refined (Beat This!) beats, bars and sections. Beat This! runs on
 * onnxruntime-web's WASM build in Node, a minute or two per song; its output is cached in `--cache` as
 * `<file>.beatthis-logits.json` (and the model as beat-this-final0.onnx), so later runs take seconds. Conditions:
 *
 * audio      the detected chorus, without lyrics
 * published  lyrics with the dataset's own line breaks, timed with its reference word times
 * pauses     the same words, with lines broken at pauses as a transcription would be
 * one-line   the same words pasted as one line
 * aligned    the published lines timed by the app's aligner, for songs with `<file>.em.f32` or
 *            `<file>.vocals.model_quantized.em.f32` (wav2vec2 log-probabilities, as for eval-lyric-timing.ts) in --cache
 *
 * --src      measures another checkout's analysis and chorus code (for example main) with this harness
 *
 * P is the share of the estimated chorus inside the reference, R the share of the reference covered, both averaged
 * over songs, and F their harmonic mean. "found" counts songs with P above 0.5. With lyrics, songs are better or
 * worse when their own F moves by more than 0.1 from the audio chorus.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type * as AlignModule from '../src/analysis/lyrics/align.ts'
import type * as DocModule from '../src/analysis/lyrics/doc.ts'
import type * as TextModule from '../src/analysis/lyrics/text.ts'
import type * as ModelsModule from '../src/analysis/models.ts'
import type * as SongModule from '../src/analysis/song.ts'
import type * as ChorusModule from '../src/analysis/structure/chorus.ts'
import type { LyricLine, LyricWord, SongSection } from '../src/model/types.ts'

const { values: args } = parseArgs({
  options: {
    cache: { type: 'string' },
    src: { type: 'string', default: path.join(import.meta.dirname, '..') },
    data: {
      type: 'string',
      default: path.join(import.meta.dirname, '../tests/fixtures/.cache/jamendolyrics'),
    },
    vocab: { type: 'string' },
    songs: { type: 'string' },
    tsv: { type: 'string' },
    reference: { type: 'string', default: 'stanza' },
    verbose: { type: 'boolean', default: false },
  },
})
if (!args.cache) throw new Error('--cache <dir> is required')
const cache = args.cache
const data = args.data
fs.mkdirSync(cache, { recursive: true })

const from = <T>(file: string): Promise<T> =>
  import(pathToFileURL(path.join(path.resolve(args.src), file)).href)
const song = await from<typeof SongModule>('src/analysis/song.ts')
const chorus = await from<typeof ChorusModule>('src/analysis/structure/chorus.ts')
const doc = await from<typeof DocModule>('src/analysis/lyrics/doc.ts')
const align = await from<typeof AlignModule>('src/analysis/lyrics/align.ts')
const text = await from<typeof TextModule>('src/analysis/lyrics/text.ts')
const models = await from<typeof ModelsModule>('src/analysis/models.ts')

interface Span {
  start: number
  end: number
}
const MARKER = /^[[(].*[\])]$/

const words = (name: string): { text: string; words: LyricWord[] } | null => {
  const tf = path.join(data, 'lyrics', `${name}.txt`)
  const wf = path.join(data, 'words', `${name}.csv`)
  if (!fs.existsSync(tf) || !fs.existsSync(wf)) return null
  const raw = fs.readFileSync(tf, 'utf8')
  const tokens = raw.split(/\s+/).filter(Boolean)
  const times = fs
    .readFileSync(wf, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(',').map(Number))
  if (times.length !== tokens.length) return null
  return {
    text: raw,
    words: tokens.map((t, i) => ({ text: t, start: times[i]![0]!, end: times[i]![1]! })),
  }
}

const normalized = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  let common = 0
  for (const x of A) if (B.has(x)) common++
  return common / (A.size + B.size - common || 1)
}

/** The most repeated stanza's places, each running on to the next stanza (at most twice its sung length) for to-next. */
function referenceChorus(name: string): Span[] {
  const d = words(name)
  if (!d) return []
  const stanzas: (Span & { words: string[]; group: number })[] = []
  let w = 0
  for (const p of d.text.split(/\n\s*\n/).map((s) => s.trim())) {
    const count = p.split(/\s+/).filter(Boolean).length
    if (!count) continue
    stanzas.push({
      start: d.words[w]!.start,
      end: d.words[w + count - 1]!.end,
      words: normalized(p),
      group: -1,
    })
    w += count
  }
  let groups = 0
  for (const [i, s] of stanzas.entries()) {
    if (s.group >= 0) continue
    s.group = groups++
    for (const t of stanzas.slice(i + 1))
      if (t.group < 0 && jaccard(s.words, t.words) > 0.6) t.group = s.group
  }
  const sizes = new Map<number, number>()
  for (const s of stanzas) sizes.set(s.group, (sizes.get(s.group) ?? 0) + 1)
  let group = -1
  let most = 1
  for (const [g, n] of sizes) if (n > most) [group, most] = [g, n]
  return stanzas.flatMap((s, i) => {
    if (s.group !== group) return []
    const next = args.reference === 'to-next' ? stanzas[i + 1]?.start : undefined
    return [{ start: s.start, end: next === undefined ? s.end : Math.min(next, s.end + (s.end - s.start)) }]
  })
}

function publishedLines(name: string): LyricLine[] | null {
  const d = words(name)
  if (!d) return null
  const out: LyricLine[] = []
  let w = 0
  for (const raw of d.text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const lineWords = d.words.slice(w, w + line.split(/\s+/).length)
    w += lineWords.length
    if (MARKER.test(line) || !lineWords.length) continue
    out.push({
      id: `l${out.length}`,
      text: line,
      start: lineWords[0]!.start,
      end: lineWords.at(-1)!.end,
      words: lineWords,
    })
  }
  return out
}

const f32 = (file: string): Float32Array => {
  const b = fs.readFileSync(file)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
const emFile = (name: string) =>
  [`${name}.vocals.model_quantized.em.f32`, `${name}.em.f32`]
    .map((f) => path.join(cache, f))
    .find((f) => fs.existsSync(f))

let vocab: ReturnType<typeof align.ctcVocabulary> | undefined
async function alignedLines(name: string): Promise<LyricLine[] | null> {
  const file = emFile(name)
  if (!file) return null
  vocab ??= align.ctcVocabulary(
    JSON.parse(
      args.vocab
        ? fs.readFileSync(args.vocab, 'utf8')
        : await (await fetch(models.WAV2VEC2_MODEL.files.vocab!.url)).text(),
    ) as Record<string, number>,
  )
  const logProbs = f32(file)
  const em = { logProbs, vocab: 32, frames: logProbs.length / 32, frameSeconds: 0.02 }
  const lines = text.parseLyricsText(fs.readFileSync(path.join(data, 'lyrics', `${name}.txt`), 'utf8'))
  return align.alignLines(em, vocab, lines)
}

let beatThis:
  | Promise<{
      run(spect: Float32Array, frames: number): Promise<{ beat: Float32Array; downbeat: Float32Array }>
    }>
  | undefined
function beatThisModel() {
  beatThis ??= (async () => {
    const spec = models.BEAT_THIS_MODEL.files.model!
    const file = path.join(cache, 'beat-this-final0.onnx')
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(await (await fetch(spec.url)).arrayBuffer()))
    const bytes = fs.readFileSync(file)
    if (spec.sha256 && createHash('sha256').update(bytes).digest('hex') !== spec.sha256)
      throw new Error(`${file} does not match the app's Beat This! model; delete it to download it again`)
    const ort = await import('onnxruntime-web')
    const session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] })
    return {
      async run(spect: Float32Array, frames: number) {
        const out = await session.run({ spectrogram: new ort.Tensor('float32', spect, [1, frames, 128]) })
        return { beat: out.beat!.data as Float32Array, downbeat: out.downbeat!.data as Float32Array }
      },
    }
  })()
  return beatThis
}

/** The song's refined analysis (beats, bars when found, sections), as the app stores it. */
async function refinedAnalysis(name: string): Promise<SongModule.RefinedFields> {
  const pcm = f32Stdout([
    '-i',
    path.join(data, 'mp3', `${name}.mp3`),
    '-ac',
    '2',
    '-ar',
    '44100',
    '-f',
    'f32le',
    '-',
  ])
  const n = pcm.length / 2
  const channels = [new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) {
    channels[0]![i] = pcm[2 * i]!
    channels[1]![i] = pcm[2 * i + 1]!
  }
  const { state } = song.analyzeSongFast(name, { sampleRate: 44100, channels })
  const logitsFile = path.join(cache, `${name}.beatthis-logits.json`)
  if (fs.existsSync(logitsFile)) {
    const l = JSON.parse(fs.readFileSync(logitsFile, 'utf8')) as {
      fps: number
      beat: number[]
      downbeat: number[]
    }
    state.logits = { fps: l.fps, beat: Float32Array.from(l.beat), downbeat: Float32Array.from(l.downbeat) }
  }
  const { fields } = await song.refineSongBeats(state, beatThisModel)
  if (!fs.existsSync(logitsFile) && state.logits) {
    const round = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 1000) / 1000)
    const { fps, beat, downbeat } = state.logits
    fs.writeFileSync(logitsFile, JSON.stringify({ fps, beat: round(beat), downbeat: round(downbeat) }))
  }
  return fields
}
function f32Stdout(ffmpegArgs: string[]): Float32Array {
  const b = execFileSync('ffmpeg', ['-v', 'error', ...ffmpegArgs], { maxBuffer: 2 ** 31 })
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

const overlap = (a: Span[], b: Span[]) =>
  a.reduce(
    (o, x) => o + b.reduce((p, y) => p + Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start)), 0),
    0,
  )
const length = (a: Span[]) => a.reduce((s, x) => s + x.end - x.start, 0)
const choruses = (sections: readonly SongSection[]): Span[] => sections.filter((s) => s.label === 'chorus')

interface Score {
  name: string
  p: number
  r: number
}
const f1 = (p: number, r: number) => (p + r ? (2 * p * r) / (p + r) : 0)
const CONDITIONS = ['audio', 'published', 'pauses', 'one-line', 'aligned'] as const
const scores = new Map<string, Score[]>(CONDITIONS.map((c) => [c, []]))
const tsv = ['song\tcondition\tP\tR\tchorus']
const wanted = args.songs?.split(',')
const names = fs
  .readdirSync(path.join(data, 'mp3'))
  .filter((f) => f.endsWith('.mp3'))
  .map((f) => f.slice(0, -'.mp3'.length))
  .filter((n) => (!wanted || wanted.includes(n)) && referenceChorus(n).length)
  .sort()
for (const name of names) {
  const reference = referenceChorus(name)
  const refined = await refinedAnalysis(name)
  const sections = refined.sections ?? []
  const analysis = { assetId: name, version: 'eval', ...refined }
  const score = (condition: string, estimate: Span[]) => {
    const o = overlap(estimate, reference)
    const s = { name, p: estimate.length ? o / length(estimate) : 0, r: o / length(reference) }
    scores.get(condition)!.push(s)
    const spans = estimate.map((x) => `${x.start.toFixed(1)}-${x.end.toFixed(1)}`).join(' ')
    tsv.push([name, condition, s.p.toFixed(3), s.r.toFixed(3), spans].join('\t'))
    if (args.verbose)
      console.log(`${name.padEnd(50)} ${condition.padEnd(10)} P ${s.p.toFixed(2)} R ${s.r.toFixed(2)}`)
  }
  score('audio', choruses(sections))
  const d = words(name)
  const pauses = d && doc.groupWordsIntoLines(d.words).map((w, i) => doc.lineFromWords(w, `p${i}`))
  for (const [condition, lines] of [
    ['published', publishedLines(name)],
    ['pauses', pauses],
    ['one-line', d && [doc.lineFromWords(d.words, 'all')]],
    ['aligned', await alignedLines(name)],
  ] as const) {
    if (!lines) continue
    const command = chorus.lyricChorusCommand(analysis, { source: 'pasted', lines })
    score(
      condition,
      choruses(command?.type === 'analysis.setRefined' ? (command.refined.sections ?? []) : sections),
    )
  }
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
const audio = new Map(scores.get('audio')!.map((s) => [s.name, s]))
const audioF = (name: string) => f1(audio.get(name)!.p, audio.get(name)!.r)
const summary = (s: Score[]) => {
  const P = mean(s.map((x) => x.p))
  const R = mean(s.map((x) => x.r))
  return `P ${P.toFixed(3)}  R ${R.toFixed(3)}  F ${f1(P, R).toFixed(3)}  found ${s.filter((x) => x.p > 0.5).length}`
}
for (const condition of CONDITIONS) {
  const s = scores.get(condition)!
  if (!s.length) continue
  let line = `${condition.padEnd(10)} songs ${String(s.length).padStart(3)}  ${summary(s)}`
  if (condition !== 'audio') {
    const delta = s.map((x) => f1(x.p, x.r) - audioF(x.name))
    const good = s.filter((x) => audioF(x.name) >= 0.8)
    const harmed = good.filter((x) => f1(x.p, x.r) < audioF(x.name) - 0.1).length
    line += `  better ${delta.filter((x) => x > 0.1).length}  worse ${delta.filter((x) => x < -0.1).length}  good audio choruses harmed ${harmed} of ${good.length}`
    if (s.length < audio.size)
      line += `  (audio on these songs: ${summary(s.map((x) => audio.get(x.name)!))})`
  }
  console.log(line)
}
if (args.tsv) fs.writeFileSync(args.tsv, tsv.join('\n') + '\n')
