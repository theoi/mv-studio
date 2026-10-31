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

test('Settings › This device removes one downloaded model and keeps the others', async ({ page }) => {
  await openHarness(page)
  const urls: { beats: string; stems: string } = await page.evaluate(() => {
    const models: { id: string; urls: string[] }[] = window.mvStudio.app.models.LOCAL_MODELS
    return {
      beats: models.find((m) => m.id === 'beats')!.urls[0],
      stems: models.find((m) => m.id === 'stems')!.urls[0],
    }
  })
  await page.evaluate(async (list) => {
    const cache = await caches.open('mv-studio-models-v1')
    for (const url of list) await cache.put(url, new Response(new Uint8Array(1000)))
  }, Object.values(urls))
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?dialog=settings&page=local'
  })
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const beats = dialog.getByRole('group', { name: 'Beat and bar tracker' })
  const stems = dialog.getByRole('group', { name: 'Stem separator' })
  await expect(stems.getByText('On this device')).toBeVisible()
  await expect(dialog.getByRole('group', { name: 'Depth' }).getByRole('button')).toHaveCount(0)

  await beats.getByRole('button', { name: 'Remove Beat and bar tracker' }).focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByText('Beat and bar tracker removed (82 MB). It downloads again when needed.'),
  ).toBeVisible()
  await expect(beats.getByText('Downloads when used')).toBeVisible()
  await expect(beats.getByRole('button')).toHaveCount(0)
  await expect(beats).toBeFocused()
  await expect(stems.getByText('On this device')).toBeVisible()
  expect(await page.evaluate((url) => caches.match(url).then(Boolean), urls.beats)).toBe(false)
  expect(await page.evaluate((url) => caches.match(url).then(Boolean), urls.stems)).toBe(true)
})

test('a partly downloaded model says so and can be removed on its own', async ({ page }) => {
  await openHarness(page)
  const model: { title: string; urls: string[] } = await page.evaluate(() => {
    const models: { title: string; urls: string[] }[] = window.mvStudio.app.models.LOCAL_MODELS
    return models.find((m) => m.urls.length > 1)!
  })
  // An interrupted download: the first file is in the cache, the rest are not.
  await page.evaluate(async (url) => {
    const cache = await caches.open('mv-studio-models-v1')
    await cache.put(url, new Response(new Uint8Array(1000)))
  }, model.urls[0]!)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?dialog=settings&page=local'
  })
  const row = page.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: model.title })
  await expect(row.getByText('Partly downloaded')).toBeVisible()
  await row.getByRole('button', { name: `Remove ${model.title}` }).click()
  await expect(
    page.getByText(`The partial download of ${model.title} was removed. It downloads again when needed.`),
  ).toBeVisible()
  await expect(row.getByText('Downloads when used')).toBeVisible()
  expect(await page.evaluate((url) => caches.match(url).then(Boolean), model.urls[0]!)).toBe(false)
})

test('Settings › This device counts the person detector in Person cutout and removes it with the rest', async ({
  page,
}) => {
  await openHarness(page)
  const urls: string[] = await page.evaluate(
    () => window.mvStudio.app.models.LOCAL_MODELS.find((m: { id: string }) => m.id === 'cutout').urls,
  )
  expect(urls.some((u) => u.endsWith('/efficientdet_lite0.tflite'))).toBe(true)
  await page.evaluate(async (list) => {
    const cache = await caches.open('mv-studio-models-v1')
    for (const url of list) await cache.put(url, new Response(new Uint8Array(1000)))
  }, urls)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?dialog=settings&page=local'
  })
  const cutout = page.getByRole('dialog', { name: 'Settings' }).getByRole('group', { name: 'Person cutout' })
  await expect(cutout.getByText('On this device')).toBeVisible()
  await expect(cutout.getByText('5 MB')).toBeVisible()
  await cutout.getByRole('button', { name: 'Remove Person cutout' }).click()
  await expect(page.getByText('Person cutout removed (5 MB). It downloads again when needed.')).toBeVisible()
  await expect(cutout.getByText('Downloads when used')).toBeVisible()
  const left = await page.evaluate(
    (list) => Promise.all(list.map((u) => caches.match(u).then(Boolean))),
    urls,
  )
  expect(left).toEqual(urls.map(() => false))
})
