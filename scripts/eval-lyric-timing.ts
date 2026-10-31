/// <reference types="vite/client" />
/**
 * Word-timing accuracy of pasted lyrics on JamendoLyrics songs, from cached vocals and wav2vec2 emissions (no model
 * runs here). For each song in `--cache`, it needs `<file>.vocals16k.f32` (the vocals stem, 16 kHz mono float32) and
 * `<file>.vocals.model_quantized.em.f32` or `<file>.em.f32` (log-probabilities, 50 frames per second × 32 tokens), and
 * the dataset from scripts/fetch-analysis-fixtures.sh. It times `lyrics/<file>.txt` with the app's aligner and compares
 * each word's start with `words/<file>.csv`. Like the app, it finds where someone sings from the vocals and the song
 * (`mp3/<file>.mp3`, decoded with ffmpeg to `<file>.mix16k.f32` in --cache on the first run).
 *
 *   node scripts/eval-lyric-timing.ts --cache ~/devdata/cache [--baseline | --no-mix] [--songs a,b]
 *     [--gap 40 [--gap-at end] [--gap-leak=-25]] [--lines one|stanza] [--unvoiced-cost n] [--line-pause n]
 *     [--data dir] [--vocab vocab.json] [--verbose]
 *
 * --baseline   times without voice activity and line pauses, as before they were added
 * --no-mix     finds where someone sings from the vocals alone, as before the song was used
 * --unvoiced-cost, --line-pause   override the aligner's defaults (0 turns either off)
 * --gap s      inserts s seconds of the song's own longest instrumental stretch (looped) at the line boundary nearest
 *              the middle, or after the last line with --gap-at end, and shifts the reference after it
 * --gap-leak dB   fills the inserted stretch of the vocals with the song's own, dB lower, like the band leaking into
 *              the stem during a loud instrumental
 * --lines      pastes the lyrics as one line, or one line per stanza, instead of the published lines
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { alignLines, ctcVocabulary } from '../src/analysis/lyrics/align.ts'
import { parseLyricsText } from '../src/analysis/lyrics/text.ts'
import { voiceActivity } from '../src/analysis/lyrics/vad.ts'
import { WAV2VEC2_MODEL } from '../src/analysis/models.ts'

const { values: args } = parseArgs({
  options: {
    cache: { type: 'string' },
    data: {
      type: 'string',
      default: path.join(import.meta.dirname, '../tests/fixtures/.cache/jamendolyrics'),
    },
    vocab: { type: 'string' },
    songs: { type: 'string' },
    baseline: { type: 'boolean', default: false },
    'no-mix': { type: 'boolean', default: false },
    gap: { type: 'string' },
    'gap-at': { type: 'string', default: 'middle' },
    'gap-leak': { type: 'string' },
    lines: { type: 'string', default: 'published' },
    'unvoiced-cost': { type: 'string' },
    'line-pause': { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
})
if (!args.cache) throw new Error('--cache <dir> is required')
const cache = args.cache
const data = args.data
const FPS = 50
const RATE = 16000
const TOKENS = 32
const HOP = RATE / FPS

const vocabJson = args.vocab
  ? fs.readFileSync(args.vocab, 'utf8')
  : await (await fetch(WAV2VEC2_MODEL.files.vocab!.url)).text()
const vocab = ctcVocabulary(JSON.parse(vocabJson) as Record<string, number>)

const f32 = (file: string): Float32Array => {
  const b = fs.readFileSync(file)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
/** The song at 16 kHz mono, as the app decodes it for the aligner. */
function mix16k(name: string): Float32Array {
  const file = path.join(cache, `${name}.mix16k.f32`)
  if (!fs.existsSync(file)) {
    const mp3 = path.join(data, 'mp3', `${name}.mp3`)
    const pcm = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', mp3, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
      {
        maxBuffer: 2 ** 31,
      },
    )
    fs.writeFileSync(file, pcm)
  }
  return f32(file)
}
const emFile = (name: string) =>
  [`${name}.vocals.model_quantized.em.f32`, `${name}.em.f32`]
    .map((f) => path.join(cache, f))
    .find((f) => fs.existsSync(f))

const language = new Map<string, string>()
for (const row of fs.readFileSync(path.join(data, 'JamendoLyrics.csv'), 'utf8').trim().split('\n').slice(1)) {
  const cells = row.split(',')
  language.set((cells[1] ?? '').replace(/\.mp3$/, ''), cells[6] ?? '?')
}
const wanted = args.songs?.split(',')
const names = fs
  .readdirSync(cache)
  .filter((f) => f.endsWith('.vocals16k.f32'))
  .map((f) => f.slice(0, -'.vocals16k.f32'.length))
  .filter(
    (n) =>
      emFile(n) && fs.existsSync(path.join(data, 'words', `${n}.csv`)) && (!wanted || wanted.includes(n)),
  )
  .sort()

/** Frames [a, b) of `src` (rows of `width`), repeated to `len` frames. */
function loop(src: Float32Array, width: number, a: number, b: number, len: number): Float32Array {
  const out = new Float32Array(len * width)
  for (let i = 0; i < len; i++) {
    const k = a + (i % (b - a))
    out.set(src.subarray(k * width, (k + 1) * width), i * width)
  }
  return out
}
function splice(src: Float32Array, at: number, insert: Float32Array): Float32Array {
  const out = new Float32Array(src.length + insert.length)
  out.set(src.subarray(0, at))
  out.set(insert, at)
  out.set(src.subarray(at), at + insert.length)
  return out
}

