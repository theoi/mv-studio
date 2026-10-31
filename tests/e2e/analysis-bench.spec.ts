import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

const SONG_DIR = path.join(FIXTURE_DIR, 'jamendolyrics/mp3')
const COUNT = Number(process.env.ANALYSIS_BENCH ?? 0)

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

// Timing benchmark on real songs: ANALYSIS_BENCH=<song count> after scripts/fetch-analysis-fixtures.sh.
test('analysis speed on real songs', async ({ page }) => {
  test.skip(!COUNT || !existsSync(SONG_DIR), 'set ANALYSIS_BENCH and fetch the songs first')
  test.setTimeout(COUNT * 120_000)
  const files = readdirSync(SONG_DIR)
    .filter((f) => f.endsWith('.mp3'))
    .sort()
    .filter((_, i, all) => i % Math.max(1, Math.floor(all.length / COUNT)) === 0)
    .slice(0, COUNT)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    files.map((f) => path.join(SONG_DIR, f)),
  )
  const rows = await page.evaluate(async () => {
    const { analysis, files } = window.mvStudio
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
      out.push({
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
  })
  for (const r of rows) {
    const line = [
      r.name.slice(0, 32).padEnd(32),
      `${r.duration.toFixed(0)} s`,
      `decode ${(r.decodeMs / 1000).toFixed(2)} s`,
      `fast ${(r.fastMs / 1000).toFixed(2)} s`,
      `refine ${(r.refineMs / 1000).toFixed(1)} s`,
      `bpm ${r.fastBpm} -> ${r.refinedBpm}`,
      `F(fast, refined) ${fmeasure(r.fastBeats, r.refinedBeats).toFixed(3)}`,
      r.refinedSections,
    ]
    console.log(line.join(' | '))
  }
  expect(rows).toHaveLength(files.length)
})
