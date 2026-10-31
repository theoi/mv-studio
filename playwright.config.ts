import { defineConfig } from '@playwright/test'

// E2E_BASE_URL runs the suite against a deployed site (e.g. the live GitHub Pages URL) instead of `vite preview`.
const external = process.env.E2E_BASE_URL
const baseURL = external ?? 'http://127.0.0.1:4173/mv-studio/'

// CI runs the suite as two halves on separate machines: E2E_HALF=1 runs these slow specs (about half the time),
// E2E_HALF=2 everything else, so a new spec always runs in one of them.
const FIRST_HALF =
  /\/(perf|export-dialog|editor-engine|worker-crash|director-app|vj-screen|analysis-app|stems-app|ask)\.spec\.ts$/
const half = process.env.E2E_HALF

export default defineConfig({
  testDir: 'tests/e2e',
  ...(half === '1' && { testMatch: FIRST_HALF }),
  ...(half === '2' && { testIgnore: FIRST_HALF }),
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: external
    ? undefined
    : {
        // Serves the production build with no special headers, like GitHub Pages. Run `npm run build` first.
        command: 'npm run preview',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
