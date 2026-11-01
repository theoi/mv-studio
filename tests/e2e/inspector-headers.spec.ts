import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * The Inspector's header line for a clip, a lyric line, a look and several clips: every one shows its times to the
 * hundredth beside its length to the tenth, as a video's does, so the times and the length agree wherever it sits.
 */

const meta = (page: Page) =>
  page.getByRole('tabpanel', { name: 'Inspector' }).locator('[class*="headerText"] [class*="meta"]').first()

const show = (page: Page, hash: string) => page.evaluate((h) => (window.location.hash = h), hash)

test('text, lyric line, look and several clips show their times to the hundredth beside their length', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=70.4'
  })
  await waitForPreview(page)
  // Off the tenth, as a drag or a beat cut leaves them: the title card from 0:01.25, the look from 0:10.50.
  const look: string = await page.evaluate(() => {
    const { editor, dispatch } = window.mvStudio.app.project
    const clips = Object.values(editor.getProject().clips) as { id: string; type: string }[]
    const id = clips.find((c) => c.type === 'adjustment')!.id
    dispatch([
      { type: 'clip.trim', clipId: 'o-title', start: 1.25, duration: 7.5 },
      { type: 'clip.trim', clipId: id, start: 10.5, duration: 29.7 },
    ])
    return id
  })

  await show(page, '#/editor?sel=clip:o-title&t=3')
  await expect(meta(page)).toHaveText('Text · 0:01.25 – 0:08.75 · 7.5 s')
  await show(page, '#/editor?sel=lyric:l-pre-1&t=50')
  await expect(meta(page)).toHaveText('Pre-chorus · 0:48.50 – 0:51.80 · 3.3 s')
  await show(page, `#/editor?sel=clip:${look}&t=20`)
  await expect(meta(page)).toHaveText('Look · 0:10.50 – 0:40.20 · 29.7 s')
  await page.evaluate(() =>
    window.mvStudio.app.ui.set({ selection: { type: 'clip', id: 'o-spec2', ids: ['o-spec1', 'o-spec2'] } }),
  )
  await expect(
    page.getByRole('tabpanel', { name: 'Inspector' }).getByText('2 clips', { exact: true }),
  ).toBeVisible()
  await expect(meta(page)).toHaveText('1:04.00 – 2:40.00 · 96.0 s')
})

/** Whether the header's meta line (or one of its parts) is cut, and on how many lines it is. */
const fit = (page: Page) =>
  meta(page).evaluate((m) => {
    const parts = [...m.querySelectorAll('[class*="metaPart"]')]
    const lineHeight = parseFloat(getComputedStyle(m).lineHeight)
    return {
      cut: m.scrollWidth > m.clientWidth || parts.some((p) => p.scrollWidth > p.clientWidth),
      lines: Math.round(m.clientHeight / lineHeight),
    }
  })

test('at 1280 a long header line wraps between its parts instead of losing its length, and a short one keeps one line', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=70.4'
  })
  await waitForPreview(page)
  // A VJ recording's effect hit (an adjustment layer that isn't a look), a Background scene, the visualizer over the
  // whole song, a section the user renamed, and the look trimmed off the tenth.
  await page.evaluate(() => {
    const { app, model } = window.mvStudio
    const project = app.project.editor.getProject()
    const clips = Object.values(project.clips) as { id: string; type: string }[]
    const look = clips.find((c) => c.type === 'adjustment')!
    const copy = <T>(o: T): T => JSON.parse(JSON.stringify(o))
    const hits = model.createTrack('visual', 'Hits')
    const hit = { ...copy(look), id: 'e2e-hit', trackId: hits.id, start: 70.5, duration: 0.75, meta: {} }
    const scene = {
      ...copy(project.clips['o-spec2']),
      id: 'e2e-scene',
      trackId: hits.id,
      generatorId: 'generator.nebula',
      params: {},
      start: 64,
      duration: 32,
    }
    delete (hit as { name?: string }).name
    delete (scene as { name?: string }).name
    const sections = project.analysis.audio[project.songAssetId].sections as {
      id: string
      start: number
      end: number
    }[]
    const pre = sections.find((s) => s.start <= 48.5 && s.end > 48.5)!
    app.project.dispatch([
      { type: 'track.add', track: hits, index: 0 },
      { type: 'clip.add', clip: hit },
      { type: 'clip.add', clip: scene },
      { type: 'clip.trim', clipId: 'o-spec1', start: 0, duration: project.duration },
      { type: 'clip.trim', clipId: look.id, start: 10.5, duration: 29.7 },
      {
        type: 'analysis.updateSection',
        assetId: project.songAssetId,
        sectionId: pre.id,
        patch: { label: 'Final chorus (key change)', confidence: 1 },
      },
    ])
  })

  const cases: [string, string, number][] = [
    ['#/editor?sel=clip:e2e-hit&t=71', 'Adjustment layer · 1:10.50 – 1:11.25 · 0.8 s', 2],
    ['#/editor?sel=clip:e2e-scene&t=70', 'Background · 1:04.00 – 1:36.00 · 32.0 s', 2],
    ['#/editor?sel=lyric:l-pre-1&t=50', 'Final chorus (key change) · 0:48.50 – 0:51.80 · 3.3 s', 2],
    ['#/editor?sel=clip:o-title&t=3', 'Text · 0:01.00 – 0:09.00 · 8.0 s', 1],
  ]
  for (const [hash, text, lines] of cases) {
    await show(page, hash)
    await expect(meta(page)).toHaveText(text)
    expect(await fit(page), text).toEqual({ cut: false, lines })
  }
  await show(page, '#/editor?sel=clip:o-spec1&t=70')
  await expect(meta(page)).toHaveText('Visualizer · 0:00.00 – 3:24.00 · 204.0 s')
  expect((await fit(page)).cut).toBe(false)

  // The project's look card shows the same span beside its thumbnail and Change button.
  await page.evaluate(() => window.mvStudio.app.ui.set({ selection: { type: 'none' } }))
  const card = page
    .getByRole('tabpanel', { name: 'Inspector' })
    .locator('[class*="lookText"] [class*="meta"]')
    .first()
  await expect(card).toHaveText('0:10.50 – 0:40.20 · 29.7 s')
  expect(
    await card.evaluate((m) =>
      [m, ...m.querySelectorAll('[class*="metaPart"]')].some((p) => p.scrollWidth > p.clientWidth),
    ),
  ).toBe(false)
})
