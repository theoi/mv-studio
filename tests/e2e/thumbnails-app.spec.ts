import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

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

test('imported footage shows its own frames: the library card, and the inspector and timeline at the clip’s in-point', async ({
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

  // The inspector header and the clip on the timeline show the frame at the clip's in-point.
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText('frames', { exact: true })).toBeVisible()
  const headerThumb = inspector.locator('[style*="background-image"]').first()
  const timelineClip = page.getByRole('button', { name: /^frames, 0:00\.0 to / })
  const frames = async () => [(await shown(headerThumb))?.frame, (await shown(timelineClip))?.frame]
  await expect.poll(frames, { timeout: 15_000 }).toEqual([0, 0])

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
  await expect.poll(frames, { timeout: 15_000 }).toEqual([60, 60])
  await setInPoint(1)
  await expect.poll(frames, { timeout: 15_000 }).toEqual([30, 30])
  expect(await shown(headerThumb)).toMatchObject({ url: 'blob:', width: 160, height: 90 })
  expect(await shown(timelineClip)).toMatchObject({ url: 'blob:', width: 160, height: 90 })

  // While the in-point is trimmed, both keep the last frame until the next one is made: neither shows the
  // whole-clip thumbnail (the card's) or nothing in between.
  const wholeUrl = await cardThumb.evaluate((el) => (el as HTMLElement).style.backgroundImage)
  const header = await headerThumb.locator('..').elementHandle()
  const block = await timelineClip.elementHandle()
  await page.evaluate(
    ([headerEl, blockEl]) => {
      const seen: string[] = []
      const record = (el: HTMLElement | null) => seen.push(el?.style.backgroundImage || 'none')
      const observers = [
        new MutationObserver(() => record(headerEl!.querySelector('[style*="background-image"]'))),
        new MutationObserver(() => record(blockEl as HTMLElement)),
      ]
      const watch = { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] }
      observers[0]!.observe(headerEl!, watch)
      observers[1]!.observe(blockEl!, { attributes: true, attributeFilter: ['style'] })
      Object.assign(window, { trim: { seen, stop: () => observers.forEach((o) => o.disconnect()) } })
    },
    [header, block] as const,
  )
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
  await expect.poll(frames, { timeout: 15_000 }).toEqual([75, 75])
  const seen: string[] = await page.evaluate(() => {
    const { trim } = window as unknown as { trim: { seen: string[]; stop: () => void } }
    trim.stop()
    return trim.seen
  })
  expect(seen.length).toBeGreaterThan(1)
  expect(seen).not.toContain('none')
  expect(seen).not.toContain(wholeUrl)
})

/** The names of the files kept beside an asset's media (its thumbnails), or null once its folder is gone. */
function keptFiles(page: Page, assetId: string) {
  return page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory()
    let folder: FileSystemDirectoryHandle
    try {
      folder = await (await root.getDirectoryHandle('media')).getDirectoryHandle(id)
    } catch {
      return null
    }
    const names: string[] = []
    try {
      const derived = await folder.getDirectoryHandle('derived')
      for await (const name of (derived as unknown as { keys(): AsyncIterable<string> }).keys())
        names.push(name)
    } catch {
      // Nothing kept yet.
    }
    return names.sort()
  }, assetId)
}

interface ThumbLog {
  /** When the thumbnails' video decoder (the vision-frames worker) started, ms since navigation. */
  decoder: number[]
  /** When the preview showed its first frame. */
  firstFrame?: number
}

test('a reload shows the thumbnails kept beside the media without decoding the video, and decoding waits for the preview’s first frame', async ({
  page,
}) => {
  await openBlank(page)
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press(`${mod}+i`)
  // With a song, so the editor shows the preview.
  await (await chooser).setFiles(['song.wav', 'frames.mp4'].map((f) => path.join(FIXTURE_DIR, f)))
  await waitForPreview(page)
  const card = page.getByLabel('frames, video')
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const cardThumb = card.locator('div').first()
  const timelineClip = page.getByRole('button', { name: /^frames, 0:00\.0 to / })
  const frames = async () => [(await shown(cardThumb))?.frame, (await shown(timelineClip))?.frame]
  await expect.poll(frames, { timeout: 15_000 }).toEqual([12, 0])
  const { projectId, assetId } = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const assets = Object.values(project.assets) as { id: string; kind: string }[]
    return { projectId: project.id as string, assetId: assets.find((a) => a.kind === 'video')!.id }
  })
  const kept = ['thumb1-card-320x180.jpg', 'thumb1-frame-160x90-0.jpg']
  await expect.poll(() => keptFiles(page, assetId)).toEqual(kept)
  await page.waitForFunction((id) => location.hash.includes(`project=${id}`), projectId)

  await page.addInitScript(() => {
    const log: ThumbLog = { decoder: [] }
    Object.assign(window, { thumbLog: log })
    const Base = window.Worker
    window.Worker = class extends Base {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name === 'vision-frames') log.decoder.push(performance.now())
      }
    }
    new MutationObserver(() => {
      if (
        log.firstFrame === undefined &&
        document.querySelector('[aria-label="Video preview"][aria-busy="false"]')
      )
        log.firstFrame = performance.now()
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] })
  })
  const thumbLog = () => page.evaluate(() => (window as unknown as { thumbLog: ThumbLog }).thumbLog)

  // Kept: shown again without decoding the video.
  await page.reload()
  await waitForPreview(page)
  await expect.poll(frames, { timeout: 15_000 }).toEqual([12, 0])
  expect((await thumbLog()).decoder).toEqual([])

  // Not kept (a project file opened in another browser): made again, after the preview's first frame, and kept.
  await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory()
    const folder = await (await root.getDirectoryHandle('media')).getDirectoryHandle(id)
    await folder.removeEntry('derived', { recursive: true })
  }, assetId)
  await page.reload()
  await waitForPreview(page)
  await expect.poll(frames, { timeout: 15_000 }).toEqual([12, 0])
  const log = await thumbLog()
  expect(log.decoder).toHaveLength(1)
  expect(log.decoder[0]).toBeGreaterThan(log.firstFrame!)
  await expect.poll(() => keptFiles(page, assetId)).toEqual(kept)

  // They go with the media.
  await page.evaluate((id) => window.mvStudio.app.persistence.deleteProject(id), projectId)
  await expect.poll(() => keptFiles(page, assetId)).toBeNull()
})
