import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// GitHub Pages serves the app from https://theoi.github.io/mv-studio/.
const base = '/mv-studio/'

export default defineConfig({
  base,
  plugins: [react()],
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
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
})
