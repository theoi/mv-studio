import path from 'node:path'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const DEPTH_LINE = 'Downloading the depth estimator (27 MB, once)'

test('a first 3D camera move shows the depth estimator downloading, and names it when it cannot download', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?tab=assist&assist=camera&t=28'
  })
  await waitForPreview(page)
  const assist = page.getByRole('tabpanel', { name: 'Assist' })

  await context.route('https://huggingface.co/**', (route) => route.abort())
  await assist.getByRole('button', { name: /^Apply to \d+ images$/ }).click()
  const failure = assist.getByRole('alert')
  await expect(failure).toContainText('Couldn’t download the depth estimator')
  await expect(failure).not.toContainText('https://')
  await context.unroute('https://huggingface.co/**')

  // Every line the run shows, however briefly, in order, with the run card's percentage and bar, and every
  // percentage the top bar's task shows.
  type Seen = { lines: string[]; card: { line: string; pct: string; bar: string }[]; chip: number[] }
  await page.evaluate(() => {
    const seen: Seen = { lines: [], card: [], chip: [] }
    ;(window as unknown as { seen: Seen }).seen = seen
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[role="tabpanel"] span')) {
        const line = el.textContent ?? ''
        if (/^(Downloading |Estimating depth · )/.test(line) && seen.lines.at(-1) !== line)
          seen.lines.push(line)
      }
      const bar = document.querySelector('[role="progressbar"][aria-label="3D camera progress"]')
      const top = bar?.parentElement?.firstElementChild
      const line = top?.firstElementChild?.textContent ?? ''
      if (line.startsWith('Downloading ') && top) {
        const shown = {
          line,
          pct: top.lastElementChild?.textContent ?? '',
          bar: bar.getAttribute('aria-valuenow') ?? '',
        }
        const last = seen.card.at(-1)
        if (!last || last.line !== shown.line || last.pct !== shown.pct || last.bar !== shown.bar)
          seen.card.push(shown)
      }
      const chip = document.querySelector('button[aria-label^="Adding 3D camera moves"]')
      const pct = /(\d+)%$/.exec(chip?.getAttribute('aria-label') ?? '')?.[1]
      if (pct && seen.chip.at(-1) !== Number(pct)) seen.chip.push(Number(pct))
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })
  await assist.getByRole('button', { name: 'Try again' }).click()
  await expect(assist.getByText(/^Added a 3D camera move to \d+ images$/)).toBeVisible({ timeout: 200_000 })
  const seen = await page.evaluate(() => (window as unknown as { seen: Seen }).seen)
  const downloading = seen.lines.findIndex((l) => l.startsWith(DEPTH_LINE))
  expect(downloading).toBeGreaterThanOrEqual(0)
  // The run's own line comes back once the download is in.
  expect(seen.lines.findLastIndex((l) => l.startsWith('Estimating depth · '))).toBeGreaterThan(downloading)
  // The download's percentage is in its line and only rises; the card's own percentage is the bar's.
  expect(seen.card.length).toBeGreaterThan(0)
  const inLine = seen.card.map((c) => {
    expect(c.line).toMatch(/^Downloading the depth estimator \(27 MB, once\)… \d+%$/)
    expect(c.pct).toBe(`${c.bar}%`)
    return Number(/(\d+)%$/.exec(c.line)?.[1])
  })
  expect(inLine).toEqual([...inLine].sort((a, b) => a - b))
  // The task's progress only moves forward, through the download too.
  expect(seen.chip.length).toBeGreaterThan(1)
  expect(seen.chip).toEqual([...seen.chip].sort((a, b) => a - b))
})

test('a 3D camera move names the depth estimator it could not download when Hugging Face answers with an error', async ({
  page,
  context,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?tab=assist&assist=camera&t=28'
  })
  await waitForPreview(page)
  await context.route('https://huggingface.co/**', (route) => route.fulfill({ status: 503, body: '' }))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await assist.getByRole('button', { name: /^Apply to \d+ images$/ }).click()
  await expect(assist.getByRole('alert')).toContainText('Couldn’t download the depth estimator')
})

test('the footage tagger downloads its image and text weights as one line the first time either is used', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await openHarness(page)
  const run = await page.evaluate(async () => {
    const { VISION_MODELS, createWorkerBackends } = window.mvStudio.vision
    const backends = createWorkerBackends()
    const reports: { call: string; fraction: number; bytesTotal: number; done: boolean }[] = []
    let call = 'images'
    backends.watchDownloads((d: { model: string; fraction: number; bytesTotal: number; done?: true }) => {
      if (d.model === 'tagger')
        reports.push({ call, fraction: d.fraction, bytesTotal: d.bytesTotal, done: !!d.done })
    })
    const pixels = new Uint8ClampedArray(64 * 64 * 4).fill(128)
    const bitmap = await createImageBitmap(new ImageData(pixels, 64, 64))
    await backends.onnx().embedImages({ bitmaps: [bitmap], model: 'clipB32' }, { transfer: [bitmap] })
    call = 'texts'
    await backends.onnx().embedTexts({ texts: ['a beach at sunset'], model: 'clipB32' })
    backends.dispose()
    const { vision, text } = VISION_MODELS.clipB32.files
    return { reports, bytes: (vision.bytes as number) + (text.bytes as number) }
  })
  expect(run.reports.length).toBeGreaterThan(1)
  expect(run.reports.filter((r) => r.done)).toHaveLength(1)
  expect(run.reports.every((r) => r.call === 'images')).toBe(true)
  const fractions = run.reports.map((r) => r.fraction)
  expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
  expect(run.reports.at(-1)?.bytesTotal).toBe(run.bytes)
})

test('putting text behind the subject names the person finder when its models cannot download', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=10'
  })
  await waitForPreview(page)
  await context.route('https://storage.googleapis.com/mediapipe-models/**', (route) => route.abort())

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
  await expect(inspector.getByText('Couldn’t download the person finder').first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(inspector.getByText(/https?:\/\//)).toHaveCount(0)
})
