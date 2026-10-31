import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openHarness, test } from '../e2e/fixtures.ts'

// How strongly visualizers and music reactions move on real songs. For each song (DYN_SONGS of the JamendoLyrics
// set that `sh scripts/fetch-analysis-fixtures.sh en` downloads), runs the fast analysis, then reports:
// - each reaction's feature level over the song (p10/p50/p90) and its local swing (mean max-min within 2 s windows,
//   sampled at 25 fps), which is how hard it pulses;
// - each visualizer's lit share of the frame and the height it spans (p10/p50/p90), and its loud/quiet ratio (mean lit
//   share in the loudest quarter of frames over the quietest quarter).
// Sheets of each visualizer at the song's quietest, median and loudest moments go to DYN_OUT.
const SONGS = path.resolve(import.meta.dirname, '../fixtures/.cache/jamendolyrics/mp3')
const OUT = process.env.DYN_OUT ?? '/tmp/mv-dynamics'
const COUNT = Number(process.env.DYN_SONGS ?? 6)
const VISUALIZERS = (
  process.env.DYN_VISUALIZERS ??
  'visualizer.spectrum,visualizer.waveform,visualizer.circle,visualizer.particles'
).split(',')

test('visual dynamics on real songs', async ({ page }) => {
  test.skip(!existsSync(SONGS), 'run sh scripts/fetch-analysis-fixtures.sh en first')
  test.setTimeout(COUNT * 180_000)
  const files = readdirSync(SONGS)
    .filter((f) => f.endsWith('.mp3'))
    .sort()
    .filter((_, i, all) => i % Math.max(1, Math.floor(all.length / COUNT)) === 0)
    .slice(0, COUNT)
  page.on('console', (m) => {
    if (m.type() === 'error') console.warn(m.text())
  })
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    files.map((f) => path.join(SONGS, f)),
  )
  const result = await page.evaluate(async (visualizers) => {
    const { analysis, engine, files, model, plugins, testing } = window.mvStudio
    const W = 160
    const H = 90
    const q = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b)
      return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? 0
    }
    const r2 = (x: number) => Math.round(x * 100) / 100
    const service = new analysis.SongAnalysisService()
    const { compositor } = testing.createCompositor('export', W, H)
    const songs = []
    const sheets: { name: string; data: string }[] = []
    for (const [i, file] of files().entries()) {
      const audio = await analysis.decodeAudioFile(file)
      const duration = audio.channels[0]!.length / audio.sampleRate
      const fast = await service.analyze(`s${i}`, audio).promise
      await service.release(`s${i}`)
      const p = plugins.preview.previewBase('Dynamics')
      const songId = plugins.preview.PREVIEW_SONG_ID
      p.analysis.audio[songId] = { ...fast, assetId: songId }
      const songClip = Object.values(p.clips).find((c) => c.type === 'audio')!
      songClip.duration = duration
      p.duration = duration
      const sampler = engine.createAudioSampler(p)
      const t0 = 5
      const t1 = duration - 5
      const reactions: Record<string, { level: number[]; swing: number }> = {}
      const probe = model.createImageClip({ trackId: p.tracks[0]!.id, assetId: 'probe', start: 0, duration })
      p.clips[probe.id] = probe
      for (const r of plugins.reactions.REACTIONS) {
        // The modulation the reaction puts on a clip property: its feature source and smoothing for this song.
        const editor = new model.ProjectEditor(structuredClone(p))
        editor.dispatch(
          plugins.reactions.reactionCommands(p, [{ clipId: probe.id, property: 'opacity' }], r.id),
        )
        const mod = editor.getProject().clips[probe.id]!.opacity.modulation![0]!
        const source = mod.source
        const level: number[] = []
        let swing = 0
        for (let w = 0; w < 30; w++) {
          const start = t0 + ((t1 - t0 - 2) * w) / 29
          let lo = Infinity
          let hi = -Infinity
          for (let k = 0; k < 50; k++) {
            const v = sampler.sample(source, start + k / 25, mod.smoothing)
            level.push(v)
            lo = Math.min(lo, v)
            hi = Math.max(hi, v)
          }
          swing += (hi - lo) / 30
        }
        reactions[r.id] = { level: [q(level, 0.1), q(level, 0.5), q(level, 0.9)].map(r2), swing: r2(swing) }
      }
      const times = Array.from({ length: 48 }, (_, k) => t0 + ((t1 - t0) * (k + 0.5)) / 48)
      const loud = times.map((t) => sampler.sample({ kind: 'loudness' }, t, 0.2))
      const order = times.map((_, k) => k).sort((a, b) => loud[a]! - loud[b]!)
      const quietSet = new Set(order.slice(0, 12))
      const loudSet = new Set(order.slice(-12))
      const picks = [order[0]!, order[24]!, order[47]!]
      const vis: Record<string, { lit: number[]; extent: number[]; loudOverQuiet: number }> = {}
      const sheet = new OffscreenCanvas(W * 3, H * visualizers.length)
      const ctx = sheet.getContext('2d')!
      for (const [row, id] of visualizers.entries()) {
        const project = structuredClone(p)
        const track = project.tracks[0]!
        const clip = plugins.library.createGeneratorClip({
          trackId: track.id,
          generatorId: id,
          start: 0,
          duration,
        })
        project.clips[clip.id] = clip
        const lit: number[] = []
        const extent: number[] = []
        for (const [k, t] of times.entries()) {
          await compositor.render(project, t)
          const px = testing.readPixels(compositor.canvas, W, H)
          let n = 0
          let top = H
          let bottom = -1
          for (let j = 0; j < px.length; j += 4)
            if (Math.max(px[j]!, px[j + 1]!, px[j + 2]!) > 60) {
              n++
              const y = Math.floor(j / 4 / W)
              top = Math.min(top, y)
              bottom = Math.max(bottom, y)
            }
          lit.push(n / (W * H))
          extent.push(bottom >= top ? (bottom - top + 1) / H : 0)
          const col = picks.indexOf(k)
          if (col >= 0) ctx.drawImage(compositor.canvas, col * W, row * H, W, H)
        }
        const mean = (set: Set<number>) =>
          lit.filter((_, k) => set.has(k)).reduce((a, b) => a + b, 0) / set.size
        vis[id] = {
          lit: [q(lit, 0.1), q(lit, 0.5), q(lit, 0.9)].map((x) => r2(x * 100)),
          extent: [q(extent, 0.1), q(extent, 0.5), q(extent, 0.9)].map((x) => r2(x * 100)),
          loudOverQuiet: r2(mean(loudSet) / Math.max(mean(quietSet), 1e-4)),
        }
      }
      const blob = await sheet.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let j = 0; j < bytes.length; j += 0x8000)
        s += String.fromCharCode(...bytes.subarray(j, j + 0x8000))
      sheets.push({ name: file.name.replace(/\.mp3$/, ''), data: btoa(s) })
      songs.push({
        name: file.name,
        loudness: [q(loud, 0.1), q(loud, 0.5), q(loud, 0.9)].map(r2),
        reactions,
        vis,
      })
    }
    service.dispose()
    compositor.dispose()
    return { songs, sheets }
  }, VISUALIZERS)
  mkdirSync(OUT, { recursive: true })
  for (const s of result.sheets) writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(s.data, 'base64'))
  writeFileSync(path.join(OUT, 'dynamics.json'), JSON.stringify(result.songs, null, 1))
  for (const song of result.songs) {
    console.warn(`\n${song.name}  loudness p10/50/90 ${song.loudness.join('/')}`)
    for (const [id, r] of Object.entries(song.reactions))
      console.warn(`  reaction ${id.padEnd(9)} level ${r.level.join('/').padEnd(16)} swing ${r.swing}`)
    for (const [id, v] of Object.entries(song.vis))
      console.warn(
        `  ${id.padEnd(22)} lit % ${v.lit.join('/').padEnd(18)} height % ${v.extent.join('/').padEnd(16)} loud/quiet ${v.loudOverQuiet}`,
      )
  }
})
