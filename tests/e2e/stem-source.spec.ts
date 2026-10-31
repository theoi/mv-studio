import { expect, openHarness, test } from './fixtures.ts'

test('a visualizer reacting to the drums stem draws a different spectrum than one reacting to vocals, the same in preview, worker and export', async ({
  page,
}) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, media, engine, plugins, testing } = window.mvStudio
    const W = 320
    const H = 180
    // A song whose separated drums fill the low bands and vocals the mids, over a flat mix.
    const rate = 50
    const n = 8 * rate + 1
    const features = (bands: number[], loudness: number) => ({
      rate,
      loudness: Array(n).fill(loudness),
      bands: Array.from({ length: n }, () => bands),
      bandEdgesHz: [20, 60, 250, 500, 2000, 4000, 6000, 11025],
      onsets: [],
    })
    const p = model.createProject({ name: 'Stem source' })
    p.assets.song = {
      id: 'song',
      kind: 'audio',
      name: 'song.wav',
      mimeType: 'audio/wav',
      byteSize: 1,
      storageKey: 'media/song.wav',
      duration: 8,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
    }
    p.songAssetId = 'song'
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visualTrack = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({ trackId: audioTrack.id, assetId: 'song', start: 0, duration: 8 })
    p.clips[songClip.id] = songClip
    p.analysis.audio.song = {
      assetId: 'song',
      version: 'test',
      tempo: { bpm: 120, confidence: 1 },
      beats: Array.from({ length: 16 }, (_, i) => i * 0.5),
      features: features([0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55], 0.55),
      stemFeatures: {
        drums: features([0.95, 0.9, 0.45, 0.1, 0.05, 0.05, 0.05], 0.9),
        vocals: features([0.05, 0.1, 0.3, 0.9, 0.95, 0.5, 0.1], 0.5),
      },
    }
    const viz = plugins.library.createGeneratorClip({
      trackId: visualTrack.id,
      generatorId: 'visualizer.spectrum',
      start: 0,
      duration: 8,
    })
    p.clips[viz.id] = viz
    const editor = new model.ProjectEditor(p)
    const withSource = (stem: string | null) => {
      editor.dispatch({ type: 'clip.setAudioSource', clipId: viz.id, source: stem ? { stem } : null })
      return editor.getProject()
    }
    const projects = {
      mix: editor.getProject(),
      drums: withSource('drums'),
      vocals: withSource('vocals'),
      // Not separated: the clip falls back to the mix.
      bass: withSource('bass'),
    }
    editor.undo()
    editor.undo()
    const undone = editor.getProject()

    const exp = testing.createCompositor('export', W, H)
    const renderExport = async (project: unknown) => {
      await exp.compositor.render(project, 1)
      return testing.readPixels(exp.compositor.canvas, W, H) as Uint8ClampedArray
    }
    const previews = {
      main: new engine.PreviewController({
        canvas: document.createElement('canvas'),
        media: media.mediaStore,
        renderer: 'main',
      }),
      worker: new engine.PreviewController({
        canvas: document.createElement('canvas'),
        media: media.mediaStore,
        renderer: 'worker',
      }),
    }
    for (const preview of Object.values(previews)) preview.setViewport(W, H, 1)
    const renderPreview = async (preview: typeof previews.main, project: unknown) => {
      preview.setProject(project)
      preview.seek(1)
      await preview.rendered()
      const frame: ImageBitmap = await preview.captureFrame()
      const d = testing.readPixels(frame, W, H) as Uint8ClampedArray
      frame.close()
      return d
    }
    const maxDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let m = 0
      for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) m = Math.max(m, Math.abs(a[i]! - b[i]!))
      return m
    }
    // Height of the tallest bar in each eighth of the width, as a fraction of the canvas height.
    const profile = (d: Uint8ClampedArray) =>
      Array.from({ length: 8 }, (_, k) => {
        let tallest = 0
        for (let x = Math.floor((k / 8) * W); x < Math.floor(((k + 1) / 8) * W); x++) {
          let lit = 0
          for (let y = 0; y < H; y++) {
            const i = (y * W + x) * 4
            if (d[i]! + d[i + 1]! + d[i + 2]! > 120) lit++
          }
          tallest = Math.max(tallest, lit)
        }
        return tallest / H
      })
    const out: Record<string, { profile: number[]; mainVsExport: number; workerVsExport: number }> = {}
    const exported: Record<string, Uint8ClampedArray> = {}
    for (const [name, project] of Object.entries(projects)) {
      const e = await renderExport(project)
      exported[name] = e
      out[name] = {
        profile: profile(e),
        mainVsExport: maxDiff(await renderPreview(previews.main, project), e),
        workerVsExport: maxDiff(await renderPreview(previews.worker, project), e),
      }
    }
    const undoneVsDrums = maxDiff(await renderExport(undone), exported.drums!)
    const worker = previews.worker.stats().worker
    for (const preview of Object.values(previews)) preview.dispose()
    exp.compositor.dispose()
    return {
      out,
      worker,
      drumsVsVocals: maxDiff(exported.drums!, exported.vocals!),
      mixVsDrums: maxDiff(exported.mix!, exported.drums!),
      bassVsMix: maxDiff(exported.bass!, exported.mix!),
      undoneVsDrums,
      undoneSource: undone.clips[viz.id].audio,
    }
  })
  console.log('stem source', JSON.stringify(r))
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const low = (name: string) => mean(r.out[name]!.profile.slice(0, 3))
  const high = (name: string) => mean(r.out[name]!.profile.slice(4, 7))
  // Drums: tall bars at the low end. Vocals: tall bars in the mids and highs, short at the low end.
  expect(low('drums') - high('drums')).toBeGreaterThan(0.15)
  expect(high('vocals') - low('vocals')).toBeGreaterThan(0.15)
  expect(r.drumsVsVocals).toBeGreaterThan(100)
  expect(r.mixVsDrums).toBeGreaterThan(100)
  // A stem that was never separated draws the mix.
  expect(r.bassVsMix).toBe(0)
  // Two undos go back from bass to drums.
  expect(r.undoneSource).toEqual({ stem: 'drums' })
  expect(r.undoneVsDrums).toBe(0)
  expect(r.worker).toBe(true)
  for (const [name, v] of Object.entries(r.out)) {
    expect(v.mainVsExport, `${name}: main-thread preview vs export`).toBe(0)
    expect(v.workerVsExport, `${name}: worker preview vs export`).toBe(0)
  }
})
