import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEmptyEditor(page: Page) {
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
}

async function previewStats(page: Page): Promise<{ mean: number; spread: number }> {
  const png = await page.getByRole('img', { name: 'Video preview' }).screenshot()
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let sum = 0
    let sq = 0
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
      sum += y
      sq += y * y
    }
    const n = d.length / 4
    const mean = sum / n
    return { mean, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) }
  }, png.toString('base64'))
}

test('importing a song into an empty project makes it the song and analyzes it', async ({ page }) => {
  await openEmptyEditor(page)
  // Every text Inspector › Song shows from the import until the facts are in.
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { factsSeen: string[] }).factsSeen = seen
    new MutationObserver(() => {
      const text = document.querySelector('[data-testid="song-facts"]')?.textContent
      if (text && seen.at(-1) !== text) seen.push(text)
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))

  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Media' }).getByText('song.mp3')).toBeVisible()
  // The fixture is a 120 BPM kick pattern; the analysis result lands in the song row.
  await expect(page.getByText(/0:08 · 1[12]\d BPM · \d+ sections?/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('song-facts')).toHaveText(/BPM/)
  const seen = await page.evaluate(() => (window as unknown as { factsSeen: string[] }).factsSeen)
  expect(seen[0]).toBe('Analyzing the song…')
  expect(seen).not.toContain('Not analyzed yet')
  await expect(page.getByRole('button', { name: 'Project: song' })).toBeVisible()

  // Undo removes the import; the analysis has no undo step of its own.
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByText('Start with a song')).toBeVisible()
})

test('imported clips and images appear in the library and can be added at the playhead', async ({ page }) => {
  await openEmptyEditor(page)
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press(`${mod}+i`)
  await (await chooser).setFiles(['song.mp3', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)))
  const card = page.getByLabel('clip, video')
  await expect(card).toBeVisible()
  await expect(card.getByText('0:04')).toBeVisible()

  // Dropping a file anywhere imports it too.
  const png = readFileSync(path.join(FIXTURE_DIR, 'image.png')).toString('base64')
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, cancelable: true }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, cancelable: true }))
  }, png)
  await expect(page.getByLabel('image, image')).toBeVisible()

  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  await expect(page.getByRole('button', { name: 'clip, 0:00.0 to 0:04.0' })).toBeVisible()
  await waitForPreview(page)
  // The clip's test pattern is on screen, drawn by the engine from the file in browser storage.
  await expect
    .poll(async () => {
      const s = await previewStats(page)
      return s.mean > 12 && s.spread > 20
    })
    .toBe(true)
})
