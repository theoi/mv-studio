import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/**
 * Opens the sample in the editor with model-free embeddings: a frame embeds as its mean color, and a text as the
 * first frame analyzed plus a little of its own direction, so every query finds the clips that look like that frame
 * and the tag captions differ enough for some to stand out.
 */
async function openSample(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const seen: number[][] = []
    const unit = (v: number[]) => {
      const n = Math.hypot(...v)
      return v.map((x) => x / n)
    }
    const meanColor = (bitmap: ImageBitmap) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[]
      return unit([r! / 255 + 0.01, g! / 255 + 0.01, b! / 255 + 0.01, 0.1])
    }
    const direction = (text: string) =>
      [7, 13, 29, 31].map((seed) => {
        let x = seed
        for (const c of text) x = (x * 31 + c.charCodeAt(0)) % 9973
        return x / 9973 - 0.5
      })
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        const w = window as Untyped
        if (w.__embedGate) await w.__embedGate
        if (w.__embedFails) {
          for (const b of bitmaps) b.close()
          throw new Error('This clip’s frames can’t be read.')
        }
        const data = bitmaps.flatMap((b) => {
          const v = meanColor(b)
          b.close()
          seen.push(v)
          return v
        })
        return { dim: 4, data: new Float32Array(data) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        const base = seen[0] ?? [0.5, 0.5, 0.5, 0.5]
        return {
          dim: 4,
          data: new Float32Array(texts.flatMap((t) => unit(base.map((x, i) => x + 0.35 * direction(t)[i]!)))),
        }
      },
    }
    ;(window as Untyped).mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

/** Waits until footage analysis has matched and tagged every clip and stopped. */
const analysisDone = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          const indexing = window.mvStudio.app.footage.useFootage.getState().indexing
          const project = window.mvStudio.app.project.editor.getProject()
          const clips = Object.values(project.assets as Record<string, Untyped>).filter(
            (a) =>
              (a.origin.type === 'import' || a.origin.type === 'generated') &&
              (a.kind === 'image' || a.kind === 'video'),
          )
          return (
            indexing?.status === 'idle' &&
            clips.every(
              (a) =>
                project.analysis.visual[a.id]?.data?.embedding && project.analysis.visual[a.id]?.data?.tags,
            )
          )
        }),
      { timeout: 150_000 },
    )
    .toBe(true)
