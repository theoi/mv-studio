import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('vision segmentation runs in the production build: preview, suitability, mask track, click-select, subjects', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'clip.mp4')])

  const result = await page.evaluate(async () => {
    const { vision } = window.mvStudio
    const [file] = window.mvStudio.files()
    const backends = vision.createWorkerBackends()
    const service = vision.createVisionService({ backends, cache: vision.createMemoryCache() })
    const source = await vision.createVideoElementSource(file, 'clip', { frameRate: 30 })

    const preview = service.livePreview()
    const first = await preview.segment(await source.frameAt(0, { maxSide: 256 }), 0)
    const times: number[] = []
    for (let i = 1; i <= 10; i++) {
      const frame = await source.frameAt(i / 30, { maxSide: 256 })
      const start = performance.now()
      await preview.segment(frame, i / 30)
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)

    const suitability = await service.checkSuitability(source)
    const progress: number[] = []
    const person = await service.personTrack(source, {
      fps: 10,
      onProgress: (p: { fraction?: number }) => progress.push(p.fraction ?? -1),
    })
    const masked = vision.createTrackReader(person.track).at(1.55)
    const selection = await service.selectionTrack(source, { t: 2, points: [{ x: 0.5, y: 0.5 }] }, { fps: 5 })
    const subjects = await service.subjects(source)

    const cache = await caches.open('mv-studio-models-v1')
    const cached = await Promise.all(
      [
        vision.VISION_MODELS.selfieLandscape,
        vision.VISION_MODELS.magicTouch,
        vision.VISION_MODELS.faceShortRange,
      ].map(
        async (m: { files: { model: { url: string } } }) =>
          (await cache.match(m.files.model.url)) !== undefined,
      ),
    )
    backends.dispose()
    source.dispose()
    return {
      firstMask: first && { width: first.width, height: first.height },
      previewMedianMs: times[5],
      suitability: { sampledFrames: suitability.sampledFrames, verdict: suitability.verdict },
      track: { ...person.track.meta, coverage: undefined },
      progressEnd: progress.at(-1),
      progressMonotonic: progress.every((p, i) => i === 0 || p >= progress[i - 1]!),
      masked: { width: masked.width, height: masked.height },
      selection: {
        frameCount: selection.track.meta.frameCount,
        clickCoverage: selection.track.meta.coverage[10],
        trackedFraction: selection.trackedFraction,
      },
      subjects: subjects.samples.length,
      cached,
    }
  })

  expect(result.firstMask).toEqual({ width: 256, height: 144 })
  expect(result.previewMedianMs).toBeLessThan(250)
  expect(result.suitability.sampledFrames).toBe(20)
  expect(['good', 'marginal', 'unsuitable']).toContain(result.suitability.verdict)
  expect(result.track).toMatchObject({
    kind: 'person',
    fps: 10,
    frameCount: 40,
    maskSize: { width: 512, height: 288 },
  })
  expect(result.progressEnd).toBe(1)
  expect(result.progressMonotonic).toBe(true)
  expect(result.masked).toEqual({ width: 512, height: 288 })
  expect(result.selection.frameCount).toBe(20)
  expect(result.selection.clickCoverage).toBeGreaterThan(0)
  expect(result.subjects).toBe(20)
  expect(result.cached).toEqual([true, true, true])
  console.log(
    `vision e2e: preview median ${result.previewMedianMs.toFixed(1)} ms/frame, tracked ${result.selection.trackedFraction}`,
  )
})
