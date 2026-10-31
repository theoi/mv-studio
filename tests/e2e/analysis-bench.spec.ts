import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

const DATA_DIR = path.join(FIXTURE_DIR, 'jamendolyrics')
const SONG_DIR = path.join(DATA_DIR, 'mp3')
const COUNT = Number(process.env.ANALYSIS_BENCH ?? 0)
const STEMS = Boolean(process.env.ANALYSIS_BENCH_STEMS)
// 'align' times the dataset lyrics; 'base' or 'small' also drafts lyrics with that Whisper size.
const LYRICS = process.env.ANALYSIS_BENCH_LYRICS ?? ''

function fmeasure(est: number[], ref: number[], tol = 0.07): number {
  const used = new Uint8Array(ref.length)
  let hit = 0
  for (const e of est) {
    const k = ref.findIndex((r, i) => !used[i] && Math.abs(r - e) <= tol)
    if (k >= 0) {
      used[k] = 1
      hit++
    }
  }
  const p = hit / Math.max(1, est.length)
  const r = hit / Math.max(1, ref.length)
  return p + r ? (2 * p * r) / (p + r) : 0
}

interface LyricsTruth {
  text: string
  onsets: number[]
}

function lyricsTruth(file: string): LyricsTruth | undefined {
  const name = file.replace(/\.mp3$/, '')
  const textFile = path.join(DATA_DIR, 'lyrics', `${name}.txt`)
  const wordsFile = path.join(DATA_DIR, 'words', `${name}.csv`)
  if (!existsSync(textFile) || !existsSync(wordsFile)) return undefined
  const onsets = readFileSync(wordsFile, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => Number(l.split(',')[0]))
  return { text: readFileSync(textFile, 'utf8'), onsets }
}

// Timing benchmark on real songs: ANALYSIS_BENCH=<song count> after scripts/fetch-analysis-fixtures.sh.
// ANALYSIS_BENCH_STEMS=1 also times stem separation (minutes per song on CPU). ANALYSIS_BENCH_LYRICS (see above)
// times lyrics on the vocals stem (including the separation unless stems are on) and reports word onset errors
// against the dataset.
test('analysis speed on real songs', async ({ page }) => {
  test.skip(!COUNT || !existsSync(SONG_DIR), 'set ANALYSIS_BENCH and fetch the songs first')
  test.setTimeout(COUNT * (STEMS ? 900_000 : 120_000) + (LYRICS ? COUNT * 600_000 : 0))
  const files = readdirSync(SONG_DIR)
    .filter((f) => f.endsWith('.mp3'))
    .sort()
    .filter((_, i, all) => i % Math.max(1, Math.floor(all.length / COUNT)) === 0)
    .slice(0, COUNT)
  const truths = files.map((f) => (LYRICS ? lyricsTruth(f) : undefined))
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    files.map((f) => path.join(SONG_DIR, f)),
  )
  const rows = await page.evaluate(
    async ({ withStems, lyrics, truths }) => {
      const { analysis, files, media, model } = window.mvStudio
      const service = new analysis.SongAnalysisService()
      const out = []
      for (const [i, file] of files().entries()) {
        const t0 = performance.now()
        const audio = await analysis.decodeAudioFile(file)
        const duration = audio.channels[0].length / audio.sampleRate
        const t1 = performance.now()
        const fast = await service.analyze(`s${i}`, audio).promise
        const t2 = performance.now()
        const refined = await service.refine(`s${i}`).promise
        const t3 = performance.now()
        await service.release(`s${i}`)
        let stems: { seconds: number; device: string } | undefined
        let stemResult
        if (withStems) {
          stemResult = await new analysis.StemSeparationService().separate(
            await analysis.decodeAudioFile(file),
          ).promise
          stems = { seconds: stemResult.seconds, device: stemResult.device }
        }
        let lyricRow:
          { alignMs: number; errors: number[]; transcribeMs?: number; language?: string } | undefined
        const truth = truths[i]
        if (lyrics && truth) {
          // The lyrics flow separates the stems itself unless the song already has them.
          const lyricsService = new analysis.LyricsService()
          const song = await media.mediaStore.importFile(file)
          const editor = new model.ProjectEditor(model.createProject())
          editor.dispatch({ type: 'asset.add', asset: song })
          if (stemResult)
            editor.dispatch(await analysis.stemEdits(stemResult, song, media.mediaStore), { history: 'skip' })
          const deps = { editor, store: media.mediaStore }
          const a0 = performance.now()
          const { doc } = await lyricsService.run(song.id, { kind: 'time', text: truth.text }, deps).promise
          const alignMs = performance.now() - a0
          const words = doc.lines.flatMap((l: { words: { start: number }[] }) => l.words)
          const errors =
            words.length === truth.onsets.length
              ? words.map((w: { start: number }, k: number) => w.start - (truth.onsets[k] as number))
              : []
          lyricRow = { alignMs, errors }
          if (lyrics !== 'align') {
            const b0 = performance.now()
            const draft = await lyricsService.run(song.id, { kind: 'draft', size: lyrics }, deps).promise
            lyricRow.transcribeMs = performance.now() - b0
            lyricRow.language = draft.language
          }
        }
        out.push({
          stems,
          lyrics: lyricRow,
          name: file.name,
          duration,
          decodeMs: t1 - t0,
          fastMs: t2 - t1,
          refineMs: t3 - t2,
          fastBpm: fast.tempo.bpm,
          refinedBpm: refined.tempo.bpm,
          fastBeats: fast.beats,
          refinedBeats: refined.beats,
          sections: fast.sections.length,
          refinedSections: refined.sections.map((s: { label: string }) => s.label).join(' '),
        })
      }
      service.dispose()
      return out
    },
    { withStems: STEMS, lyrics: LYRICS, truths },
  )
  const allErrors: number[] = []
  for (const r of rows) {
    const abs = r.lyrics?.errors.map(Math.abs) ?? []
    allErrors.push(...abs)
    const line = [
      r.name.slice(0, 32).padEnd(32),
      `${r.duration.toFixed(0)} s`,
      `decode ${(r.decodeMs / 1000).toFixed(2)} s`,
      `fast ${(r.fastMs / 1000).toFixed(2)} s`,
      `refine ${(r.refineMs / 1000).toFixed(1)} s`,
      `bpm ${r.fastBpm} -> ${r.refinedBpm}`,
      `F(fast, refined) ${fmeasure(r.fastBeats, r.refinedBeats).toFixed(3)}`,
      r.refinedSections,
      r.stems ? `stems ${r.stems.seconds.toFixed(0)} s (${r.stems.device})` : '',
      r.lyrics
        ? `lyrics ${(r.lyrics.alignMs / 1000).toFixed(1)} s, word onset AAE ${
            abs.length ? (abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(3) : 'n/a'
          } s` +
          (r.lyrics.transcribeMs
            ? `, transcribe ${(r.lyrics.transcribeMs / 1000).toFixed(1)} s (${r.lyrics.language})`
            : '')
        : '',
    ]
    console.log(line.join(' | '))
  }
  if (allErrors.length) {
    const within = allErrors.filter((e) => e <= 0.3).length / allErrors.length
    console.log(
      `lyrics: ${allErrors.length} words, AAE ${(allErrors.reduce((a, b) => a + b, 0) / allErrors.length).toFixed(3)} s, ${(within * 100).toFixed(1)}% within 0.3 s`,
    )
  }
  expect(rows).toHaveLength(files.length)
})
