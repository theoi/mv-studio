import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * Preview and export benchmarks (src/testing/bench.ts, also behind the ?bench=1 page) on an on-screen canvas. Prints a
 * table and attaches the raw numbers. CI runs headless Chromium on SwiftShader (no GPU) with software compositing, so
 * frame rates and main-thread numbers are a floor for real machines.
 */

const MEDIA = ['song.mp3', 'clip1080.mp4', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f))

const SCENARIOS = [
  ...(['full', 'half', 'quarter', 'auto'] as const).map((quality) => ({
    project: 'typical',
    css: [1280, 720],
    dpr: 1,
    quality,
    interact: quality === 'auto',
  })),
  ...(['full', 'half', 'quarter', 'auto'] as const).map((quality) => ({
    project: 'heavy',
    css: [1280, 720],
    dpr: 1,
    quality,
    interact: quality === 'auto',
  })),
  { project: 'heavy', css: [960, 540], dpr: 2, quality: 'auto', interact: false },
]

test('preview benchmark: typical and heavy projects at each quality', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', MEDIA)
  const rows = await page.evaluate(async (scenarios) => {
    const { media, testing } = window.mvStudio
    const [song, hd, sd] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    return testing.bench.runPreviewBenchmark({ assets: { song, hd, sd }, scenarios })
  }, SCENARIOS)

  type Sample = {
    canvas: number[]
    scale: number
    fps: number
    frameP50Ms: number
    frameP95Ms: number
    dropped: number
    main: { inputDelayP95Ms: number; longTaskMaxMs: number }
    edits?: { count: number; applyMeanMs: number; responseP95Ms: number }
  }
  type Row = {
    project: string
    viewport: string
    quality: string
    playing: Sample
    dragging?: Sample
    scrubbing?: Sample
  }
  const table = (rows as Row[]).map((r) =>
    [
      r.project,
      r.viewport,
      r.quality,
      r.playing.canvas.join('x'),
      r.playing.scale,
      r.playing.fps,
      `${r.playing.frameP50Ms}/${r.playing.frameP95Ms}`,
      r.playing.main.inputDelayP95Ms,
      r.dragging?.fps ?? '',
      r.dragging?.edits?.applyMeanMs ?? '',
      r.dragging?.main.inputDelayP95Ms ?? '',
      r.scrubbing?.fps ?? '',
      r.scrubbing?.main.inputDelayP95Ms ?? '',
    ].join(' | '),
  )
  console.log(
    [
      'project | viewport | quality | canvas | scale | fps | frame p50/p95 ms | input delay p95 | drag fps | edit ms | drag input delay p95 | scrub fps | scrub input delay p95',
      ...table,
    ].join('\n'),
  )
  await testInfo.attach('preview-benchmark.json', {
    body: JSON.stringify(rows, null, 2),
    contentType: 'application/json',
  })

  for (const r of rows as Row[]) {
    const label = `${r.project} ${r.viewport} ${r.quality}`
    expect(r.playing.fps, `${label} plays`).toBeGreaterThan(0.5)
    if (r.dragging) {
      // One edit per animation frame; a visible canvas on a GPU-less runner gets about 10 frames per second.
      expect(r.dragging.edits?.count, `${label} drag edits`).toBeGreaterThan(5)
      expect(r.dragging.edits?.applyMeanMs, `${label} edit cost`).toBeLessThan(8)
    }
  }
})

test('with the preview in the render worker, input stays responsive on a visible canvas at every quality', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', MEDIA)
  const scenarios = (['full', 'half', 'quarter', 'auto'] as const).map((quality) => ({
    project: 'heavy',
    css: [1280, 720],
    dpr: 1,
    quality,
    interact: true,
  }))
  const rows = await page.evaluate(async (scenarios) => {
    const { media, testing } = window.mvStudio
    const [song, hd, sd] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    return testing.bench.runPreviewBenchmark({ assets: { song, hd, sd }, scenarios, renderer: 'worker' })
  }, scenarios)
  type Sample = { fps: number; canvas: number[]; main: { inputDelayP95Ms: number; longTaskMaxMs: number } }
  type Row = { quality: string; playing: Sample; dragging?: Sample; scrubbing?: Sample }
  console.log(
    [
      'render worker: quality | canvas | fps | input delay p95 (play / drag / scrub) | longest task (play / drag / scrub)',
      ...(rows as Row[]).map((r) =>
        [
          r.quality,
          r.playing.canvas.join('x'),
          r.playing.fps,
          [r.playing, r.dragging, r.scrubbing].map((s) => s?.main.inputDelayP95Ms).join(' / '),
          [r.playing, r.dragging, r.scrubbing].map((s) => s?.main.longTaskMaxMs).join(' / '),
        ].join(' | '),
      ),
    ].join('\n'),
  )
  await testInfo.attach('preview-worker-benchmark.json', {
    body: JSON.stringify(rows, null, 2),
    contentType: 'application/json',
  })
  expect(rows).toHaveLength(4)
  for (const r of rows as Row[]) {
    for (const [what, s] of Object.entries({
      playing: r.playing,
      dragging: r.dragging,
      scrubbing: r.scrubbing,
    })) {
      expect(s, `${r.quality} ${what} measured`).toBeDefined()
      expect(s!.fps, `${r.quality} ${what} draws`).toBeGreaterThan(0.5)
      // Drawing happens in the worker: the page answers input within 100 ms even on a GPU-less runner.
      expect(s!.main.inputDelayP95Ms, `${r.quality} ${what} input delay`).toBeLessThan(100)
    }
  }
})

test('cuts between pieces of the same footage play without stalls or wrong frames', async ({ page }) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'frames.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { media, testing } = window.mvStudio
    const [song, footage] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    return testing.bench.measureCuts(testing.bench.cutProject({ song, footage }))
  })
  console.log('cuts', JSON.stringify(r))
  expect(r.cuts).toHaveLength(4)
  // Each cut takes over the previous piece's element or a warmed one: no load, no seek wait, the right frame at once.
  expect(r.wrongFrames).toBeLessThanOrEqual(1)
  expect(r.maxStallMs).toBeLessThan(50)
})

test('export benchmark: speed and main-thread responsiveness', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', MEDIA)
  const result = await page.evaluate(async () => {
    const { media, testing } = window.mvStudio
    const [song, hd, sd] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    return testing.bench.runExportBenchmark(
      'typical',
      { song, hd, sd },
      { width: 1280, height: 720, fps: 30, seconds: 2 },
    )
  })
  console.log('export benchmark', JSON.stringify(result))
  await testInfo.attach('export-benchmark.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  expect(result.realtime).toBeGreaterThan(0.01)
  // Rendering and encoding run in the render worker, so the page keeps handling input while exporting.
  expect(result.main.inputDelayP95Ms).toBeLessThan(50)
  expect(result.main.longTaskMaxMs).toBeLessThan(200)
})