interface Errors {
  all: number[]
  afterGap: number[]
}
const total: Errors = { all: [], afterGap: [] }
const byLanguage = new Map<string, number[]>()
const rows: string[] = []
for (const name of names) {
  const raw = fs.readFileSync(path.join(data, 'lyrics', `${name}.txt`), 'utf8')
  const lines =
    args.lines === 'one'
      ? [{ text: raw.split(/\s+/).filter(Boolean).join(' ') }]
      : args.lines === 'stanza'
        ? raw
            .split(/\n\s*\n/)
            .map((p) => p.split(/\s+/).filter(Boolean).join(' '))
            .filter(Boolean)
            .map((text) => ({ text }))
        : parseLyricsText(raw).map((l) => ({ text: l.text }))
  const lineWords = lines.map((l) => l.text.split(/\s+/).filter(Boolean).length)
  const reference = fs
    .readFileSync(path.join(data, 'words', `${name}.csv`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => {
      const [start, end] = l.split(',').map(Number)
      return { start: start as number, end: end as number }
    })
  if (lineWords.reduce((a, b) => a + b, 0) !== reference.length) {
    console.log(
      `skipped ${name}: ${lineWords.reduce((a, b) => a + b, 0)} words, reference ${reference.length}`,
    )
    continue
  }
  let logProbs: Float32Array = f32(emFile(name)!)
  let pcm: Float32Array = f32(path.join(cache, `${name}.vocals16k.f32`))
  let mix = args['no-mix'] || args.baseline ? undefined : mix16k(name)
  if (args.gap) {
    const seconds = Number(args.gap)
    let quiet = { a: 0, b: reference[0]!.start }
    for (let i = 1; i < reference.length; i++)
      if (reference[i]!.start - reference[i - 1]!.end > quiet.b - quiet.a)
        quiet = { a: reference[i - 1]!.end, b: reference[i]!.start }
    if (pcm.length / RATE - reference.at(-1)!.end > quiet.b - quiet.a)
      quiet = { a: reference.at(-1)!.end, b: pcm.length / RATE }
    const fa = Math.ceil((quiet.a + 0.5) * FPS)
    const fb = Math.floor((quiet.b - 0.5) * FPS)
    if (fb - fa < 2 * FPS) {
      console.log(`skipped ${name}: no instrumental stretch of 3 s to insert`)
      continue
    }
    let at = reference.at(-1)!.end + 1
    if (args['gap-at'] !== 'end') {
      const middle = pcm.length / RATE / 2
      let best = Infinity
      let w = 0
      for (const n of lineWords.slice(0, -1)) {
        w += n
        const t = (reference[w - 1]!.end + reference[w]!.start) / 2
        if (Math.abs(t - middle) < best) [best, at] = [Math.abs(t - middle), t]
      }
    }
    const frames = Math.round(seconds * FPS)
    const af = Math.round(at * FPS)
    logProbs = splice(logProbs, af * TOKENS, loop(logProbs, TOKENS, fa, fb, frames))
    const leak = args['gap-leak'] === undefined ? undefined : 10 ** (Number(args['gap-leak']) / 20)
    const songGap = mix || leak !== undefined ? loop(mix ?? mix16k(name), HOP, fa, fb, frames) : undefined
    const vocalsGap = leak === undefined ? loop(pcm, HOP, fa, fb, frames) : songGap!.map((v) => v * leak)
    pcm = splice(pcm, af * HOP, vocalsGap)
    if (mix) mix = splice(mix, af * HOP, songGap!)
    for (const r of reference)
      if (r.start >= at) {
        r.start += frames / FPS
        r.end += frames / FPS
      }
  }
  const em = { logProbs, vocab: TOKENS, frames: logProbs.length / TOKENS, frameSeconds: 1 / FPS }
  const aligned = alignLines(
    em,
    vocab,
    lines,
    args.baseline
      ? { linePause: 0 }
      : {
          voiced: voiceActivity(pcm, RATE, { mix }),
          unvoicedCost: args['unvoiced-cost'] === undefined ? undefined : Number(args['unvoiced-cost']),
          linePause: args['line-pause'] === undefined ? undefined : Number(args['line-pause']),
        },
  )
  const errors = aligned.flatMap((l) => l.words).map((w, i) => Math.abs(w.start - reference[i]!.start))
  total.all.push(...errors)
  total.afterGap.push(...errors.filter((_, i) => i > 0 && reference[i]!.start - reference[i - 1]!.end >= 8))
  const lang = language.get(name) ?? '?'
  byLanguage.set(lang, [...(byLanguage.get(lang) ?? []), ...errors])
  rows.push(`${name.padEnd(50)} ${lang.padEnd(8)} ${stat(errors)}`)
}

function stat(e: number[]): string {
  const within = e.filter((x) => x <= 0.3).length / (e.length || 1)
  const mean = e.reduce((a, b) => a + b, 0) / (e.length || 1)
  return `words ${String(e.length).padStart(4)}  within 0.3 s ${(100 * within).toFixed(1).padStart(5)}%  mean ${mean.toFixed(3)} s  off by >5 s ${e.filter((x) => x > 5).length}`
}
if (args.verbose) console.log(rows.join('\n'))
for (const [lang, e] of [...byLanguage].sort()) console.log(`${lang.padEnd(8)} ${stat(e)}`)
console.log(`${'after 8 s+ gaps'.padEnd(16)} ${stat(total.afterGap)}`)
console.log(
  `all ${rows.length} songs (${args.baseline ? 'baseline' : `voice activity${args['no-mix'] ? ' without the song' : ''} + line pauses`}): ${stat(total.all)}`,
)
