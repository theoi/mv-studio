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
