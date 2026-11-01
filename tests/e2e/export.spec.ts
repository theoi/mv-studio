import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

// The app exports through its own media source, which the render worker reads over a message port.
for (const source of ['storage', 'page'] as const)
  test(`exports an H.264/AAC MP4 whose frames and audio match the preview render and mix, media from ${source === 'page' ? 'a page media source' : 'browser storage'}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000)
    await openHarness(page)
    await page.setInputFiles(
      '#e2e-file-input',
      ['song.mp3', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
    )
    const downloadPromise = page.waitForEvent('download')
    const r = await page.evaluate(async (source) => {
      const { model, media, engine, shared, testing } = window.mvStudio
      const [song, video] = await Promise.all(
        window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
      )
      const p = model.createProject({ name: 'Export test' })
      p.assets[song.id] = song
      p.assets[video.id] = video
      p.songAssetId = song.id
      const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
      const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
      const titles = model.createTrack('visual', 'Titles')
      p.tracks.unshift(titles)
      const songClip = model.createAudioClip({
        trackId: audioTrack.id,
        assetId: song.id,
        start: 0,
        duration: 3,
      })
      songClip.fadeOut = 0.5
      const shot = model.createVideoClip({
        trackId: visual.id,
        assetId: video.id,
        start: 0,
        duration: 3,
        sourceStart: 0.5,
      })
      shot.muted = true
      shot.effects = [{ id: 'g', effectId: 'film-grain', enabled: false, params: {} }]
      shot.transform.scaleX = {
        value: 1,
        keyframes: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 3, value: 1.3, easing: 'linear' },
        ],
      }
      shot.transform.scaleY = shot.transform.scaleX
      const title = model.createTextClip({
        trackId: titles.id,
        text: 'Export matches preview',
        start: 0.5,
        duration: 2,
      })
      title.animation = { presetId: 'fade-up', params: {} }
      // A bundled script font, unlike any fallback: the render worker must load it like the page does.
      title.style = { ...title.style, fontFamily: 'Pacifico, sans-serif', fontSize: 120 }
      for (const c of [songClip, shot, title]) p.clips[c.id] = c

      const settings = { ...engine.exporter.exportSize('16:9', '720p'), fps: 30, aspect: '16:9' }
      const reads: string[] = []
      const pageMedia = {
        getFile: (asset: { id: string }) => {
          reads.push(asset.id)
          return media.mediaStore.getFile(asset)
        },
      }
      const progress: { stage?: string; fraction?: number }[] = []
      const job = shared.jobs.run({
        kind: 'export.mp4',
        title: 'Export video',
        run: (ctx: unknown) =>
          engine.exporter.exportProject(p, settings, ctx, source === 'page' ? { media: pageMedia } : {}),
      })
      job.subscribe((s: { progress: { stage?: string; fraction?: number } }) => progress.push(s.progress))
      const started = performance.now()
      const result = await job.promise
      const seconds = (performance.now() - started) / 1000
      const file: File = result.file

      // Decode the exported file frame-exactly and compare with the compositor's render of the same time.
      const W = 320
      const H = 180
      const exported = new engine.DecoderFrameProvider({ getFile: async () => file })
      const asset = {
        id: 'export',
        kind: 'video',
        name: file.name,
        duration: result.durationSeconds,
        frameRate: 30,
      }
      const reference = testing.createCompositor('export', settings.width, settings.height)
      const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let sum = 0
        for (let i = 0; i < a.length; i += 4)
          sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
        return sum / (a.length / 4) / 3
      }
      const frames = []
      for (const n of [0, 20, 45, 46, 89]) {
        const t = n / 30
        const decoded = await exported.videoFrame(asset, t, 'out')
        const a = testing.readPixels(decoded.source, W, H)
        exported.endFrame()
        await reference.compositor.render(p, t)
        const b = testing.readPixels(reference.compositor.canvas, W, H)
        await reference.compositor.render(p, (n + 1) / 30)
        const next = testing.readPixels(reference.compositor.canvas, W, H)
        frames.push({ n, same: meanDiff(a, b), next: meanDiff(a, next) })
      }
      exported.dispose()
      reference.compositor.dispose()

      // Audio: the exported AAC track against the offline mix, including alignment.
      const ctx = new OfflineAudioContext(2, 1, 48000)
      const decodedAudio = await ctx.decodeAudioData(await file.arrayBuffer())
      const mix = await engine.audio.renderMix(
        p,
        new engine.audio.AudioBufferCache(media.mediaStore),
        { start: 0, end: 3 },
        48000,
      )
      const a = decodedAudio.getChannelData(0)
      const b = mix.getChannelData(0)
      const from = 24000
      const len = 48000
      let bestLag = 0
      let bestCorr = -Infinity
      for (let lag = -2048; lag <= 2048; lag += 1) {
        let dot = 0
        let na = 0
        let nb = 0
        for (let i = from; i < from + len; i += 4) {
          const x = a[i + lag] ?? 0
          const y = b[i]
          dot += x * y
          na += x * x
          nb += y * y
        }
        const corr = dot / Math.sqrt(na * nb || 1)
        if (corr > bestCorr) {
          bestCorr = corr
          bestLag = lag
        }
      }

      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      return {
        name: file.name,
        size: file.size,
        seconds,
        durationSeconds: result.durationSeconds,
        videoCodec: result.videoCodec,
        audioCodec: result.audioCodec,
        stages: [...new Set(progress.map((s) => s.stage).filter(Boolean))],
        lastFraction: progress[progress.length - 1]?.fraction,
        frames,
        audioSeconds: decodedAudio.duration,
        bestLag,
        bestCorr,
        videoReads: reads.filter((id) => id === video.id).length,
      }
    }, source)
    console.log('export', source, JSON.stringify(r))
    const download = await downloadPromise
    const out = testInfo.outputPath(r.name)
    await download.saveAs(out)
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', out],
        {
          encoding: 'utf8',
        },
      ),
    )
    const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
    expect(r.name).toBe('Export test.mp4')
    expect(v).toMatchObject({
      codec_name: 'h264',
      width: 1280,
      height: 720,
      r_frame_rate: '30/1',
      nb_read_frames: '90',
    })
    expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    expect(Number(probe.format.duration)).toBeCloseTo(3, 1)
    expect(r.videoCodec).toMatch(/^avc1/)
    expect(r.audioCodec).toMatch(/^mp4a/)
    expect(r.stages).toEqual(expect.arrayContaining(['prepare', 'mix', 'render', 'finalize']))
    expect(r.lastFraction).toBe(1)
    for (const f of r.frames) {
      // Encoding loss stays well below the difference to the neighbouring frame.
      expect(f.same, `frame ${f.n}`).toBeLessThan(3)
      expect(f.same, `frame ${f.n} is not off by one`).toBeLessThan(f.next)
    }
    expect(r.audioSeconds).toBeGreaterThan(2.95)
    expect(Math.abs(r.bestLag)).toBeLessThanOrEqual(2)
    expect(r.bestCorr).toBeGreaterThan(0.95)
    // The clip's frames came through the page's media source, not straight from storage.
    if (source === 'page') expect(r.videoReads).toBeGreaterThan(0)
  })

test('an export renders on the page when the render worker cannot draw', async ({ page }) => {
  test.setTimeout(120_000)
  // Only the export's render worker gets no WebGL2, as in browsers whose workers cannot draw; the page keeps it.
  await page.addInitScript(() => {
    const w = window as unknown as { renderWorkerRefused: number }
    w.renderWorkerRefused = 0
    new BroadcastChannel('e2e-render-no-webgl2').onmessage = () => w.renderWorkerRefused++
    const Native = window.Worker
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (options?.name === 'render') {
          // A static import, so the worker's first messages wait until its module has run instead of being dropped.
          const source = `import ${JSON.stringify(new URL(url, location.href).href)}
const get = OffscreenCanvas.prototype.getContext
OffscreenCanvas.prototype.getContext = function (type, ...rest) {
  if (type !== 'webgl2') return get.call(this, type, ...rest)
  new BroadcastChannel('e2e-render-no-webgl2').postMessage(type)
  return null
}`
          super(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), options)
        } else super(url, options)
      }
    }
  })
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, engine, shared, testing } = window.mvStudio
    const [song, video] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const p = model.createProject({ name: 'Fallback' })
    p.assets[song.id] = song
    p.assets[video.id] = video
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: 2,
    })
    const shot = model.createVideoClip({ trackId: visual.id, assetId: video.id, start: 0, duration: 2 })
    shot.muted = true
    for (const c of [songClip, shot]) p.clips[c.id] = c
    const settings = { ...engine.exporter.exportSize('16:9', '720p'), fps: 30, aspect: '16:9' }
    let reads = 0
    const pageMedia = {
      getFile: (asset: unknown) => {
        reads++
        return media.mediaStore.getFile(asset)
      },
    }
    const result = await shared.jobs.run({
      kind: 'export.mp4',
      title: 'Export video',
      run: (ctx: unknown) => engine.exporter.exportProject(p, settings, ctx, { media: pageMedia }),
    }).promise
    const file: File = result.file
    const exported = new engine.DecoderFrameProvider({ getFile: async () => file })
    const asset = {
      id: 'export',
      kind: 'video',
      name: file.name,
      duration: result.durationSeconds,
      frameRate: 30,
    }
    const reference = testing.createCompositor('export', settings.width, settings.height)
    const diffs = []
    for (const n of [10, 50]) {
      const decoded = await exported.videoFrame(asset, n / 30, 'out')
      const a = testing.readPixels(decoded.source, 320, 180)
      exported.endFrame()
      await reference.compositor.render(p, n / 30)
      const b = testing.readPixels(reference.compositor.canvas, 320, 180)
      let sum = 0
      for (let i = 0; i < a.length; i += 4)
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      diffs.push(sum / (a.length / 4) / 3)
    }
    exported.dispose()
    reference.compositor.dispose()
    return {
      durationSeconds: result.durationSeconds,
      diffs,
      reads,
      refused: (window as unknown as { renderWorkerRefused: number }).renderWorkerRefused,
    }
  })
  console.log('fallback export', JSON.stringify(r))
  // The render worker was asked and could not draw, so the page rendered the export with the same media source.
  expect(r.refused).toBeGreaterThan(0)
  expect(r.durationSeconds).toBeCloseTo(2, 2)
  expect(r.reads).toBeGreaterThan(0)
  for (const d of r.diffs) expect(d).toBeLessThan(3)
})

test('the time estimated before an export is not under the time the export takes', async ({ page }) => {
  test.setTimeout(180_000)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, exporting } = window.mvStudio
    const [song, video] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const p = model.createProject({ name: 'Estimate' })
    p.assets[song.id] = song
    p.assets[video.id] = video
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const titles = model.createTrack('visual', 'Titles')
    p.tracks.unshift(titles)
    const clips = [
      model.createAudioClip({ trackId: audioTrack.id, assetId: song.id, start: 0, duration: 6 }),
      model.createVideoClip({ trackId: visual.id, assetId: video.id, start: 0, duration: 3 }),
      model.createVideoClip({ trackId: visual.id, assetId: video.id, start: 3, duration: 3, sourceStart: 1 }),
      model.createTextClip({
        trackId: titles.id,
        text: 'Estimate',
        start: 1,
        duration: 4,
        style: { shadow: { color: 'rgba(0,0,0,0.6)', blur: 24, offsetX: 0, offsetY: 2 } },
      }),
    ]
    for (const c of clips) p.clips[c.id] = c
    const spec = exporting.newOutput(p, 'video', { resolution: '720p' })
    const estimate = await exporting.estimateOutput(exporting.planOutput(p, spec), {
      signal: new AbortController().signal,
    })
    const started = performance.now()
    await exporting.startExport(p, [spec]).promise
    return { estimate, seconds: (performance.now() - started) / 1000 }
  })
  console.log('estimate', JSON.stringify(r))
  expect(r.estimate).toBeGreaterThanOrEqual(r.seconds)
  // Not so cautious that it says nothing.
  expect(r.estimate).toBeLessThan(4 * r.seconds)
})

test('cancelling an export stops it with a cancelled error and leaves no file behind', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, engine, shared } = window.mvStudio
    const p = model.createProject({ name: 'Cancel me' })
    const solid = model.createSolidClip({ trackId: p.tracks[0].id, color: '#336699', start: 0, duration: 30 })
    p.clips[solid.id] = solid
    const job = shared.jobs.run({
      kind: 'export.mp4',
      title: 'Export video',
      run: (ctx: unknown) =>
        engine.exporter.exportProject(p, { width: 1280, height: 720, fps: 30, aspect: '16:9' }, ctx),
    })
    await new Promise<void>((resolve) => {
      const off = job.subscribe((s: { progress: { stage?: string } }) => {
        if (s.progress.stage === 'render') {
          off()
          resolve()
        }
      })
    })
    job.cancel()
    const error = await job.promise.then(
      () => null,
      (e: { code: string }) => e.code,
    )
    const root = await navigator.storage.getDirectory()
    const exports = await root.getDirectoryHandle('exports', { create: true })
    const entries: string[] = []
    for await (const name of (exports as unknown as { keys(): AsyncIterable<string> }).keys())
      entries.push(name)
    return { error, status: job.snapshot().status, entries }
  })
  expect(r).toEqual({ error: 'cancelled', status: 'cancelled', entries: [] })
})
