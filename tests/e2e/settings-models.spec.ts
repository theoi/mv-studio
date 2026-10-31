import { expect, openHarness, test } from './fixtures.ts'

test('Settings lists the downloaded models and clears the model cache', async ({ page }) => {
  await openHarness(page)
  const beatModelUrl: string = await page.evaluate(
    () => window.mvStudio.app.models.LOCAL_MODELS.find((m: { id: string }) => m.id === 'beats').urls[0],
  )
  // A model download as the shared loader stores it.
  await page.evaluate(async (url) => {
    const cache = await caches.open('mv-studio-models-v1')
    const body = new Uint8Array(3_000_000)
    await cache.put(url, new Response(body, { headers: { 'content-length': String(body.byteLength) } }))
  }, beatModelUrl)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?dialog=settings&page=local'
  })
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const beats = dialog.getByLabel('Beat and bar tracker')
  await expect(beats.getByText('On this device')).toBeVisible()
  await expect(beats.getByText('82 MB')).toBeVisible()
  await expect(dialog.getByLabel('Stem separator').getByText('Downloads when used')).toBeVisible()

  await dialog.getByRole('button', { name: 'Storage' }).click()
  await expect(dialog.getByText('3 MB on this device. Models download again when needed.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByText('Removed 3 MB of models. They download again when needed.')).toBeVisible()
  await expect(dialog.getByText('No models downloaded yet.')).toBeVisible()
  expect(await page.evaluate((url) => caches.match(url).then(Boolean), beatModelUrl)).toBe(false)

  await dialog.getByRole('button', { name: 'This device' }).click()
  await expect(beats.getByText('Downloads when used')).toBeVisible()
})
