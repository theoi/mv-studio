import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * Writes the real-song fixtures for auto-cut's rhythm tests (not part of CI): analyzes CC BY / BY-SA songs from
 * JamendoLyrics with the app's own analysis and keeps what auto-cut reads (tempo, beats, downbeats, sections and
 * the energy curve at 10 Hz) in tests/unit/vision/autocut/songs/<song>.json. The audio itself is never committed.
 *
 *   sh scripts/fetch-analysis-fixtures.sh en && npm run build
 *   AUTOCUT_SONGS=1 npx playwright test tests/e2e/autocut-songs.spec.ts
 *   npx prettier --write tests/unit/vision/autocut/songs
 */
const SONGS = [
  {
    file: 'Rxbyn_-_Bad_Side',
    artist: 'Rxbyn',
    title: 'Bad Side',
    license: 'CC BY',
    url: 'https://www.jamendo.com/track/1556580/bad-side',
  },
  {
    file: 'Cortez_-_Feel__Stripped_',
    artist: 'Cortez',
    title: 'Feel (Stripped)',
    license: 'CC BY',
    url: 'https://www.jamendo.com/track/1481500/feel-stripped',
  },
  {
    file: 'Lower_Loveday_-_Is_It_Right_',
    artist: 'Lower Loveday',
    title: 'Is It Right?',
    license: 'CC BY-SA',
    url: 'https://www.jamendo.com/track/1559614/is-it-right',
  },
]
const MP3 = path.join(FIXTURE_DIR, 'jamendolyrics', 'mp3')
const OUT = path.resolve('tests/unit/vision/autocut/songs')
const ENERGY_RATE = 10

const r3 = (t: number) => Math.round(t * 1000) / 1000

test('analyze real songs for the auto-cut rhythm fixtures', async ({ page }) => {
  test.skip(!process.env.AUTOCUT_SONGS, 'set AUTOCUT_SONGS=1 to regenerate the fixtures')
  test.setTimeout(SONGS.length * 300_000)
  for (const s of SONGS) expect(existsSync(path.join(MP3, `${s.file}.mp3`)), `${s.file} missing`).toBe(true)
  mkdirSync(OUT, { recursive: true })
  await openHarness(page)
  for (const song of SONGS) {
    await page.setInputFiles('#e2e-file-input', [path.join(MP3, `${song.file}.mp3`)])
    const a = await page.evaluate(async () => {
      const { media, analysis } = window.mvStudio
      const [file] = window.mvStudio.files() as File[]
      const asset = await media.mediaStore.importFile(file)
      const service = new analysis.SongAnalysisService()
      const audio = await analysis.decodeAudioFile(file)
      const fast = await service.analyze(asset.id, audio).promise
      const refined = await service.refine(asset.id).promise
      service.dispose()
      const merged = analysis.mergeRefinedAnalysis(fast, fast, refined)
      return { duration: asset.duration as number, analysis: merged }
    })
    const { energy } = a.analysis
    const step = Math.max(1, Math.round(energy.rate / ENERGY_RATE))
    const values: number[] = []
    for (let i = 0; i < energy.values.length; i += step) {
      const chunk = energy.values.slice(i, i + step)
      values.push(+(chunk.reduce((x: number, y: number) => x + y, 0) / chunk.length).toPrecision(3))
    }
    const fixture = {
      source: { artist: song.artist, title: song.title, license: song.license, url: song.url },
      analyzer: a.analysis.version,
      duration: r3(a.duration),
      tempo: a.analysis.tempo,
      beats: a.analysis.beats.map(r3),
      downbeats: a.analysis.downbeats.map(r3),
      sections: a.analysis.sections.map(
        (s: { id: string; label: string; start: number; end: number; energy?: number }) => ({
          id: s.id,
          label: s.label,
          start: r3(s.start),
          end: r3(s.end),
          ...(s.energy !== undefined ? { energy: r3(s.energy) } : {}),
        }),
      ),
      energy: { rate: energy.rate / step, values },
    }
    writeFileSync(path.join(OUT, `${song.file}.json`), JSON.stringify(fixture) + '\n')
    console.log(
      song.file,
      fixture.tempo,
      fixture.sections
        .map((s: { label: string; start: number; end: number }) => `${s.label} ${s.start}-${s.end}`)
        .join(', '),
    )
  }
})
