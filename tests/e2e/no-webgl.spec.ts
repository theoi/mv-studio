import path from 'node:path'
import { expect, openApp, openHarness, test } from './fixtures.ts'

// Chrome without a usable GPU (a virtual machine, a remote desktop, graphics acceleration turned off) offers no WebGL.
test.use({ webgl: false })

const NO_GRAPHICS = /MV Studio needs graphics acceleration \(WebGL 2\) to show and export videos\./
const NO_GRAPHICS_REASON = 'Needs graphics acceleration (WebGL 2), which this browser doesn’t offer.'

test('without WebGL 2 the start screen says so, the stage says why it shows nothing, and export and VJ mode are unavailable', async ({
  page,
}) => {
  await openApp(page)
  expect(
    await page.evaluate(() => [
      document.createElement('canvas').getContext('webgl2') !== null,
      new OffscreenCanvas(1, 1).getContext('webgl2') !== null,
    ]),
  ).toEqual([false, false])
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await expect(page.getByRole('alert').filter({ hasText: NO_GRAPHICS })).toBeVisible()

  await page.getByRole('button', { name: /^Blank project/ }).click()
  await page.getByRole('button', { name: 'Use a sample' }).click()
  const stage = page.getByRole('img', { name: 'Video preview' })
  await expect(stage).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: NO_GRAPHICS })).toBeVisible()
  await expect(stage).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByText('Preparing the preview')).toHaveCount(0)

  const exportButton = page.getByRole('button', { name: 'Export', exact: true })
  await expect(exportButton).toHaveAttribute('aria-disabled', 'true')
  // Playwright won't click an aria-disabled button; people can, and the dialog then says why.
  await exportButton.click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await expect(dialog.getByRole('alert')).toContainText(NO_GRAPHICS)
  await expect(dialog.getByRole('button', { name: /^Export/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()

  const vj = page.getByRole('button', { name: 'VJ', exact: true })
  await expect(vj).toHaveAttribute('aria-disabled', 'true')
  await vj.click({ force: true })
  await expect(page.getByRole('status').getByText(NO_GRAPHICS)).toBeVisible()
  expect(await page.evaluate(() => window.location.hash)).toMatch(/^#\/editor/)

  // Tools whose models or results need WebGL 2 say the same in their panel, next to the stage's note.
  for (const tool of ['behind', 'camera']) {
    await page.evaluate((t) => (window.location.hash = `#/editor?tab=assist&assist=${t}`), tool)
    await expect(page.getByRole('alert').filter({ hasText: NO_GRAPHICS })).toHaveCount(2)
  }
})

test('a preview that neither its render worker nor the page can draw says so, instead of preparing forever', async ({
  page,
}) => {
  await openHarness(page)
  const error = await page.evaluate(async () => {
    const { engine, media, model } = window.mvStudio
    const preview = new engine.PreviewController({
      canvas: document.createElement('canvas'),
      media: media.mediaStore,
    })
    preview.setViewport(320, 180, 1)
    preview.setProject(model.createProject())
    const started = performance.now()
    while (!preview.getSnapshot().error && performance.now() - started < 10_000)
      await new Promise((resolve) => setTimeout(resolve, 50))
    const code = preview.getSnapshot().error?.code ?? null
    preview.dispose()
    return code
  })
  expect(error).toBe('unsupported')
})

test('without WebGL 2 an imported clip is not checked for people, and Behind the subject says why in the inspector and its panel', async ({
  page,
}) => {
  // The person models (MediaPipe) need WebGL even on the CPU: a check would download them only to fail.
  let modelRequests = 0
  await page.context().route('https://storage.googleapis.com/mediapipe-models/**', (route) => {
    modelRequests++
    return route.continue()
  })
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=10'
  })
  await page.getByLabel('Import media files').setInputFiles(path.resolve('tests/fixtures/.cache/clip.mp4'))
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('clip, video')
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const block = page.getByRole('button', { name: /^clip, \d/ })
  await expect(block).toHaveCount(1)
  await block.focus()
  await page.keyboard.press('Enter')

  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  await expect(
    inspector.getByRole('switch', { name: 'Put text and effects behind the subject' }),
  ).toBeDisabled()
  await expect(inspector.getByText(NO_GRAPHICS_REASON, { exact: true })).toBeVisible()
  await expect(inspector.getByRole('button', { name: 'Pick another object in the preview' })).toBeDisabled()

  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  await expect(
    page.getByRole('tabpanel', { name: 'Assist' }).getByRole('alert').filter({ hasText: NO_GRAPHICS }),
  ).toBeVisible()
  // Both the inspector and the panel start a check of unchecked clips as soon as they show.
  await page.waitForTimeout(1500)
  const checks = await page.evaluate(() =>
    window.mvStudio.shared.jobs.list().filter((j: { kind: string }) => j.kind === 'vision.suitability'),
  )
  expect(checks).toEqual([])
  expect(modelRequests).toBe(0)
})
