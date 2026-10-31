import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEffectsTab(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=effects&t=66.9'
  })
  await waitForPreview(page)
  return {
    preview: page.getByRole('img', { name: 'Video preview' }),
    library: page.getByRole('tabpanel', { name: 'Effects' }),
    inspector: page.getByRole('tabpanel', { name: 'Inspector' }),
  }
}

/** Mean absolute pixel difference (0..255) between two same-sized PNGs, below the top 15% where toasts show. */
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
      const from = Math.floor(x.length * 0.15) & ~3
      let sum = 0
      for (let i = from; i < x.length; i++) if (i % 4 !== 3) sum += Math.abs(x[i] - y[i])
      return sum / (((x.length - from) / 4) * 3)
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

/** A screenshot of the preview once it has stopped changing. */
async function settled(page: Page, preview: ReturnType<Page['getByRole']>): Promise<Buffer> {
  let last = await preview.screenshot()
  await expect
    .poll(async () => {
      const next = await preview.screenshot()
      const diff = await imageDiff(page, last, next)
      last = next
      return diff
    })
    .toBeLessThan(0.3)
  return last
}

test('a look from the library restyles the whole video as one undo step; the inspector shows it and blends it', async ({
  page,
}, testInfo) => {
  const { preview, library, inspector } = await openEffectsTab(page)
  const neon = library.getByRole('button', { name: 'Neon night', exact: true })
  const golden = library.getByRole('button', { name: 'Golden hour', exact: true })
  const original = library.getByRole('button', { name: 'Original', exact: true })

  // The sample project starts with the Neon night look at 70%.
  await expect(neon).toHaveAttribute('aria-pressed', 'true')
  await expect(library.getByRole('button', { pressed: true })).toHaveCount(1)
  await expect(inspector.getByText('Neon night', { exact: true })).toBeVisible()
  await expect(inspector.getByText('On every clip')).toBeVisible()
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()
  const before = await settled(page, preview)
  await page.screenshot({ path: testInfo.outputPath('effects-tab.png') })

  await golden.click()
  await expect(golden).toHaveAttribute('aria-pressed', 'true')
  await expect(neon).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('Look “Golden hour” applied to the whole video')).toBeVisible()
  await expect(inspector.getByText('Golden hour', { exact: true })).toBeVisible()
  // The intensity stays with the video when the look changes.
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()
  await expect.poll(async () => imageDiff(page, before, await preview.screenshot())).toBeGreaterThan(2)
  const goldenFrame = await settled(page, preview)
  await page.screenshot({ path: testInfo.outputPath('effects-golden-hour.png') })

  // At 0% the look layer shows the picture as if there were no look. Home sets the slider, not the playhead.
  await inspector.getByRole('slider', { name: 'Look intensity' }).focus()
  await page.keyboard.press('Home')
  await expect(inspector.getByText('0%', { exact: true })).toBeVisible()
  await expect(page.getByText('01:06.90')).toBeVisible()
  await expect.poll(async () => imageDiff(page, goldenFrame, await preview.screenshot())).toBeGreaterThan(2)
  const none = await settled(page, preview)
  await original.click()
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  await expect(inspector.getByText('No look on the video')).toBeVisible()
  await expect(inspector.getByRole('slider', { name: 'Look intensity' })).toHaveCount(0)
  expect(await imageDiff(page, none, await settled(page, preview))).toBeLessThan(0.5)
  await page.screenshot({ path: testInfo.outputPath('effects-original.png') })

  // Removing the look, the intensity change and the look are one undo step each.
  await page.keyboard.press(`${mod}+z`)
  await expect(golden).toHaveAttribute('aria-pressed', 'true')
  await expect(inspector.getByText('0%', { exact: true })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(neon).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => imageDiff(page, before, await preview.screenshot())).toBeLessThan(0.5)
})

test('effects and transitions from the library go on the clip at the playhead, and the search narrows the lists', async ({
  page,
}) => {
  const { library, inspector } = await openEffectsTab(page)
  const glowTarget = () =>
    page.evaluate(() => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      const clip = Object.values(project.clips).find(
        (c) => c.type !== 'audio' && c.meta?.role !== 'look' && c.effects.some((e) => e.effectId === 'glow'),
      )
      return clip
        ? { id: clip.id, type: clip.type, start: clip.start, end: clip.start + clip.duration }
        : null
    })

  await library.getByRole('button', { name: 'Glow', exact: true }).click()
  await expect(page.getByText(/^“Glow” added to /)).toBeVisible()
  const target = await glowTarget()
  expect(target?.type).toMatch(/^(video|image)$/)
  expect(target!.start).toBeLessThanOrEqual(66.9)
  expect(target!.end).toBeGreaterThan(66.9)
  // The clip is selected, and its Effects section lists the effect by name.
  await inspector.getByRole('button', { name: /^Effects/ }).click()
  await expect(inspector.getByText('Glow', { exact: true })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(inspector.getByText('No effects yet. Add one from Library › Effects.')).toBeVisible()
  expect(await glowTarget()).toBeNull()

  // With the clip selected, a transition goes on the cut at its start.
  await library.getByRole('button', { name: 'Flash', exact: true }).click()
  await expect(page.getByText(/^“Flash” added to the cut at \d+:\d\d\.\d$/)).toBeVisible()
  const transition = await page.evaluate(
    (id) => window.mvStudio.app.project.editor.getProject().clips[id].transitionIn,
    target!.id,
  )
  expect(transition).toMatchObject({ kind: 'flash' })

  const search = library.getByRole('textbox', { name: 'Search looks and effects' })
  await search.fill('glitch')
  await expect(library.getByRole('button', { name: 'Glitch', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Glitch cut', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Golden hour' })).toHaveCount(0)
  await search.fill('warm')
  await expect(library.getByRole('button', { name: 'Golden hour', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Light leak', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Glitch', exact: true })).toHaveCount(0)
  await search.fill('qwerty')
  await expect(library.getByText('No matches')).toBeVisible()
})
