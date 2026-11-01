import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const UPDATED = 'MV Studio was updated. Reload to continue; your project is saved.'
const VERSION = /\/mv-studio\/version\.json$/
const ANALYSIS_WORKER = /\/assets\/analysis\.worker-[^/]+\.js$/
const EXPORT_CODE = /\/assets\/ExportDialog-[^/]+\.js$/

/**
 * Serves version.json as GitHub Pages does across a deploy: this build's (from dist/) until `deployed` is set, then
 * that of a build deployed later. Counts the requests for it.
 */
async function serveVersion(page: Page): Promise<{ deployed: boolean; requests: number }> {
  const site = { deployed: false, requests: 0 }
  await page.context().route(VERSION, (route) => {
    site.requests++
    return site.deployed
      ? route.fulfill({ json: { build: 'a build deployed later', assets: [] } })
      : route.continue()
  })
  return site
}

/** Makes the code at `blocked` fail to load, as the old build's files do once a deploy replaced them. */
async function block(page: Page, blocked: RegExp): Promise<void> {
  await page.context().route(blocked, (route) => route.abort())
}

async function openEditor(page: Page, hash: string, site: { requests: number }): Promise<void> {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    // Saves wait 5 s after the last change, so an edit is still unsaved when Reload is pressed.
    localStorage.setItem('mv-studio.prefs', JSON.stringify({ autosaveSeconds: 30 }))
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
  // The tab comes back to the front: the app reads the deployed build, so its next check waits five minutes unless
  // something fails.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => site.requests).toBeGreaterThan(0)
}

async function renameOpenProject(page: Page, current: string, name: string): Promise<void> {
  await page.getByRole('button', { name: `Project: ${current}` }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const field = page.getByRole('textbox', { name: 'Project name' })
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('button', { name: `Project: ${name}` })).toBeVisible()
}

test('a task whose worker can’t load after a deploy offers a reload, which keeps the edit not saved yet', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const site = await serveVersion(page)
  await block(page, ANALYSIS_WORKER)
  await openEditor(page, '#/editor?tab=assist&assist=analysis&t=73.6', site)
  site.deployed = true

  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  await panel.getByRole('button', { name: 'Analyze again' }).click()
  await expect(panel.getByRole('alert')).toContainText('The task stopped unexpectedly')
  const toasts = page.getByRole('status')
  await expect(toasts.getByText(UPDATED)).toBeVisible()

  await renameOpenProject(page, 'Neon Skyline', 'Night drive')
  expect(
    await page.evaluate(() => window.mvStudio.app.persistence.usePersistence.getState().status as string),
  ).toBe('pending')
  // The reloaded tab runs the deployed build. The rename comes back only if Reload saved it first: a page that is
  // leaving has no time to finish a save.
  await page.context().unroute(VERSION)
  await Promise.all([page.waitForEvent('load'), toasts.getByRole('button', { name: 'Reload' }).click()])
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await expect(page.getByRole('button', { name: 'Project: Night drive' })).toBeVisible()
  await expect(page.getByText(UPDATED)).toBeHidden()
})

test('a screen whose code can’t load offers a reload once a newer build is deployed, and the offer stays', async ({
  page,
}) => {
  const site = await serveVersion(page)
  await block(page, EXPORT_CODE)
  await openEditor(page, '#/editor?t=60', site)
  const failed = page.getByText('Export couldn’t load. Check your connection and try again.')
  const updated = page.getByRole('status').getByText(UPDATED)

  // Offline, say: the deployed build is still this one, so there is nothing to reload into.
  let before = site.requests
  await page.keyboard.press(`${mod}+e`)
  await expect(failed).toBeVisible()
  await expect.poll(() => site.requests).toBe(before + 1)
  // Counted once the check was answered: a waiting assertion would pass before the toast appeared.
  await page.waitForTimeout(500)
  expect(await updated.count()).toBe(0)

  site.deployed = true
  before = site.requests
  await page.keyboard.press(`${mod}+e`)
  await expect(updated).toBeVisible()
  expect(site.requests).toBe(before + 1)
  // Other toasts leave after a few seconds; this one stays until it is dismissed or used.
  await expect(failed).toBeHidden({ timeout: 10_000 })
  await expect(updated).toBeVisible()
})
