import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// E2E_BASE_URL runs the suite against a deployed site (e.g. the live GitHub Pages URL) instead of `vite preview`.
const external = process.env.E2E_BASE_URL
const baseURL = external ?? 'http://127.0.0.1:4173/mv-studio/'

/**
 * CI runs the suite as two halves on separate machines: E2E_HALF=1 runs the spec files firstHalfSpecs() picks,
 * E2E_HALF=2 everything else, so every spec runs in one of them. Specs are dealt out longest first, each to the half
 * with less time so far, by the seconds tests/e2e/timings.json records for them (`node scripts/e2e-timings.mjs <CI run
 * id>` refreshes it). A spec missing from it counts as a typical one, so new specs spread over both halves.
 */
export function firstHalfSpecs(timings: Record<string, unknown>, specs: string[]): string[] {
  const valid = (s: unknown): s is number => typeof s === 'number' && Number.isFinite(s) && s >= 0
  const known = Object.values(timings)
    .filter(valid)
    .filter((s) => s > 0)
    .sort((a, b) => a - b)
  const typical = known[Math.floor(known.length / 2)] ?? 1
  const seconds = (spec: string) => {
    const s = timings[spec]
    return valid(s) ? s : typical
  }
  // Ties go by code point: localeCompare follows the machine's locale, so two machines could deal them differently.
  const order = [...specs].sort((a, b) => seconds(b) - seconds(a) || (a < b ? -1 : 1))
  const load = [0, 0]
  const first: string[] = []
  for (const spec of order) {
    const i = load[0] <= load[1] ? 0 : 1
    load[i] += seconds(spec)
    if (i === 0) first.push(spec)
  }
  return first
}

function firstHalf(): RegExp {
  const dir = new URL('tests/e2e/', import.meta.url)
  const timings = JSON.parse(readFileSync(new URL('timings.json', dir), 'utf8')) as Record<string, unknown>
  const specs = readdirSync(dir).filter((f) => f.endsWith('.spec.ts'))
  return new RegExp(
    `/(${firstHalfSpecs(timings, specs)
      .map((f) => f.replaceAll('.', '\\.'))
      .join('|')})$`,
  )
}
const half = process.env.E2E_HALF

export default defineConfig({
  testDir: 'tests/e2e',
  ...(half === '1' && { testMatch: firstHalf() }),
  ...(half === '2' && { testIgnore: firstHalf() }),
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
