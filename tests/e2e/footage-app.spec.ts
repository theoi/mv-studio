import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/** Opens the sample in the editor with background analysis on, using model-free embeddings (mean color). */
async function openWithAnalysis(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.background-analysis', 'on')
    const seen: number[][] = []
    const meanColor = (bitmap: ImageBitmap) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[]
      const v = [r! / 255 + 0.01, g! / 255 + 0.01, b! / 255 + 0.01, 0.1]
      const n = Math.hypot(...v)
      return v.map((x) => x / n)
    }
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        const data = bitmaps.flatMap((b) => {
          const v = meanColor(b)
          b.close()
          seen.push(v)
          return v
        })
        return { dim: 4, data: new Float32Array(data) }
      },
      // Every text means "the first frame analyzed", so that clip is a strong match for any line or search.
      async embedTexts({ texts }: { texts: string[] }) {
        const v = seen[0] ?? [0.5, 0.5, 0.5, 0.5]
        return { dim: 4, data: new Float32Array(texts.flatMap(() => v)) }
      },
    }
    ;(window as Untyped).mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
    window.location.hash = '#/editor?t=70.4'
  })
  await waitForPreview(page)
}

function query(
  page: Page,
  kind: 'search' | 'line',
  value: string,
): Promise<{ name: string; score: number }[]> {
  return page.evaluate(
    async ([k, v]) => {
      const service = await (window as Untyped).mvStudio.app.footage.footageService()
      const results = k === 'search' ? await service.search(v) : await service.suggestForLine(v)
      return results.map((r: { name: string; score: number }) => ({
        name: r.name.replace(/\.[^.]+$/, ''),
        score: r.score,
      }))
    },
    [kind, value] as const,
  )
}

test('the library searches and suggests footage that background analysis has indexed', async ({ page }) => {
  test.setTimeout(150_000)
  await openWithAnalysis(page)
  // Opening the sample downloads and analyzes nothing until footage is searched or suggested.
  await page.waitForTimeout(2500)
  expect(await page.evaluate(() => window.mvStudio.app.footage.useFootage.getState().service)).toBeNull()

  // Searching starts the analysis of the sample's clips; results appear as clips finish.
  const search = page.getByRole('textbox', { name: 'Search media by content' })
  await search.fill('night city')
  await expect
    .poll(async () => (await query(page, 'search', 'night city')).length, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(8)

  // Search ranks clips by what they show, as the footage service ranks them.
  const ranked = (await query(page, 'search', 'night city')).map((r) => r.name)
  await search.fill('')
  await search.fill('night city')
  const media = page.getByRole('tabpanel', { name: 'Media' })
  await expect
    .poll(async () =>
      (
        await media
          .locator('[aria-label$=", video"], [aria-label$=", image"], [aria-label$=", generated"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace(/, \w+$/, '')))
      ).slice(0, ranked.length),
    )
    .toEqual(ranked)
  await search.fill('')

  // A selected lyric line gets the clips that match it, and one click places the best one under the line.
  const lyric = page.getByRole('button', { name: /^Lyric: / }).first()
  await lyric.dispatchEvent('pointerdown')
  const lineId = await page.evaluate(
    () => new URLSearchParams(location.hash.split('?')[1]).get('sel')?.split(':')[1] ?? '',
  )
  const strong = (await query(page, 'line', lineId)).filter((r) => r.score >= 0.7)
  expect(strong.length).toBeGreaterThan(0)
  await expect(
    page.getByText(
      strong.length === 1 ? '1 clip matches this line' : `${strong.length} clips match this line`,
    ),
  ).toBeVisible()
  await expect(media.getByText(/^Suggested for “/)).toBeVisible()
  const best = strong[0]!.name
  const placed = page.getByRole('button', { name: new RegExp(`^${best}, `) })
  const before = await placed.count()
  await media.getByRole('button', { name: `Use ${best}` }).click()
  await expect(placed).toHaveCount(before + 1)
})

test('importing a clip starts background analysis without asking', async ({ page }) => {
  await openWithAnalysis(page)
  await page.getByLabel('Import media files').setInputFiles(path.join(FIXTURE_DIR, 'clip.mp4'))
  await expect(page.getByLabel('clip, video')).toBeVisible()
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const { service } = window.mvStudio.app.footage.useFootage.getState()
          const project = window.mvStudio.app.project.editor.getProject()
          const clip = Object.values(project.assets as Record<string, Untyped>).find(
            (a) => a.name === 'clip.mp4',
          )
          return service && clip ? service.indexing.statusOf(clip.id) : 'not started'
        }),
      { timeout: 60_000 },
    )
    .toBe('indexed')
})

test('export framing says which clips have no one in them to follow', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
  // Subject tracks as background analysis writes them: a face in every clip but the city at night.
  await page.evaluate(() => {
    const { vision, app } = window.mvStudio
    const project = app.project.editor.getProject()
    const commands = Object.values(project.assets as Record<string, Untyped>)
      .filter((a) => a.kind === 'video' || a.kind === 'image')
      .map((a) => {
        const nobody = a.id === 'm-city'
        const sourceSize = { width: a.width ?? 1280, height: a.height ?? 720 }
        const subjects = {
          version: 1,
          mediaId: a.id,
          sourceSize,
          samples: [0, 1, 2].map((t) => ({
            t,
            focus: { x: nobody ? 0.5 : 0.62, y: 0.4 },
            box: nobody ? null : { x: 0.5, y: 0.2, width: 0.25, height: 0.6 },
            confidence: nobody ? 0 : 0.9,
            source: nobody ? 'none' : 'face',
          })),
        }
        const analysis = vision.buildVisualAnalysis(
          { assetId: a.id, duration: a.duration ?? 5, sourceSize, subjects },
          project.analysis.visual[a.id],
        )
        return { type: 'analysis.setVisual', analysis }
      })
    app.project.editor.dispatch(commands, { history: 'skip' })
  })
  await page.keyboard.press('Control+e')
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await dialog.getByRole('button', { name: /Vertical.*9:16/ }).click()
  await expect(
    dialog.getByText('Follows the subject. 1 clip with no one in it stays centered.'),
  ).toBeVisible()
})
