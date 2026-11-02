import path from 'node:path'
import { expect, openApp, openHarness, test } from './fixtures.ts'

// Chrome without a usable GPU (a virtual machine, a remote desktop, graphics acceleration turned off) offers no WebGL.
test.use({ webgl: false })

const NO_GRAPHICS = /MV Studio needs graphics acceleration \(WebGL 2\) to preview and export videos\./
const NO_GRAPHICS_REASON = 'Needs graphics acceleration (WebGL 2), which this browser doesn’t offer'
const NO_GRAPHICS_TOOL = `${NO_GRAPHICS_REASON}. The preview says how to turn it on.`

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
  // The footer's Close, beside the title bar's.
  await dialog.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  const vj = page.getByRole('button', { name: 'VJ', exact: true })
  await expect(vj).toHaveAttribute('aria-disabled', 'true')
  await vj.click({ force: true })
  // One line, which stays clear of the stage; the stage already has the whole message.
  await expect(
    page.getByRole('status').getByText('VJ mode needs graphics acceleration (WebGL 2)', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(NO_GRAPHICS)).toHaveCount(1)
  expect(await page.evaluate(() => window.location.hash)).toMatch(/^#\/editor/)

  // Every export in the palette is listed as unavailable, with the reason.
  await page.keyboard.press('Control+K')
  await page.keyboard.type('export')
  const exports = page.getByRole('option', { name: /^Export/ })
  await expect(exports).toHaveCount(5)
  for (const option of await exports.all()) await expect(option).toContainText(NO_GRAPHICS_REASON)
  await page.keyboard.press('Escape')

  // Tools whose models or results need WebGL 2 give the short reason in their panel, next to the stage's message.
  for (const tool of ['behind', 'camera']) {
    await page.evaluate((t) => (window.location.hash = `#/editor?tab=assist&assist=${t}`), tool)
    await expect(
      page.getByRole('tabpanel', { name: 'Assist' }).getByText(NO_GRAPHICS_TOOL, { exact: true }),
    ).toBeVisible()
    await expect(page.getByText(NO_GRAPHICS)).toHaveCount(1)
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
  await expect(inspector.getByText(`${NO_GRAPHICS_REASON}.`, { exact: true })).toBeVisible()
  await expect(inspector.getByRole('button', { name: 'Pick another object in the preview' })).toBeDisabled()

  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  await expect(
    page.getByRole('tabpanel', { name: 'Assist' }).getByText(NO_GRAPHICS_TOOL, { exact: true }),
  ).toBeVisible()
  // Both the inspector and the panel start a check of unchecked clips as soon as they show.
  await page.waitForTimeout(1500)
  // A link that puts text behind the subject starts no cutout either.
  await page.evaluate(() => (window.location.hash = '#/editor?behind=1&t=10'))
  await page.waitForTimeout(500)
  const kinds = await page.evaluate(() =>
    window.mvStudio.shared.jobs.list().map((j: { kind: string }) => j.kind),
  )
  expect(kinds.filter((k: string) => k === 'vision.suitability' || k === 'vision.cutout')).toEqual([])
  expect(modelRequests).toBe(0)
})

test('without WebGL 2 the inspector offers no 3D camera move on a still, and none starts', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    // The sample's Rooftop sunset still, at 0:28.
    window.location.hash = '#/editor?sel=clip:c-s-v1-3&t=28'
  })
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Motion' }).click()
  await expect(inspector.getByRole('combobox', { name: '3D camera move' })).toBeDisabled()
  await expect(inspector.getByText(`${NO_GRAPHICS_REASON}.`, { exact: true })).toBeVisible()
  await expect(inspector.getByRole('button', { name: 'Add 3D camera' })).toHaveCount(0)
  // Nor from anywhere else: the move would download the depth model and add motion nobody can see or export.
  const kinds = await page.evaluate(() => {
    const { startCameraMoves, MOTION_PRESETS } = window.mvStudio.app.camera
    startCameraMoves(['c-s-v1-3'], Object.values(MOTION_PRESETS)[0], undefined)
    return window.mvStudio.shared.jobs.list().map((j: { kind: string }) => j.kind)
  })
  expect(kinds.filter((k: string) => k === 'vision.camera')).toEqual([])
})
