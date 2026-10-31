import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/** Opens the sample with model-free footage analysis that waits for `window.releaseAnalysis()` before each clip. */
async function openWithHeldAnalysis(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    ;(window as Untyped).releaseAnalysis = release
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        await held
        for (const b of bitmaps) b.close()
        return { dim: 2, data: new Float32Array(bitmaps.flatMap(() => [0.6, 0.8])) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        return { dim: 2, data: new Float32Array(texts.flatMap(() => [0.6, 0.8])) }
      },
    }
    ;(window as Untyped).mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
}

test('Library › Media marks clips that footage analysis has not finished, and drops the mark when they are ready', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openWithHeldAnalysis(page)
  const card = page.getByLabel('Night city, video', { exact: false })
  // Before any analysis runs, no card is marked.
  await expect(card).toHaveAccessibleName('Night city, video')
  await expect(page.getByText('Analyzing…')).toHaveCount(0)

  await page.evaluate(() => (window as Untyped).mvStudio.app.footage.analyzeFootageNow())
  await expect(card).toHaveAccessibleName(/^Night city, video, (analyzing|waiting to be analyzed)$/)
  // One clip is analyzed at a time; the others wait their turn.
  await expect(page.getByText('Analyzing…')).toHaveCount(1)
  const analyzed = page.getByLabel(/, analyzing$/)
  await expect(analyzed.getByText('Analyzing…')).toBeVisible()
  expect(await page.getByText('Waiting', { exact: true }).count()).toBeGreaterThanOrEqual(7)
  // Hovering shows the card's +; the mark keeps only its spinner so the two don't touch.
  await analyzed.hover()
  await expect(analyzed.getByText('Analyzing…')).toBeHidden()

  await page.evaluate(() => (window as Untyped).releaseAnalysis())
  await expect(page.getByText('Analyzing…')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByText('Waiting', { exact: true })).toHaveCount(0)
  await expect(card).toHaveAccessibleName('Night city, video')
})
