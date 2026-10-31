/**
 * Benchmark page (open the app with ?bench=1): generates media in the browser, plays a typical and a heavy project at
 * several preview sizes and qualities, exports a few seconds of each, and prints frame rates, frame-time percentiles
 * and main-thread responsiveness. Copy the JSON at the bottom to share results.
 */
import { mediaStore } from '../media/mediaStore.ts'
import type { PreviewQuality } from '../engine/preview.ts'
import {
  cutProject,
  measureCuts,
  runExportBenchmark,
  runPreviewBenchmark,
  type BenchAssets,
  type BenchRow,
  type BenchScenario,
  type ExportBenchResult,
} from './bench.ts'
import { syntheticSong, syntheticVideo } from './syntheticMedia.ts'

const QUALITIES: PreviewQuality[] = ['full', 'half', 'quarter', 'auto']
const SIZES: [number, number][] = [
  [960, 540],
  [1280, 720],
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', style = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.textContent = text
  if (style) node.style.cssText = style
  return node
}

function gpuName(): string {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return 'WebGL2 unavailable'
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
}

async function makeAssets(status: (s: string) => void): Promise<BenchAssets> {
  status('Generating a song…')
  const song = await mediaStore.storeBlob(syntheticSong(8), {
    kind: 'audio',
    name: 'bench-song.wav',
    origin: { type: 'generated' },
  })
  const video = async (w: number, h: number, name: string) => {
    const blob = await syntheticVideo(w, h, 4, 30, (f) => status(`Encoding ${name}… ${Math.round(f * 100)}%`))
    return mediaStore.storeBlob(blob, { kind: 'video', name, origin: { type: 'generated' } })
  }
  const hd = await video(1920, 1080, 'bench-1080p.mp4')
  const sd = await video(640, 360, 'bench-360p.mp4')
  return { song, hd, sd }
}

const ROW_HEADERS = [
  'project',
  'viewport',
  'quality',
  'canvas',
  'scale',
  'fps',
  'frame p50 / p95 / p99 ms',
  'dropped',
  'input delay p95 ms',
  'drag fps',
  'edit→frame p95 ms',
  'scrub fps',
]

function rowCells(r: BenchRow): string[] {
  const p = r.playing
  return [
    r.project,
    r.viewport,
    r.quality,
    p.canvas.join('×'),
    String(p.scale),
    String(p.fps),
    `${p.frameP50Ms} / ${p.frameP95Ms} / ${p.frameP99Ms}`,
    String(p.dropped),
    String(p.main.inputDelayP95Ms),
    r.dragging ? String(r.dragging.fps) : '',
    r.dragging?.edits ? String(r.dragging.edits.responseP95Ms) : '',
    r.scrubbing ? String(r.scrubbing.fps) : '',
  ]
}

export function mountBenchPage(root: HTMLElement): void {
  root.replaceChildren()
  const page = el(
    'div',
    '',
    'font: 14px/1.4 system-ui, sans-serif; padding: 16px; color: #ddd; background: #111;',
  )
  document.body.style.margin = '0'
  document.body.style.background = '#111'
  page.append(el('h1', 'MV Studio benchmark', 'font-size: 20px; margin: 0 0 8px'))
  const dpr = globalThis.devicePixelRatio || 1
  page.append(
    el('div', `GPU: ${gpuName()} · devicePixelRatio ${dpr} · ${navigator.userAgent}`, 'opacity: 0.7'),
  )
  page.append(
    el(
      'p',
      'Plays a typical and a heavy project at 960×540 and 1280×720 (times your device pixel ratio) with each preview ' +
        'quality, measures stalls at cuts in a beat-cut edit, then exports 4 seconds of each project at 1080p. Takes ' +
        'about three minutes; keep this tab in front.',
    ),
  )
  const run = el('button', 'Run benchmark', 'font-size: 14px; padding: 6px 14px;')
  const status = el('div', '', 'margin: 8px 0; min-height: 1.4em;')
  const stage = el('div', '', 'margin: 8px 0;')
  const table = el(
    'table',
    '',
    'border-collapse: collapse; font-variant-numeric: tabular-nums; margin-top: 8px;',
  )
  const head = el('tr')
  for (const h of ROW_HEADERS) head.append(el('th', h, 'text-align: left; padding: 2px 10px 2px 0;'))
  table.append(head)
  const exports = el('div', '', 'margin-top: 12px;')
  const json = el('pre', '', 'white-space: pre-wrap; font-size: 12px; opacity: 0.8;')
  page.append(run, status, stage, table, exports, json)
  root.append(page)

  const start = async () => {
    run.disabled = true
    const setStatus = (s: string) => (status.textContent = s)
    try {
      const assets = await makeAssets(setStatus)
      const scenarios: BenchScenario[] = []
      for (const project of ['typical', 'heavy'] as const)
        for (const css of SIZES)
          for (const quality of QUALITIES)
            scenarios.push({ project, css, dpr, quality, interact: quality === 'auto' })
      let done = 0
      const rows = await runPreviewBenchmark({
        assets,
        scenarios,
        container: stage,
        onRow: (row) => {
          done++
          setStatus(`Preview ${done} of ${scenarios.length}`)
          const tr = el('tr')
          for (const c of rowCells(row)) tr.append(el('td', c, 'padding: 2px 10px 2px 0;'))
          table.append(tr)
        },
      })
      setStatus('Measuring cuts…')
      const coded = await syntheticVideo(640, 360, 4, 30, undefined, { frameCode: true })
      const footage = await mediaStore.storeBlob(coded, {
        kind: 'video',
        name: 'bench-cuts.mp4',
        origin: { type: 'generated' },
      })
      const cuts = await measureCuts(cutProject({ song: assets.song, footage }), stage)
      exports.append(
        el(
          'div',
          `Cuts (beat-cut edit, ${cuts.cuts.length} cuts incl. a freeze): stall max ${cuts.maxStallMs} ms, mean ` +
            `${cuts.meanStallMs} ms beyond a ${cuts.frameMs} ms frame; ${cuts.wrongFrames} wrong frames after cuts`,
        ),
      )
      void mediaStore.remove(footage)
      const exportResults: ExportBenchResult[] = []
      for (const project of ['typical', 'heavy'] as const) {
        setStatus(`Exporting the ${project} project…`)
        const r = await runExportBenchmark(project, assets, {
          width: 1920,
          height: 1080,
          fps: 30,
          seconds: 4,
        })
        exportResults.push(r)
        exports.append(
          el(
            'div',
            `Export ${r.project} ${r.size}: ${r.seconds} s for 4 s (${r.realtime}× realtime), main thread: ` +
              `input delay p95 ${r.main.inputDelayP95Ms} ms, ${r.main.longTasks} long tasks (max ${r.main.longTaskMaxMs} ms)`,
          ),
        )
      }
      const report = {
        gpu: gpuName(),
        dpr,
        userAgent: navigator.userAgent,
        preview: rows,
        export: exportResults,
      }
      json.textContent = JSON.stringify(report, null, 1)
      Object.assign(window, { mvStudioBenchmark: report })
      setStatus('Done.')
      for (const a of Object.values(assets)) void mediaStore.remove(a)
    } catch (error) {
      setStatus(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`)
      console.error(error)
    } finally {
      run.disabled = false
    }
  }
  run.onclick = () => void start()
  if (new URLSearchParams(location.search).has('autorun')) void start()
}
