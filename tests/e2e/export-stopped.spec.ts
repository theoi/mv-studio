import type { BrowserContext, Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const STOPPED = 'didn’t finish. The browser may have run out of memory.'
const LOWER_RESOLUTION =
  'The last export didn’t finish. The browser may have run out of memory. Try a lower resolution.'
const CLOSE_TABS =
  'The last export didn’t finish. The browser may have run out of memory. Close other tabs and try again.'
/** Longer than a toast that isn't sticky stays (TOAST_MS in src/app/state/ui.ts). */
const PAST_A_TOAST_MS = 6000

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

/** Renames the open project, which keeps it in this browser, and waits until it is saved. */
async function keepAs(page: Page, current: string, name: string): Promise<void> {
  await page.getByRole('button', { name: `Project: ${current}` }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const field = page.getByRole('textbox', { name: 'Project name' })
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('button', { name: `Project: ${name}` })).toBeVisible()
  await expect(page.getByRole('banner').getByText('Saved', { exact: true })).toBeVisible()
}

/** Exports the Full video alone at `resolution` (opening the Export dialog unless it is open), until under way. */
async function startExport(page: Page, resolution: '720p' | '1080p') {
  const dialog = page.getByRole('dialog', { name: 'Export' })
  if (!(await dialog.isVisible())) await page.keyboard.press(`${mod}+e`)
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
 * Records each stopped-export toast a page of the context shows, however briefly: a page busy beside an export can
 * take longer to show its preview than a toast stays.
 */
async function recordStopped(context: BrowserContext): Promise<void> {
  await context.addInitScript((stopped) => {
    const w = window as { stoppedSeen?: number }
    w.stoppedSeen = 0
    new MutationObserver((mutations) => {
      for (const m of mutations)
        for (const node of m.addedNodes)
          if (node instanceof Element && node.closest('[data-toast]') && node.textContent?.includes(stopped))
            w.stoppedSeen!++
    }).observe(document, { childList: true, subtree: true })
  }, STOPPED)
}

/** How many stopped-export toasts the page showed, once the app had the time to show one. */
async function stoppedCount(page: Page): Promise<number> {
  await page.waitForTimeout(1000)
  return page.evaluate(() => (window as { stoppedSeen?: number }).stoppedSeen ?? 0)
}

test('reopened into Export, the dialog says the export didn’t finish until the next one starts; elsewhere a toast stays', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000)
  await recordStopped(context)
  await openEditor(page)
  await keepAs(page, 'Neon Skyline', 'Night drive')
  await startExport(page, '1080p')
  const url = relative(page)
  expect(url).toContain('export=exporting')

  // The link to the export in progress opens its setup, as before, which says what happened, next to Resolution.
  let next = await crash(page)
  await openApp(next, url)
  let dialog = next.getByRole('dialog', { name: 'Export' })
  const note = dialog.getByRole('alert')
  await expect(note).toHaveText(LOWER_RESOLUTION)
  await next.waitForTimeout(PAST_A_TOAST_MS)
  await expect(note).toHaveText(LOWER_RESOLUTION)
  expect(await stoppedCount(next)).toBe(0)

  // Said once: not after a reload.
  await next.reload()
  await expect(dialog.getByRole('button', { name: /^Export \d+ files?$/ })).toBeVisible()
  await expect(note).toBeHidden()
  expect(await stoppedCount(next)).toBe(0)

  // The next export takes its place; at 720p a lower resolution is no advice.
  await startExport(next, '720p')
  next = await crash(next)
  // The app reopens the last project in the editor, without the dialog: a toast says it until dismissed.
  await openEditor(next)
  const shown = next.locator('[data-toast]').filter({ hasText: CLOSE_TABS })
  await expect(shown).toBeVisible()
  await next.waitForTimeout(PAST_A_TOAST_MS)
  await expect(shown).toBeVisible()
  // The project's Export dialog says it from then on.
  await next.keyboard.press(`${mod}+e`)
  dialog = next.getByRole('dialog', { name: 'Export' })
  await expect(dialog.getByRole('alert')).toHaveText(CLOSE_TABS)
  await expect(shown).toBeHidden()
})

test('on the start screen, the toast names the project whose export didn’t finish and opens it in Export', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await recordStopped(context)
  await openEditor(page)
  await keepAs(page, 'Neon Skyline', 'Night drive')
  await startExport(page, '1080p')

  const next = await crash(page)
  await openApp(next, './#/start')
  const shown = next.locator('[data-toast]').filter({
    hasText:
      'The export of “Night drive” didn’t finish. The browser may have run out of memory. Try a lower resolution.',
  })
  await expect(shown).toBeVisible()
  await next.waitForTimeout(PAST_A_TOAST_MS)
  await shown.getByRole('button', { name: 'Open' }).click()
  await expect(next.getByRole('dialog', { name: 'Export' }).getByRole('alert')).toHaveText(LOWER_RESOLUTION)
  await expect(shown).toBeHidden()
  await next.keyboard.press('Escape')
  await expect(next.getByRole('button', { name: 'Project: Night drive' })).toBeVisible()
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
  await expect(next.getByRole('dialog', { name: 'Export' }).getByRole('alert')).toBeHidden()
})
