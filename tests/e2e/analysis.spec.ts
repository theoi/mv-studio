import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('analyzes a song in a worker, then refines beats with the Beat This! model', async ({ page }) => {
  test.setTimeout(180_000)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', path.join(FIXTURE_DIR, 'song.mp3'))

  const fast = await page.evaluate(async () => {
    const { analysis, files } = window.mvStudio
    const workers: { name?: string; terminated: boolean }[] = []
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        const seen = { name: options?.name, terminated: false }
        workers.push(seen)
        const terminate = this.terminate.bind(this)
        this.terminate = () => {
          seen.terminated = true
          terminate()
        }
      }
    }
    try {
      const audio = await analysis.decodeAudioFile(files()[0])
      const service = new analysis.SongAnalysisService()
      const t0 = performance.now()
      const result = await service.analyze('song', audio).promise
      const ms = performance.now() - t0
      const t1 = performance.now()
      const refined = await service.refine('song').promise
      const refineMs = performance.now() - t1
      const afterRefine = workers.map((w) => ({ ...w }))
      const tracked = await service.trackAtTempo('song', 120, async () => files()[0]).promise
      service.dispose()
      return { result, ms, refined, refineMs, afterRefine, tracked, workers: workers.length }
    } finally {
      window.Worker = NativeWorker
    }
  })

  const { result, refined } = fast
  test
    .info()
    .annotations.push(
      { type: 'fast analysis', description: `${Math.round(fast.ms)} ms for an 8 s song` },
      { type: 'refinement', description: `${Math.round(fast.refineMs)} ms including the model download` },
    )
  expect(result.tempo.bpm).toBeGreaterThan(118)
  expect(result.tempo.bpm).toBeLessThan(122)
  const gaps: number[] = result.beats.slice(1).map((t: number, i: number) => t - result.beats[i])
  expect(gaps.length).toBeGreaterThan(12)
  expect(gaps.sort((a, b) => a - b)[gaps.length >> 1]).toBeCloseTo(0.5, 2)
  expect(result.sections[0].start).toBe(0)
  expect(result.features.rate).toBe(50)
  expect(result.features.bands).toHaveLength(result.features.loudness.length)
  expect(result.features.bands[100]).toHaveLength(result.features.bandEdgesHz.length - 1)

  expect(refined.tempo.bpm).toBeGreaterThan(118)
  expect(refined.tempo.bpm).toBeLessThan(122)
  expect(refined.beats.length).toBeGreaterThan(12)
  expect(refined.downbeats.length).toBeGreaterThan(2)

  // The worker is let go once the refinement ends, its ONNX Runtime memory with it; a tempo tapped later runs in a
  // fresh one, which reads the song again.
  expect(fast.afterRefine).toEqual([{ name: 'audio-analysis', terminated: true }])
  expect(fast.workers).toBe(2)
  expect(fast.tracked.tempo?.bpm).toBeGreaterThan(118)
  expect(fast.tracked.tempo?.bpm).toBeLessThan(122)
  expect(fast.tracked.beats?.length).toBeGreaterThan(12)
})
