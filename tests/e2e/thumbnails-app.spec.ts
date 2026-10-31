import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openBlank(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
}

/**
 * The image an element shows as its background: its size, the frames.mp4 frame number it shows (frame N is gray
 * (N mod 16)*16+8 on the left half and floor(N/16)*16+8 on the right), and its mean difference to `reference`.
 */
async function shown(target: Locator, reference?: string) {
  return target.evaluate(async (el, ref) => {
    const url = /url\("?([^")]+)"?\)/.exec((el as HTMLElement).style.backgroundImage)?.[1]
    if (!url) return null
    const pixels = async (src: string, w?: number, h?: number) => {
      const bitmap = await createImageBitmap(await (await fetch(src)).blob())
      const width = w ?? bitmap.width
      const height = h ?? bitmap.height
      const ctx = new OffscreenCanvas(width, height).getContext('2d')!
      ctx.drawImage(bitmap, 0, 0, width, height)
      return { width, height, data: ctx.getImageData(0, 0, width, height).data }
    }
    const img = await pixels(url)
    const at = (x: number) => img.data[(Math.round(img.height / 2) * img.width + Math.round(x)) * 4]!
    const frame =
      Math.round((at(img.width * 0.75) - 8) / 16) * 16 + Math.round((at(img.width * 0.25) - 8) / 16)
    let diff: number | undefined
    if (ref) {
      const other = await pixels(ref, img.width, img.height)
      let sum = 0
      for (let i = 0; i < img.data.length; i++)
        if (i % 4 !== 3) sum += Math.abs(img.data[i]! - other.data[i]!)
      diff = sum / ((img.data.length / 4) * 3)
    }
    return { url: url.slice(0, 5), width: img.width, height: img.height, frame, diff }
  }, reference)
}

test('imported footage shows its own frames: the library card, and the inspector at the clip’s in-point', async ({
  page,
}) => {
  await openBlank(page)
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press(`${mod}+i`)
  await (await chooser).setFiles(['frames.mp4', 'image.png'].map((f) => path.join(FIXTURE_DIR, f)))

  // The card shows the clip 10 % in (0.4 s of 4 s: frame 12), not drawn sample art.
  const card = page.getByLabel('frames, video')
  const cardThumb = card.locator('div').first()
  await expect.poll(async () => (await shown(cardThumb))?.frame, { timeout: 15_000 }).toBe(12)
  expect(await shown(cardThumb)).toMatchObject({ url: 'blob:', width: 320, height: 180 })

  // The image card shows the image itself.
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'image.png')])
  const imageUrl = await page.evaluate(() => URL.createObjectURL(window.mvStudio.files()[0]))
  const imageThumb = page.getByLabel('image, image').locator('div').first()
  await expect
    .poll(async () => (await shown(imageThumb, imageUrl))?.diff, { timeout: 15_000 })
    .toBeLessThan(8)

  // Added clips start at the in-point the inspector header shows.
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText('frames', { exact: true })).toBeVisible()
  const headerThumb = inspector.locator('[style*="background-image"]').first()
  await expect.poll(async () => (await shown(headerThumb))?.frame, { timeout: 15_000 }).toBe(0)

  const setInPoint = (sourceStart: number) =>
    page.evaluate((value) => {
      const { editor } = window.mvStudio.app.project
      const clip = Object.values(editor.getProject().clips).find(
        (c) => (c as { type: string }).type === 'video',
      ) as { id: string }
      editor.dispatch([
        { type: 'clip.set', clipId: clip.id, path: ['duration'], value: 1.5 },
        { type: 'clip.set', clipId: clip.id, path: ['sourceStart'], value },
      ])
    }, sourceStart)
  await setInPoint(2)
  await expect.poll(async () => (await shown(headerThumb))?.frame, { timeout: 15_000 }).toBe(60)
  await setInPoint(1)
  await expect.poll(async () => (await shown(headerThumb))?.frame, { timeout: 15_000 }).toBe(30)
  expect(await shown(headerThumb)).toMatchObject({ url: 'blob:', width: 160, height: 90 })

  // While the in-point is trimmed, the header keeps the last frame until the next one is made: it never shows the
  // whole-clip thumbnail (the card's) or the icon in between.
  const wholeUrl = await cardThumb.evaluate((el) => (el as HTMLElement).style.backgroundImage)
  const header = await headerThumb.locator('..').elementHandle()
  await page.evaluate((el) => {
    const seen: string[] = []
    const observer = new MutationObserver(() => {
      const thumb = el!.querySelector<HTMLElement>('[style*="background-image"]')
      seen.push(thumb ? thumb.style.backgroundImage : 'none')
    })
    observer.observe(el!, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
    Object.assign(window, { trim: { seen, stop: () => observer.disconnect() } })
  }, header)
  await page.evaluate(async () => {
    const { editor } = window.mvStudio.app.project
    const clip = Object.values(editor.getProject().clips).find(
      (c) => (c as { type: string }).type === 'video',
    ) as { id: string }
    for (let i = 11; i <= 25; i++) {
      editor.dispatch(
        { type: 'clip.set', clipId: clip.id, path: ['sourceStart'], value: i / 10 },
        { coalesceKey: 'e2e:trim' },
      )
      await new Promise(requestAnimationFrame)
    }
    editor.endGesture()
  })
  await expect.poll(async () => (await shown(headerThumb))?.frame, { timeout: 15_000 }).toBe(75)
  const seen: string[] = await page.evaluate(() => {
    const { trim } = window as unknown as { trim: { seen: string[]; stop: () => void } }
    trim.stop()
    return trim.seen
  })
  expect(seen.length).toBeGreaterThan(1)
  expect(seen).not.toContain('none')
  expect(seen).not.toContain(wholeUrl)
})
