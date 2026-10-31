import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import './app/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

const params = new URLSearchParams(location.search)
// ?bench=1 replaces the app with the performance benchmark page (src/testing/benchPage.ts).
if (params.has('bench')) {
  void import('./testing/benchPage.ts').then((m) => m.mountBenchPage(root))
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

if (params.has('e2e')) {
  void import('./testing/harness.ts').then((m) => m.installHarness())
}
