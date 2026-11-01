import path from 'node:path'
import type { ConsoleMessage, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/** Google's private API hosts, where MediaPipe Tasks sends its usage logs (odml.pa.googleapis.com). */
const TELEMETRY_HOST = /(^|[.-])pa\.googleapis\.com$/

/** For each segmentation worker, the usage logs its MediaPipe tasks tried to send, which the worker answered itself. */
function blockedPerWorker(page: Page): Promise<number[]> {
  return Promise.all(
    page
      .workers()
      .filter((w) => w.url().includes('segmentation'))
      .map((w) => w.evaluate(() => performance.getEntriesByName('mv-studio:blocked-request').length)),
  )
}

test('a cutout and an auto-reframe export run MediaPipe without sending its usage logs to Google', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)
  const sent: string[] = []
  context.on('request', (r) => {
    if (TELEMETRY_HOST.test(new URL(r.url()).hostname)) sent.push(r.url())
  })
  const logs: string[] = []
  const log = (m: ConsoleMessage) => logs.push(m.text())
  page.on('console', log)
  page.on('worker', (w) => w.on('console', log))

  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=10'
  })
  await waitForPreview(page)

  // The cutout: the person check and the person mask track.
  await page
    .getByLabel('Import media files')
    .setInputFiles(path.resolve('tests/fixtures/people-interview.webm'))
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('people-interview, video')
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const block = page.getByRole('button', { name: /^people-interview, \d/ })
  await expect(block).toHaveCount(1)
  await block.focus()
  await page.keyboard.press('Enter')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  await inspector.getByRole('switch', { name: 'Put text and effects behind the subject' }).click()
  await expect(inspector.getByText('Person found')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('button', { name: /^people-interview · subject, / })).toBeVisible()

  // The auto-reframe export: the clip's subject analysis, then a vertical file framed by it.
  const exported = await page.evaluate(async () => {
    const { app, exporting, media, model, vision } = window.mvStudio
    const assets = Object.values(app.project.editor.getProject().assets as Record<string, Untyped>)
    const asset = assets.find((a) => a.name?.startsWith('people-interview'))
    const source = await vision.createVideoElementSource(await media.mediaStore.getFile(asset), asset.id, {
      frameRate: 30,
    })
    const subjects = await (await app.footage.visionService()).subjects(source)
    source.dispose()
    const p = model.createProject({ name: 'Telemetry' })
    p.assets[asset.id] = asset
    p.analysis.visual[asset.id] = vision.buildVisualAnalysis({
      assetId: asset.id,
      duration: asset.duration,
      sourceSize: subjects.sourceSize,
      subjects,
    })
    const visual = p.tracks.find((t: Untyped) => t.kind === 'visual')
    const clip = model.createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 2 })
    p.clips[clip.id] = clip
    const spec = exporting.newOutput(p, 'video', { aspect: '9:16', resolution: '720p' })
    const planned = exporting.planOutput(p, spec)
    const [result] = await exporting.startExport(p, [spec]).promise
    return {
      subjects: subjects.samples.filter((s: Untyped) => s.box).length,
      reframe: planned.spec.reframe,
      unanalysed: planned.unanalysed.length,
      bytes: result.file.size,
    }
  })
  expect(exported).toMatchObject({ reframe: 'auto', unanalysed: 0 })
  expect(exported.subjects).toBeGreaterThan(0)
  expect(exported.bytes).toBeGreaterThan(0)

  // Each MediaPipe task tries to send its usage log 60 s after it is created.
  await expect
    .poll(
      async () => {
        const blocked = await blockedPerWorker(page)
        return blocked.length > 0 && blocked.every((n) => n > 0)
      },
      { timeout: 150_000, intervals: [2_000] },
    )
    .toBe(true)
  expect(sent).toEqual([])
  expect(logs.filter((l) => /odml|pa\.googleapis|logging failed/i.test(l))).toEqual([])
})
