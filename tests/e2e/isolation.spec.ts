import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures.ts'

/**
 * First visits on a fresh profile: public/coi-serviceworker.js registers the worker and reloads the page through it.
 * These tests slow the worker's install and the page's copy of the script to reproduce timings seen on busy CI
 * machines.
 */

const isolated = (page: Page) => page.evaluate(() => window.crossOriginIsolated).catch(() => false)

/** Main-frame navigations and coi console messages, for assertions and failure messages. */
function watch(page: Page) {
  const navigations: string[] = []
  const messages: string[] = []
  page.on('framenavigated', (f) => f === page.mainFrame() && navigations.push(f.url()))
  page.on('console', (m) => /COOP\/COEP/.test(m.text()) && messages.push(m.text()))
  return { navigations, messages }
}

/** Serves the worker with an install step that takes `ms`, as on a busy machine. */
async function slowInstall(route: Route, ms: number) {
  const response = await route.fetch()
  const body = await response.text()
  await route.fulfill({
    response,
    body: `self.addEventListener('install', (e) => e.waitUntil(new Promise((r) => setTimeout(r, ${ms}))));\n${body}`,
  })
}

const isWorkerScript = async (route: Route) =>
  (await route.request().headerValue('service-worker')) === 'script'

test('a first visit reloads once through the service worker and is cross-origin isolated', async ({
  page,
}) => {
  const seen = watch(page)
  await page.goto('./')
  await expect.poll(() => isolated(page), { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(500)
  expect(seen.navigations, seen.messages.join('\n')).toHaveLength(2)
  expect(await isolated(page)).toBe(true)
})

test('a reload while the worker installs still ends isolated when the worker claims the page before its script runs', async ({
  page,
}) => {
  const seen = watch(page)
  let pageScripts = 0
  await page.context().route('**/coi-serviceworker.js', async (route) => {
    if (await isWorkerScript(route)) return slowInstall(route, 500)
    pageScripts++
    // The reloaded document's copy of the script arrives after the worker activated and claimed that document, so
    // its controllerchange fired before the script could listen for it.
    if (pageScripts === 2) await new Promise((r) => setTimeout(r, 1200))
    await route.continue()
  })
  await page.goto('./')
  // The user reloads during the first visit, while the worker is still installing.
  await expect
    .poll(() => seen.messages.some((m) => m.startsWith('COOP/COEP Service Worker registered')))
    .toBe(true)
  await page.evaluate(() => location.reload()).catch(() => undefined)
  await expect.poll(() => isolated(page), { timeout: 10_000, message: seen.messages.join('\n') }).toBe(true)
  expect(seen.messages).toContain(
    'Reloading page to make use of COOP/COEP Service Worker (controlled without isolation).',
  )
})

test('a browser that cannot be isolated stops reloading after three attempts', async ({ page }) => {
  const seen = watch(page)
  await page.addInitScript(() => Object.defineProperty(window, 'crossOriginIsolated', { get: () => false }))
  await page.goto('./')
  await expect
    .poll(() => seen.messages.some((m) => m.includes('not reloading again')), { timeout: 10_000 })
    .toBe(true)
  const navigations = seen.navigations.length
  await page.waitForTimeout(1000)
  expect(seen.navigations).toHaveLength(navigations)
  expect(navigations).toBe(4)
})
