import type { Locator, Page } from '@playwright/test'
import { expect, openApp, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * Layout checks at the smallest supported window, where panels are narrowest, unless a test says otherwise. The
 * persistent-context fixture ignores test.use({ viewport }), so each test sets the size itself.
 */
const small = (page: Page, size = { width: 1280, height: 720 }) => page.setViewportSize(size)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
}

async function openEditor(page: Page, hash = '#/editor?t=73.6', size?: { width: number; height: number }) {
  await small(page, size)
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
}

test('the library’s song card keeps its summary clear of the waveform at 1280', async ({ page }) => {
  await openEditor(page)
  await waitForPreview(page)
  const row = page.locator('[class*="songRow"]')
  await expect(row.getByText(/BPM · \d+ sections/)).toBeVisible()
  const fit = await row.evaluate((el) => {
    const meta = el.querySelector('[class*="songMeta"]')!
    const wave = el.querySelector('[class*="songWave"]')!
    const text = document.createRange()
    text.selectNodeContents(meta)
    return {
      textRight: text.getBoundingClientRect().right,
      waveLeft: wave.getBoundingClientRect().left,
      cut: meta.scrollWidth > meta.clientWidth,
    }
  })
  expect(fit.textRight).toBeLessThanOrEqual(fit.waveLeft)
  expect(fit.cut).toBe(false)
})

test('the timeline tool control shows which tool is on, though each choice has a tooltip', async ({
  page,
}) => {
  await openEditor(page)
  await waitForPreview(page)
  const group = page.getByRole('radiogroup', { name: 'Timeline tool' })
  const select = group.getByRole('radio', { name: 'Select' })
  const split = group.getByRole('radio', { name: /^Split/ })
  const background = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
  await expect(select).toHaveAttribute('aria-checked', 'true')
  const on = await background(select)
  const off = await background(split)
  expect(on).not.toBe(off)
  await split.click()
  await expect(split).toHaveAttribute('aria-checked', 'true')
  await expect(split).toHaveCSS('background-color', on)
  await expect(select).toHaveCSS('background-color', off)
})

test('Settings rows grow with their descriptions instead of spilling over the next row', async ({ page }) => {
  await openEditor(page, '#/editor?dialog=settings&page=local')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByText('CPU threads for AI')).toBeVisible()
  const rows = await dialog.evaluate((el) =>
    [...el.querySelectorAll('[class*="rowText"]')].map((text) => ({
      text: text.textContent?.slice(0, 40),
      spill: text.getBoundingClientRect().height - text.parentElement!.getBoundingClientRect().height,
    })),
  )
  expect(rows.length).toBeGreaterThan(3)
  expect(rows.filter((r) => r.spill > 0)).toEqual([])
})

test('a long toast keeps its Dismiss button full size', async ({ page }) => {
  await openEditor(page)
  await waitForPreview(page)
  await page.evaluate(() => {
    const ui = window.mvStudio.app.ui
    ui.toast(
      'Imported 14 files: 9 clips or images, 3 LUTs, 2 songs. “a-very-long-file-name-from-the-camera-roll-final-v3.mov” could not be read because this browser does not support its codec.',
      { label: 'Show', run: () => {} },
    )
    for (const t of ui.get().toasts) ui.holdToast(t.id)
  })
  // Layout size: the toast's entrance animation scales its box for a moment.
  const size = await page
    .getByRole('button', { name: 'Dismiss' })
    .evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight])
  expect(size).toEqual([24, 24])
})

test('a failed director draft keeps both footer buttons inside the narrow panel', async ({ page }) => {
  await page
    .context()
    .route(/https:\/\/(queue\.)?fal\.run\/.*/, (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers: CORS })
        : route.fulfill({ status: 500, headers: CORS, body: '{}' }),
    )
  await small(page)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem(
      'mv-studio.cloud.v1',
      JSON.stringify({ falKey: 'key-id:key-secret', alwaysConfirmPaid: true }),
    )
  })
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => (window.location.hash = '#/editor?kind=ai&tab=assist&assist=director'))
  await page.getByRole('radio', { name: 'Mix' }).click()
  await page.getByRole('button', { name: 'Draft video' }).click()
  await page.getByRole('button', { name: /^Generate \d+ shots? · about \$\d+\.\d\d$/ }).click()
  const dialog = page.getByRole('dialog', { name: /^Generate \d+ shots?\?$/ })
  await dialog.getByRole('button', { name: /^Generate \d+ shots? · about/ }).click()
  const retry = page.getByRole('button', { name: /^Retry · about \$\d+\.\d\d$/ })
  await expect(retry).toBeVisible({ timeout: 30_000 })
  const panel = (await page.getByRole('tabpanel', { name: 'Assist' }).boundingBox())!
  for (const button of [page.getByRole('button', { name: 'Back to the plan' }), retry]) {
    const box = (await button.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(panel.x)
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width)
  }
})

test('an empty project’s drop hint reaches the right edge of a wide timeline', async ({ page }) => {
  await openEditor(page, '#/editor?project=empty&kind=blank', { width: 1920, height: 1080 })
  await expect(page.getByText('Drop your song here')).toBeVisible()
  const gap = await page.evaluate(() => {
    const scroller = document.querySelector('[data-timeline-scroller]')!
    const hint = document.querySelector('[class*="dropHint"]')!
    return scroller.getBoundingClientRect().right - hint.getBoundingClientRect().right
  })
  expect(gap).toBeLessThanOrEqual(24)
})

test('a long context menu fills the window’s height before it scrolls', async ({ page }) => {
  await small(page)
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/vj?t=60'
  })
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  await page.getByRole('button', { name: 'Rain on glass', exact: true }).click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  // Layout sizes: the menu's entrance animation scales its box for a moment.
  const fit = await menu.evaluate((el: HTMLElement) => ({
    scrolls: el.scrollHeight > el.clientHeight,
    height: el.offsetHeight,
    bottom: el.parentElement!.getBoundingClientRect().top + el.offsetHeight,
  }))
  // The 24 items are taller than the window, so the menu takes its height less 8 px margins and scrolls the rest.
  expect(fit.scrolls).toBe(true)
  expect(fit.height).toBeGreaterThanOrEqual(720 - 2 * 8 - 1)
  expect(fit.bottom).toBeLessThanOrEqual(720 - 8)
})
