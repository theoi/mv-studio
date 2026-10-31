import { defineConfig } from '@playwright/test'

// E2E_BASE_URL runs the suite against a deployed site (e.g. the live GitHub Pages URL) instead of `vite preview`.
const external = process.env.E2E_BASE_URL
const baseURL = external ?? 'http://127.0.0.1:4173/mv-studio/'

export default defineConfig({
  testDir: 'tests/e2e',
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
