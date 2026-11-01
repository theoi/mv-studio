import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('models cached before their URLs were pinned are listed as downloaded and load without downloading again', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  // The person finder's models as an earlier version cached them, under their `latest` URLs.
  const files: { url: string; former: string }[] = await page.evaluate(async () => {
    const { VISION_MODELS } = window.mvStudio.vision
    const cache = await caches.open('mv-studio-models-v1')
    const models = [VISION_MODELS.selfieLandscape, VISION_MODELS.personDetector, VISION_MODELS.faceShortRange]
    // The portrait segmenter is part of the person finder too, though the landscape clip below does not load it.
    const portrait = VISION_MODELS.selfie.files.model
    await cache.put(portrait.formerUrls[0], new Response(await (await fetch(portrait.url)).arrayBuffer()))
    return Promise.all(
      models.map(async (m) => {
        const { url, formerUrls } = m.files.model
        await cache.put(formerUrls[0], new Response(await (await fetch(url)).arrayBuffer()))
        return { url, former: formerUrls[0] }
      }),
    )
  })

  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?dialog=settings&page=local'
  })
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('group', { name: 'Person finder' }).getByText('On this device')).toBeVisible()

  const downloads: string[] = []
  context.on('request', (r) => {
    if (r.url().includes('/mediapipe-models/')) downloads.push(r.url())
  })
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'clip.mp4')])
  await page.evaluate(async () => {
    const { vision } = window.mvStudio
    const [file] = window.mvStudio.files()
    const backends = vision.createWorkerBackends()
    const service = vision.createVisionService({ backends, cache: vision.createMemoryCache() })
    const source = await vision.createVideoElementSource(file, 'clip', { frameRate: 30 })
    await service.checkSuitability(source)
    await service.subjects(source)
    source.dispose()
    backends.dispose()
  })
  expect(downloads).toEqual([])
  const cached = await page.evaluate(async (list) => {
    const cache = await caches.open('mv-studio-models-v1')
    return Promise.all(list.map(async (f) => [!!(await cache.match(f.url)), !!(await cache.match(f.former))]))
  }, files)
  expect(cached).toEqual(files.map(() => [true, false]))
})

test('a Transformers.js model cached from `main` before its revision was pinned loads without downloading again', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  // Depth Anything's files as an earlier version cached them, under their `main` URLs.
  const files: { url: string; former: string }[] = await page.evaluate(async () => {
    const { VISION_MODELS } = window.mvStudio.vision
    const model = VISION_MODELS.depthAnythingSmall.files.model
    const base = model.url.slice(0, model.url.indexOf('onnx/'))
    const cache = await caches.open('mv-studio-models-v1')
    return Promise.all(
      ['config.json', 'preprocessor_config.json', 'onnx/model_quantized.onnx'].map(async (path) => {
        const url = base + path
        const former = url.replace(/\/resolve\/[0-9a-f]{40}\//, '/resolve/main/')
        await cache.put(former, new Response(await (await fetch(url)).arrayBuffer()))
        return { url, former }
      }),
    )
  })

  const downloads: string[] = []
  context.on('request', (r) => {
    if (r.url().startsWith('https://huggingface.co/')) downloads.push(r.url())
  })
  const depth = await page.evaluate(async () => {
    const backends = window.mvStudio.vision.createWorkerBackends()
    const pixels = new Uint8ClampedArray(64 * 64 * 4).fill(128)
    const bitmap = await createImageBitmap(new ImageData(pixels, 64, 64))
    const map = await backends.onnx().depth({ bitmap, shortSide: 126 })
    backends.dispose()
    return { width: map.width, height: map.height }
  })
  expect(depth).toEqual({ width: 126, height: 126 })
  expect(downloads).toEqual([])
  const cached = await page.evaluate(async (list) => {
    const cache = await caches.open('mv-studio-models-v1')
    return Promise.all(list.map(async (f) => [!!(await cache.match(f.url)), !!(await cache.match(f.former))]))
  }, files)
  expect(cached).toEqual(files.map(() => [true, false]))
})