test('Assist › Match analyzes the clips on request, picks clips for each part of the song, and places a pick', async ({
  page,
}) => {
  test.setTimeout(200_000)
  await openSample(page, '#/editor?kind=footage&tab=assist&assist=match&t=73.6')
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const clipCount = await page.evaluate(
    () =>
      Object.values(window.mvStudio.app.project.editor.getProject().assets as Record<string, Untyped>).filter(
        (a) =>
          (a.origin.type === 'import' || a.origin.type === 'generated') &&
          (a.kind === 'image' || a.kind === 'video'),
      ).length,
  )

  // Background analysis is off in automated browsers, so Match offers to analyze, with its cost.
  await expect(assist.getByText('0 clips tagged on this device')).toBeVisible()
  await expect(assist.getByText(/^Your clips aren’t analyzed yet\./)).toBeVisible()
  await expect(assist.getByText(/Runs on this device · free · \d+ MB download, once/)).toBeVisible()
  await expect(assist.getByRole('group', { name: /^Picks for / })).toHaveCount(0)
  await assist.getByRole('button', { name: 'Analyze footage' }).click()
  await expect(assist.getByText(/^Analyzing your footage… \d+ of \d+ clips/)).toBeVisible()
  await analysisDone(page)
  await expect(assist.getByText(`${clipCount} clips tagged on this device`)).toBeVisible()
  await expect(assist.getByRole('button', { name: 'Analyze footage' })).toHaveCount(0)

  // One group per kind of section, each with the footage service's best clips for it.
  const chorus = await page.evaluate(async () => {
    const project = window.mvStudio.app.project.editor.getProject()
    const section = project.analysis.audio[project.songAssetId].sections.find(
      (s: Untyped) => s.label === 'Chorus',
    )
    const service = await window.mvStudio.app.footage.footageService()
    const results = await service.suggestForSection(section.id)
    return {
      start: section.start as number,
      end: section.end as number,
      picks: results.slice(0, 3).map((r: Untyped) => ({
        assetId: r.assetId as string,
        name: (r.name as string).replace(/\.[^.]+$/, ''),
        range: r.range as { start: number; end: number },
      })),
    }
  })
  const group = assist.getByRole('group', { name: 'Picks for Chorus' })
  await expect(group.getByRole('button')).toHaveCount(3)
  expect(
    await group.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  ).toEqual(chorus.picks.map((p: { name: string }) => `Use ${p.name} in Chorus`))
  await expect(assist.getByRole('group', { name: /^Picks for / })).toHaveCount(
    await page.evaluate(() => {
      const project = window.mvStudio.app.project.editor.getProject()
      const kinds = project.analysis.audio[project.songAssetId].sections.map((s: Untyped) => {
        const l = s.label.toLowerCase()
        return l.includes('pre')
          ? 'pre'
          : l.includes('chorus')
            ? 'chorus'
            : l.includes('bridge')
              ? 'bridge'
              : l.includes('intro')
                ? 'intro'
                : l.includes('outro') || l.includes('end')
                  ? 'outro'
                  : 'verse'
      })
      return new Set(kinds).size
    }),
  )

  // A pick places its best part at the start of the section.
  const best = chorus.picks[0]!
  await group.getByRole('button', { name: `Use ${best.name} in Chorus` }).click()
  await expect
    .poll(() =>
      page.evaluate(
        ({ assetId, start }) =>
          Object.values(
            window.mvStudio.app.project.editor.getProject().clips as Record<string, Untyped>,
          ).filter((c) => c.assetId === assetId && Math.abs(c.start - start) < 1e-6).length,
        { assetId: best.assetId, start: chorus.start },
      ),
    )
    .toBe(1)
  const placed = await page.evaluate(
    ({ assetId, start }) =>
      Object.values(window.mvStudio.app.project.editor.getProject().clips as Record<string, Untyped>).find(
        (c) => c.assetId === assetId && Math.abs(c.start - start) < 1e-6,
      ),
    { assetId: best.assetId, start: chorus.start },
  )
  expect(placed.sourceStart).toBeCloseTo(best.range.start, 3)
  expect(placed.duration).toBeLessThanOrEqual(chorus.end - chorus.start + 1e-6)
  // A toast confirms it, and its Undo takes the clip off again.
  const added = page.getByRole('status').filter({ hasText: `Added ${best.name} to Chorus` })
  await expect(added).toBeVisible()
  await added.getByRole('button', { name: 'Undo' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        ({ assetId, start }) =>
          Object.values(
            window.mvStudio.app.project.editor.getProject().clips as Record<string, Untyped>,
          ).filter((c) => c.assetId === assetId && Math.abs(c.start - start) < 1e-6).length,
        { assetId: best.assetId, start: chorus.start },
      ),
    )
    .toBe(0)

  // Placing keeps Match open, so picks can be placed one after another from the keyboard: focus stays on the pick
  // and Tab moves to the next one.
  const pick = group.getByRole('button', { name: `Use ${best.name} in Chorus` })
  await pick.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: `Added ${best.name} to Chorus` })).toBeVisible()
  await expect(assist).toBeVisible()
  await expect(pick).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(group.getByRole('button').nth(1)).toBeFocused()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect
    .poll(() =>
      page.evaluate(
        ({ assetId, start }) =>
          Object.values(
            window.mvStudio.app.project.editor.getProject().clips as Record<string, Untyped>,
          ).filter((c) => c.assetId === assetId && Math.abs(c.start - start) < 1e-6).length,
        { assetId: best.assetId, start: chorus.start },
      ),
    )
    .toBe(0)

  // Library › Media shows each clip's tags on hover: the clip name, then the tags analysis stored.
  const asset = await page.evaluate((id) => {
    const project = window.mvStudio.app.project.editor.getProject()
    const a = project.assets[id]
    return { name: (a.name as string).replace(/\.[^.]+$/, ''), tags: project.analysis.visual[id].data.tags }
  }, best.assetId)
  expect(asset.tags.length).toBeGreaterThan(0)
  const media = page.getByRole('tabpanel', { name: 'Media' })
  await media.getByLabel(new RegExp(`^${asset.name}, `)).hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toContainText(asset.name)
  await expect(tooltip).toContainText(asset.tags.slice(0, 5).join(' · '))
})

