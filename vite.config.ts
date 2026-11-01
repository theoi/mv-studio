import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { thirdPartyLicenses } from './scripts/third-party-licenses.ts'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

// GitHub Pages serves the app from https://theoi.github.io/mv-studio/.
const base = '/mv-studio/'
const licenses = thirdPartyLicenses(version)
// Tell an open tab that a newer build was deployed (src/shared/update.ts).
const buildTime = Date.now()
const buildId = process.env.GITHUB_SHA ?? `local-${buildTime.toString(36)}`

/**
 * Writes version.json: the build's id and time, and the files under assets/ it loads (without source maps), which the
 * next deploy keeps so that tabs still running this build can load them (scripts/keep-previous-assets.ts).
 */
function versionFile(): Plugin {
  let outDir = 'dist'
  return {
    name: 'mv-studio-version',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    writeBundle() {
      const assets = readdirSync(path.join(outDir, 'assets'))
        .filter((file) => !file.endsWith('.map'))
        .sort()
        .map((file) => `assets/${file}`)
      writeFileSync(
        path.join(outDir, 'version.json'),
        JSON.stringify({ build: buildId, time: buildTime, assets }),
      )
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), licenses.plugin, versionFile()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
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
