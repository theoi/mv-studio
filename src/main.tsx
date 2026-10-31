import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import './app/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (new URLSearchParams(location.search).has('e2e')) {
  void import('./testing/harness.ts').then((m) => m.installHarness())
}
