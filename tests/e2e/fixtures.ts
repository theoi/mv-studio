import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test'

/**
 * Tests run in a persistent (on-disk) profile. Playwright's default contexts keep OPFS/IndexedDB in memory with a
 * much lower real quota, which the runtime pilot found makes 200 MB media writes fail.
 */
export const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({ baseURL }, use, testInfo) => {
    const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
      headless: true,
      baseURL,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      // page.evaluate is not a user gesture, so playback tests could not start an AudioContext otherwise.
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
    // Desktop Chrome and Edge define window.chrome; headless Chromium does not. Code that sniffs it (upstream
    // coi-serviceworker picks require-corp when it exists) must see what real users' browsers expose.
    await context.addInitScript(() => {
      if (!('chrome' in window)) Object.defineProperty(window, 'chrome', { value: {}, configurable: true })
    })
    await use(context)
    await context.close()
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()))
  },
})

export const expect = test.expect

/**
 * Opens the app and waits for cross-origin isolation. On a fresh profile the service worker registers and reloads
 * the page once, so poll across that navigation instead of using a single evaluate.
 */
export async function openApp(page: Page, path = './', timeoutMs = 20_000): Promise<void> {
  await page.goto(path)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await page.evaluate(() => window.crossOriginIsolated)) break
    } catch {
      // Execution context destroyed by the service worker's reload; try again.
    }
    if (Date.now() > deadline) throw new Error('Page did not become cross-origin isolated')
    await page.waitForTimeout(200)
  }
  await page.waitForLoadState('domcontentloaded')
}

declare global {
  interface Window {
    // The harness exposes untyped engine modules to page.evaluate callbacks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mvStudio: any
  }
}

/** Opens the app with the e2e harness (window.mvStudio) installed. */
export async function openHarness(page: Page): Promise<void> {
  await openApp(page, './?e2e=1')
  await page.waitForFunction(() => window.mvStudio?.ready === true)
}
