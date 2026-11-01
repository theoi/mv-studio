import type { BrowserContext, Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const STOPPED = 'The last export stopped unexpectedly'
const LOWER_RESOLUTION =
  'The last export stopped unexpectedly, maybe because the browser ran out of memory. Try a lower resolution.'
const CLOSE_TABS =
  'The last export stopped unexpectedly, maybe because the browser ran out of memory. Close other tabs and try again.'

/** The app's address relative to the base URL, to open it again as a reload would. */
function relative(page: Page): string {
  const url = page.url()
  return `./${url.slice(url.indexOf('/mv-studio/') + '/mv-studio/'.length)}`
}

async function openEditor(page: Page, path = './'): Promise<void> {
  await openApp(page, path)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    if (!window.location.hash.startsWith('#/editor')) window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
}

/** Exports the Full video alone at `resolution`, and waits until it is under way. */
async function startExport(page: Page, resolution: '720p' | '1080p') {
  await page.keyboard.press(`${mod}+e`)
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await dialog.getByRole('radio', { name: resolution }).click()
  // The project keeps its outputs: Vertical is gone after the first export without it.
  const vertical = dialog.getByLabel('Include Vertical')
  if (await vertical.count()) await vertical.uncheck()
  await dialog.getByRole('button', { name: 'Export 1 file' }).click()
  await expect(dialog.getByText('Exporting 1 file')).toBeVisible()
  return dialog
}

/** Crashes the tab's renderer, as the browser does when it runs out of memory, and opens a new tab. */
async function crash(page: Page): Promise<Page> {
  const cdp = await page.context().newCDPSession(page)
  const crashed = page.waitForEvent('crash')
  // Never answers: the renderer is gone.
  void cdp.send('Page.crash').catch(() => undefined)
  await crashed
  return page.context().newPage()
}

/**
 * Records each stopped-export message a page of the context shows, however briefly: a page busy beside an export can
 * take longer to show its preview than the toast stays.
 */
async function recordStopped(context: BrowserContext): Promise<void> {
  await context.addInitScript((stopped) => {
    const w = window as { stoppedSeen?: number }
    w.stoppedSeen = 0
    new MutationObserver((mutations) => {
      for (const m of mutations)
        for (const node of m.addedNodes) if (node.textContent?.includes(stopped)) w.stoppedSeen!++
    }).observe(document, { childList: true, subtree: true })
  }, STOPPED)
}

/** How many stopped-export messages the page showed, once the app had the time to show one. */
async function stoppedCount(page: Page): Promise<number> {
  await page.waitForTimeout(1000)
  return page.evaluate(() => (window as { stoppedSeen?: number }).stoppedSeen ?? 0)
}

test('after a tab died during an export, the next visit says the export stopped, once, with what may help', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await recordStopped(context)
  await openEditor(page)
  await startExport(page, '1080p')
  const url = relative(page)
  expect(url).toContain('export=exporting')

  let next = await crash(page)
  await openApp(next, url)
  await expect(next.getByText(LOWER_RESOLUTION)).toBeVisible()
  // The link to the export in progress opens its setup, as before.
  await expect(
    next.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: /^Export \d+ files?$/ }),
  ).toBeVisible()
  await next.keyboard.press('Escape')
  await waitForPreview(next)

  await next.reload()
  await waitForPreview(next)
  expect(await stoppedCount(next)).toBe(0)

  // At 720p a lower resolution is no advice.
  await startExport(next, '720p')
  next = await crash(next)
  await openEditor(next)
  await expect(next.getByRole('status').getByText(CLOSE_TABS)).toBeVisible()
})

test('an export that ended, a reload on purpose, or an export in another tab is not taken for one that stopped', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await recordStopped(context)
  await openEditor(page)
  const dialog = await startExport(page, '1080p')

  // Another tab while this one exports.
  const other = await context.newPage()
  await openEditor(other)
  expect(await stoppedCount(other)).toBe(0)
  await other.close()

  await dialog.getByRole('button', { name: 'Cancel all' }).click()
  await expect(page.getByText('Export cancelled. Nothing was saved.')).toBeVisible()
  const next = await crash(page)
  await openEditor(next)
  expect(await stoppedCount(next)).toBe(0)

  await startExport(next, '1080p')
  await next.reload()
  await expect(
    next.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export 1 file' }),
  ).toBeVisible()
  expect(await stoppedCount(next)).toBe(0)
})
