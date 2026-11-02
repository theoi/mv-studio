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

  // Search ranks clips by what they show, as the footage service ranks them. Rank once every clip is analyzed, so a
  // clip that finishes late cannot reorder the list after the ranking was taken.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const indexing = window.mvStudio.app.footage.useFootage.getState().indexing
          return !!indexing && indexing.status !== 'indexing' && indexing.done === indexing.total
        }),
      { timeout: 120_000 },
    )
    .toBe(true)
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

/** The clip footage analysis is on, with its step and progress (which goes up with each frame it decodes). */
function analyzing(page: Page): Promise<{ name: string; step: string; fraction: number } | null> {
  return page.evaluate(() => window.mvStudio.app.footage.useFootage.getState().indexing?.current ?? null)
}

function analysisStatus(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const { service } = window.mvStudio.app.footage.useFootage.getState()
    const project = window.mvStudio.app.project.editor.getProject()
    const clip = Object.values(project.assets as Record<string, Untyped>).find((a) => a.name === n)
    return service && clip ? service.indexing.statusOf(clip.id) : 'not started'
  }, name)
}

/** Holds footage analysis until `window.endHold()` is called. */
async function holdAnalysis(page: Page) {
  await page.evaluate(() => {
    const w = window as Untyped
    w.endHold = () => {}
    w.mvStudio.app.footage.holdAnalysisUntil(new Promise<void>((resolve) => (w.endHold = resolve)), 100_000)
  })
}

test('background analysis decodes no frame while a hold lasts, and goes on once it ends', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openWithAnalysis(page)
  await holdAnalysis(page)
  await page.getByLabel('Import media files').setInputFiles(path.join(FIXTURE_DIR, 'clip.mp4'))
  await expect(page.getByLabel('clip, video')).toBeVisible()
  await expect.poll(async () => (await analyzing(page))?.step, { timeout: 30_000 }).toBe('matching')
  await page.waitForTimeout(1500)
  expect(await analyzing(page)).toMatchObject({ step: 'matching', fraction: 0 })
  await page.evaluate(() => (window as Untyped).endHold())
  await expect.poll(() => analysisStatus(page, 'clip.mp4'), { timeout: 90_000 }).toBe('indexed')
})

test('a draft holds background analysis while it plans and until the preview shows it', async ({ page }) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    const w = window as Untyped
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.background-analysis', 'on')
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        for (const b of bitmaps) b.close()
        return { dim: 2, data: new Float32Array(bitmaps.flatMap(() => [0.6, 0.8])) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        return { dim: 2, data: new Float32Array(texts.flatMap(() => [0.6, 0.8])) }
      },
    }
    w.mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
    // While `notShown` is set, the preview shows nothing it is given until `show()` is called.
    const proto = w.mvStudio.engine.PreviewController.prototype
    const rendered = proto.rendered
    w.notShown = null
    proto.rendered = function (this: unknown) {
      return w.notShown ? w.notShown.then(() => rendered.call(this)) : rendered.call(this)
    }
  })
  await holdAnalysis(page)
  await page.getByRole('button', { name: /AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('neon night drive')
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByLabel('Clip files').setInputFiles(path.join(FIXTURE_DIR, 'clip.mp4'))
  await expect(page.getByRole('list', { name: 'Your clips' }).getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: 'Draft my video' }).click()
  await expect(page.getByText(/^Placed \d+ (shots|scenes)/)).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await analyzing(page))?.step, { timeout: 30_000 }).toBe('matching')

  const clipIds = () =>
    page.evaluate(() => Object.keys(window.mvStudio.app.project.editor.getProject().clips).sort().join())
  const first = await clipIds()
  const before = await analyzing(page)
  await page.evaluate(() => {
    const w = window as Untyped
    w.notShown = new Promise<void>((resolve) => (w.show = resolve))
  })
  await page.getByRole('button', { name: 'Try another version' }).click()
  // The draft holds analysis from the click: with the earlier hold over, no frame is decoded while it plans, nor until
  // the preview shows it.
  await page.evaluate(() => (window as Untyped).endHold())
  await expect.poll(clipIds, { timeout: 60_000 }).not.toBe(first)
  await page.waitForTimeout(1500)
  expect(await analyzing(page)).toEqual(before)
  await page.evaluate(() => (window as Untyped).show())
  await expect.poll(() => analysisStatus(page, 'clip.mp4'), { timeout: 90_000 }).toBe('indexed')
})

test('background analysis waits while the stage waits for a paused frame', async ({ page }) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.background-analysis', 'on')
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
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
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await holdAnalysis(page)
  await page.getByLabel('Import media files').setInputFiles(path.join(FIXTURE_DIR, 'clip4k.mp4'))
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('clip4k, video')
  await card.hover({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  await expect(page.getByRole('button', { name: /^clip4k, 0:00/ })).toHaveCount(1)
  await expect.poll(async () => (await analyzing(page))?.step, { timeout: 30_000 }).toBe('matching')

  const stillPending = () => page.evaluate(() => window.mvStudio.app.stillPending() as boolean)
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 0.2 }))
  await expect.poll(stillPending, { timeout: 30_000 }).toBe(false)
  const before = await analyzing(page)
  // 5.5 s is 330 frames past the clip's only key frame: the stage waits for that frame a while.
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 5.5 }))
  await expect.poll(stillPending).toBe(true)
  await page.evaluate(() => (window as Untyped).endHold())
  const seen: { pending: boolean; same: boolean }[] = []
  const started = Date.now()
  while (Date.now() - started < 1500) {
    const [pending, now] = await Promise.all([stillPending(), analyzing(page)])
    seen.push({ pending, same: JSON.stringify(now) === JSON.stringify(before) })
    if (!pending) break
    await page.waitForTimeout(100)
  }
  expect(seen.filter((s) => s.pending).length).toBeGreaterThan(3)
  expect(seen.filter((s) => s.pending && !s.same)).toEqual([])
  await expect.poll(() => analysisStatus(page, 'clip4k.mp4'), { timeout: 90_000 }).toBe('indexed')
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