test('a selected section suggests re-cutting it until its footage matches, then "N clips match this chorus"', async ({
  page,
}) => {
  test.setTimeout(200_000)
  await openSample(page, '#/editor?t=73.6')
  const chorus = page.getByRole('button', { name: /^Section Chorus/ }).first()
  // A mouse pointerdown: one without a pointer type counts as touch, whose long press opens the section menu.
  await chorus.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  await expect(page.getByText('Re-cut this chorus to the beat')).toBeVisible()
  await expect(page.getByText(/clips match this chorus/)).toHaveCount(0)

  await page.evaluate(() => window.mvStudio.app.footage.analyzeFootageNow())
  await analysisDone(page)
  const sectionId = await page.evaluate(
    () => new URLSearchParams(location.hash.split('?')[1]).get('sel')?.split(':')[1] ?? '',
  )
  const strong = await page.evaluate(async (id) => {
    const { footage } = window.mvStudio.app
    const service = await footage.footageService()
    const threshold = footage.useFootage.getState().strongMatch
    return (await service.suggestForSection(id)).filter((r: Untyped) => r.score >= threshold).length
  }, sectionId)
  expect(strong).toBeGreaterThanOrEqual(2)
  const chip = page.getByRole('note').filter({ hasText: `${strong} clips match this chorus` })
  await expect(chip).toBeVisible()
  await expect(page.getByText('Re-cut this chorus to the beat')).toHaveCount(0)

  // Show opens Library › Media with the section's suggestions in view.
  const media = page.getByRole('tabpanel', { name: 'Media' })
  await page.getByRole('tab', { name: 'Text' }).click()
  await chip.getByRole('button', { name: 'Show' }).click()
  await expect(media.getByText('Suggested for Chorus')).toBeInViewport()

  // Dismissing it quiets the section: the re-cut suggestion does not come back.
  await chip.getByRole('button', { name: 'Dismiss suggestion' }).click()
  await expect(page.getByText(/clips match this chorus/)).toHaveCount(0)
  await expect(page.getByText('Re-cut this chorus to the beat')).toHaveCount(0)
})

test('Cancel stops footage analysis silently in Match and Auto-cut; clips that fail show why and Try again retries them', async ({
  page,
}) => {
  test.setTimeout(200_000)
  await openSample(page, '#/editor?kind=footage&tab=assist&assist=match&t=73.6')
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const analyze = assist.getByRole('button', { name: /^Analyze (footage|\d+ more clips?)$/ })
  /** Holds every frame embedding until `release()`, so analysis is reliably still running. */
  const hold = () =>
    page.evaluate(() => {
      const w = window as Untyped
      w.__embedGate = new Promise<void>((resolve) => (w.__releaseEmbeds = resolve))
    })
  const release = () => page.evaluate(() => (window as Untyped).__releaseEmbeds())
  const status = () => page.evaluate(() => window.mvStudio.app.footage.useFootage.getState().indexing?.status)

  // Match: Cancel in the analyzing note stops the run and brings the offer back, with nothing else said.
  await hold()
  await analyze.click()
  const analyzingNote = assist.getByText(/^Analyzing your footage…/)
  await expect(analyzingNote).toBeVisible()
  await assist.getByRole('button', { name: 'Cancel' }).click()
  await release()
  await expect(analyzingNote).toBeHidden()
  await expect.poll(status).toBe('paused')
  await expect(analyze).toBeFocused()
  await expect(assist.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText(/cancel/i)).toHaveCount(0)

  // Auto-cut: the same note has a Cancel, which puts focus on Cut to the beat.
  await hold()
  await analyze.click()
  await page.evaluate(() => window.mvStudio.app.ui.openAssist('autocut'))
  const autocutNote = assist.getByText(/^Analyzing your footage… .* Cut again when it’s done/)
  await expect(autocutNote).toBeVisible()
  await assist.getByRole('button', { name: 'Cancel' }).click()
  await release()
  await expect(autocutNote).toBeHidden()
  await expect.poll(status).toBe('paused')
  await expect(assist.getByText(/analyzed yet, so this cut picks (it|them) for variety/)).toBeVisible()
  await expect(assist.getByRole('button', { name: 'Cut to the beat' })).toBeFocused()

  // Clips analysis can't read: Match says how many and why, offers only Try again, and that retries them.
  await page.evaluate(() => {
    ;(window as Untyped).__embedFails = true
    window.mvStudio.app.ui.openAssist('match')
  })
  await analyze.click()
  const failure = assist.getByRole('alert').filter({ hasText: /couldn’t be analyzed/ })
  await expect(failure).toBeVisible({ timeout: 150_000 })
  await expect.poll(status).toBe('idle')
  const failed = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return window.mvStudio.app.footage.useFootage
      .getState()
      .indexing.failed.filter((f: Untyped) => !project.analysis.visual[f.assetId]?.data?.embedding)
      .map((f: Untyped) => f.message as string)
  })
  expect(failed.length).toBeGreaterThan(1)
  await expect(failure).toContainText(`${failed.length} clips couldn’t be analyzed`)
  await expect(failure).toContainText(failed[0]!)
  await expect(analyze).toHaveCount(0)
  await page.evaluate(() => ((window as Untyped).__embedFails = false))
  await assist.getByRole('button', { name: 'Try again' }).click()
  await analysisDone(page)
  await expect(failure).toBeHidden()
  await expect(assist.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(assist.getByRole('group', { name: 'Picks for Chorus' }).getByRole('button')).toHaveCount(3)
})
