import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditorAt(page: Page, hash: string) {
  await openApp(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  const preview = page.getByRole('img', { name: 'Video preview' })
  await expect(preview).toBeVisible()
  // The engine draws the first frame once the sample media for it has been generated.
  await expect(page.getByText('Preparing the preview')).toBeHidden({ timeout: 30_000 })
  return preview
}

/** Mean luminance and its spread (0..255) of a PNG, decoded in the page. */
async function imageStats(page: Page, png: Buffer): Promise<{ mean: number; spread: number }> {
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let sum = 0
    let sq = 0
    const n = d.length / 4
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
      sum += y
      sq += y * y
    }
    const mean = sum / n
    return { mean, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) }
  }, png.toString('base64'))
}

/** Mean absolute pixel difference (0..255) between two same-sized PNGs. */
async function imageDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([a64, b64]) => {
      const read = async (s: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob())
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      }
      const [x, y] = await Promise.all([read(a64), read(b64)])
      let sum = 0
      for (let i = 0; i < x.length; i++) if (i % 4 !== 3) sum += Math.abs(x[i] - y[i])
      return sum / ((x.length / 4) * 3)
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

async function playheadSeconds(page: Page): Promise<number> {
  const text = await page
    .getByText(/^\d\d:\d\d\.\d\d$/)
    .first()
    .textContent()
  const [m, s] = (text ?? '0:0').split(':')
  return Number(m) * 60 + Number(s)
}

test('the editor preview renders the sample project with the engine and plays in time with its song', async ({
  page,
}) => {
  const preview = await openEditorAt(page, '#/editor?t=66.9')
  const frame = await imageStats(page, await preview.screenshot())
  // A drawn scene, not the black canvas behind it.
  expect(frame.mean).toBeGreaterThan(12)
  expect(frame.spread).toBeGreaterThan(8)

  const start = await playheadSeconds(page)
  expect(start).toBeCloseTo(66.9, 1)
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  // Playback starts once the synthesized song has decoded; from then on the playhead follows the audio clock.
  await expect.poll(() => playheadSeconds(page), { timeout: 30_000 }).toBeGreaterThan(start + 0.2)
  const playing = await playheadSeconds(page)
  const started = Date.now()
  await page.waitForTimeout(1500)
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  const advanced = (await playheadSeconds(page)) - playing
  const elapsed = (Date.now() - started) / 1000
  expect(advanced).toBeGreaterThan(elapsed - 0.5)
  expect(advanced).toBeLessThan(elapsed + 0.5)
  // Once paused, the picture settles on the paused frame and stays still.
  await expect
    .poll(async () => imageDiff(page, await preview.screenshot(), await preview.screenshot()))
    .toBeLessThan(0.5)
})

test('putting lyrics behind the singer cuts the subject out above them, as one undoable edit', async ({
  page,
}) => {
  const preview = await openEditorAt(page, '#/editor?t=66.9&sel=clip:c-s-c1-1')
  const before = await preview.screenshot()
  await page.getByRole('button', { name: 'Put lyrics behind' }).click()
  const cutout = page.getByRole('button', { name: 'Singer close-up · subject, 1:06.0 to 1:08.0' })
  await expect(cutout).toBeVisible()
  // The singer now covers part of the lyric line and the spectrum bars.
  await expect.poll(async () => imageDiff(page, before, await preview.screenshot())).toBeGreaterThan(1)

  await page.keyboard.press(`${mod}+z`)
  await expect(cutout).toBeHidden()
  await expect.poll(async () => imageDiff(page, before, await preview.screenshot())).toBeLessThan(0.5)
})

test('export renders an MP4 with the engine and downloads it', async ({ page }) => {
  test.setTimeout(240_000)
  await openEditorAt(page, '#/editor?t=73.6')
  await page.keyboard.press(`${mod}+e`)
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await dialog.getByLabel('Include Full video').uncheck({ force: true })
  await dialog.getByLabel('Include Vertical').uncheck({ force: true })
  await dialog.getByRole('button', { name: /Loop for Canvas/ }).click()
  const download = page.waitForEvent('download', { timeout: 200_000 })
  await dialog.getByRole('button', { name: 'Export 1 file' }).click()
  await expect(dialog.getByRole('progressbar', { name: 'Loop for Canvas progress' })).toBeVisible()
  const file = await download
  expect(file.suggestedFilename()).toBe('neon-skyline-loop-for-canvas.mp4')
  const path = test.info().outputPath('loop.mp4')
  await file.saveAs(path)
  await expect(dialog.getByText('1 file saved')).toBeVisible()

  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  ) as { streams: { codec_name: string; width?: number; height?: number }[]; format: { duration: string } }
  const video = probe.streams.find((s) => s.codec_name === 'h264')
  expect(video).toMatchObject({ width: 720, height: 1280 })
  expect(probe.streams.some((s) => s.codec_name === 'aac')).toBe(true)
  expect(Number(probe.format.duration)).toBeCloseTo(8, 0)
})
