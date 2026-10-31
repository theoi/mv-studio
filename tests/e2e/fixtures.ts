import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test'

/**
 * Tests run in a persistent (on-disk) profile. Playwright's default contexts keep OPFS/IndexedDB in memory with a
 * much lower real quota, which the runtime pilot found makes 200 MB media writes fail.
 */
export async function launchProfile(dir: string, baseURL: string | undefined): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, {
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
  return context
}

export const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({ baseURL }, use, testInfo) => {
    const context = await launchProfile(testInfo.outputPath('profile'), baseURL)
    await use(context)
    await context.close()
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()))
  },
})

export const expect = test.expect

/** E2E_PREVIEW_WORKER=0 (or 1) runs the suite with previews drawn on the main thread (or in the render worker). */
function withPreviewSetting(path: string): string {
  const value = process.env.E2E_PREVIEW_WORKER
  if (value !== '0' && value !== '1') return path
  const [base = '', hash] = path.split('#')
  const query = `${base}${base.includes('?') ? '&' : '?'}preview-worker=${value}`
  return hash === undefined ? query : `${query}#${hash}`
}

/**
 * Opens the app and waits for cross-origin isolation. On a fresh profile the service worker registers and reloads
 * the page once, so poll across that navigation instead of using a single evaluate.
 */
export async function openApp(page: Page, path = './', timeoutMs = 20_000): Promise<void> {
  await page.goto(withPreviewSetting(path))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await page.evaluate(() => window.crossOriginIsolated)) break
    } catch {
      // Execution context destroyed by the service worker's reload; try again.
    }
    if (Date.now() > deadline) {
      const worker = await page
        .evaluate(async () => {
          const registration = await navigator.serviceWorker?.getRegistration()
          return {
            url: location.href,
            controller: navigator.serviceWorker?.controller?.state ?? null,
            active: registration?.active?.state ?? null,
            installing: registration?.installing?.state ?? null,
          }
        })
        .catch((error: unknown) => String(error))
      throw new Error(`Page did not become cross-origin isolated: ${JSON.stringify(worker)}`)
    }
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

/** Waits until the editor is open and its preview has drawn the first frame. */
export async function waitForPreview(page: Page): Promise<void> {
  await expect(page.getByRole('img', { name: 'Video preview' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
}
