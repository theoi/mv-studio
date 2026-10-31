import { defineConfig } from '@playwright/test'

// Developer tools that run in the browser but are not tests: thumbnail generation, contact sheets and benchmarks.
// Run with `npx playwright test -c playwright.tools.config.ts <file>` after `npm run build`.
export default defineConfig({
  testDir: 'tests/tools',
  timeout: 600_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173/mv-studio/' },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173/mv-studio/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
