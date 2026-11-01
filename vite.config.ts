import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { thirdPartyLicenses } from './scripts/third-party-licenses.ts'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

// GitHub Pages serves the app from https://theoi.github.io/mv-studio/.
const base = '/mv-studio/'
const licenses = thirdPartyLicenses(version)

export default defineConfig({
  base,
  plugins: [react(), licenses.plugin],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    // The dev server can send isolation headers itself; GitHub Pages cannot, which is what
    // public/coi-serviceworker.js is for. `vite preview` deliberately sends no headers so e2e
    // tests exercise the service-worker path exactly as Pages does.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    // preview.headers defaults to server.headers; keep it header-less like GitHub Pages.
    headers: {},
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
  worker: {
    format: 'es',
    plugins: () => [licenses.workerPlugin()],
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Model and DSP tests are pure computation that runs several times slower on a loaded 2-4 core runner, where
    // the 5 s default failed them; a real hang still fails at 15 s.
    testTimeout: 15_000,
  },
})
