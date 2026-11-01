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
