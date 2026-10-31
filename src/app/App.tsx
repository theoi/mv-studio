import { useEffect, useState } from 'react'
import { detectCapabilities, type RuntimeCapabilities } from '../shared/capabilities.ts'

// Placeholder shell. The design and app shell area replaces this screen.
export function App() {
  const [caps, setCaps] = useState<RuntimeCapabilities | null>(null)

  useEffect(() => {
    let cancelled = false
    void detectCapabilities().then((c) => {
      if (!cancelled) setCaps(c)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="placeholder">
      <h1>MV Studio</h1>
      <p>Turn a song into a music video, right in your browser. The studio is under construction.</p>
      <dl className="caps" data-testid="capabilities">
        <dt>Cross-origin isolated</dt>
        <dd data-testid="cap-isolated">{caps ? String(caps.crossOriginIsolated) : '…'}</dd>
        <dt>WASM threads</dt>
        <dd data-testid="cap-threads">{caps ? caps.wasmThreads : '…'}</dd>
        <dt>WebCodecs</dt>
        <dd data-testid="cap-webcodecs">{caps ? String(caps.webCodecs) : '…'}</dd>
        <dt>WebGPU</dt>
        <dd data-testid="cap-webgpu">{caps ? String(caps.webgpu.available) : '…'}</dd>
      </dl>
    </main>
  )
}
