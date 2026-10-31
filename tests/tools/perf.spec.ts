import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openHarness, test } from '../e2e/fixtures.ts'

// Frame cost of every plugin over a baseline without it, at 1280x720 (PERF_KIND=effect|transition|generator|
// text-animation|all, PERF_FRAMES, PERF_OUT). Results are relative: agents and CI render with SwiftShader on the CPU.
const OUT = process.env.PERF_OUT ?? '/tmp/mv-perf'

interface Row {
  id: string
  kind: string
  cost: string
  baselineMs: number
  ms: number
  extraMs: number
}

test('plugin frame cost', async ({ page }) => {
  const kind = process.env.PERF_KIND ?? 'all'
  const frames = Number(process.env.PERF_FRAMES ?? 12)
  await openHarness(page)
  const rows: Row[] = await page.evaluate(
    async ({ kind, frames }) => {
      const { engine, media, plugins, testing } = window.mvStudio
      const image = await media.mediaStore.storeBlob(await plugins.preview.sampleSceneBlob(1280, 720), {
        kind: 'image',
        name: 'scene.png',
        origin: { type: 'generated' },
      })
      const { compositor } = testing.createCompositor('export', 1280, 720)
      const gl = compositor.canvas.getContext('webgl2') as WebGL2RenderingContext
      const pixel = new Uint8Array(4)
      type Project = Parameters<typeof compositor.render>[0]
      const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!
      const time = async (project: Project, t0: number) => {
        for (let i = 0; i < 3; i++) await compositor.render(project, t0 + i / 30)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        const samples: number[] = []
        for (let i = 0; i < frames; i++) {
          const start = performance.now()
          await compositor.render(project, t0 + (i % 6) / 60)
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          samples.push(performance.now() - start)
        }
        return median(samples)
      }
      const baselines = new Map<string, number>()
      const kinds = kind === 'all' ? ['effect', 'transition', 'generator', 'text-animation'] : [kind]
      const out: Row[] = []
      for (const k of kinds) {
        for (const def of engine.pluginRegistry.list(k as 'effect')) {
          const { project, time: t } = plugins.preview.pluginPreview(def.id, { image })
          const base = structuredClone(project)
          for (const clip of Object.values(base.clips)) {
            if (clip.type === 'audio') continue
            if (k === 'effect') clip.effects = []
            if (k === 'transition') delete clip.transitionIn
            if (k === 'generator' && clip.type === 'generator') delete base.clips[clip.id]
            if (k === 'text-animation' && clip.type === 'text') delete clip.animation
          }
          if (!baselines.has(k)) baselines.set(k, await time(base, t))
          const baselineMs = baselines.get(k)!
          const ms = await time(project, t)
          out.push({
            id: def.id,
            kind: k,
            cost: def.cost ?? '',
            baselineMs,
            ms,
            extraMs: Math.max(0, ms - baselineMs),
          })
        }
      }
      compositor.dispose()
      return out
    },
    { kind, frames },
  )
  mkdirSync(OUT, { recursive: true })
  writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(rows, null, 2))
  const fmt = (n: number) => n.toFixed(1)
  const lines = ['| id | kind | cost | frame ms | over baseline ms |', '| --- | --- | --- | --- | --- |']
  for (const r of rows) lines.push(`| ${r.id} | ${r.kind} | ${r.cost} | ${fmt(r.ms)} | ${fmt(r.extraMs)} |`)
  writeFileSync(path.join(OUT, 'perf.md'), lines.join('\n') + '\n')
})
