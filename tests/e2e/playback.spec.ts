import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('offline mixdown places clips at their timeline position with trim, volume and fades', async ({
  page,
}) => {
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'song.wav')])
  const r = await page.evaluate(async () => {
    const { model, media, engine } = window.mvStudio
    const song = await media.mediaStore.importFile(window.mvStudio.files()[0])
    const p = model.createProject({ name: 'mix' })
    p.assets[song.id] = song
    const track = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    // Timeline 1..4 s plays song 2..5 s at half volume, fading out over the last second.
    const clip = model.createAudioClip({
      trackId: track.id,
      assetId: song.id,
      start: 1,
      duration: 3,
      sourceStart: 2,
    })
    clip.volume = { value: 0.5 }
    clip.fadeOut = 1
    p.clips[clip.id] = clip
    const cache = new engine.audio.AudioBufferCache(media.mediaStore)
    const source: AudioBuffer = await cache.get(song)
    const sr = source.sampleRate
    const mix: AudioBuffer = await engine.audio.renderMix(p, cache, { start: 0, end: 5 }, sr)
    const out = mix.getChannelData(0)
    const src = source.getChannelData(0)
    const peak = (data: Float32Array, from: number, to: number) => {
      let m = 0
      for (let i = Math.round(from * sr); i < Math.round(to * sr); i++)
        m = Math.max(m, Math.abs(data[i] ?? 0))
      return m
    }
    const rms = (data: Float32Array, from: number, to: number) => {
      let s = 0
      let n = 0
      for (let i = Math.round(from * sr); i < Math.round(to * sr); i++, n++) s += (data[i] ?? 0) ** 2
      return Math.sqrt(s / n)
    }
    let bodyError = 0
    for (let i = Math.round(1.1 * sr); i < Math.round(2.9 * sr); i++)
      bodyError = Math.max(bodyError, Math.abs((out[i] as number) - 0.5 * (src[i + sr] as number)))
    return {
      channels: mix.numberOfChannels,
      seconds: mix.length / sr,
      silenceBefore: peak(out, 0, 0.99),
      silenceAfter: peak(out, 4.01, 5),
      bodyPeak: peak(out, 1.1, 2.9),
      bodyError,
      // Halfway through the 1 s fade-out the gain is 0.5 * 0.5.
      fadeRatio: rms(out, 3.45, 3.55) / rms(src, 4.45, 4.55),
    }
  })
  expect(r.channels).toBe(2)
  expect(r.seconds).toBeCloseTo(5, 3)
  expect(r.silenceBefore).toBeLessThan(1e-4)
  expect(r.silenceAfter).toBeLessThan(1e-4)
  expect(r.bodyPeak).toBeGreaterThan(0.1)
  expect(r.bodyError).toBeLessThan(1e-3)
  expect(r.fadeRatio).toBeGreaterThan(0.2)
  expect(r.fadeRatio).toBeLessThan(0.3)
})

test('preview plays in step with the audio clock, pauses, seeks, loops and stops at the end', async ({
  page,
}) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, engine } = window.mvStudio
    const [song, video] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const p = model.createProject({ name: 'preview' })
    p.assets[song.id] = song
    p.assets[video.id] = video
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visualTrack = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: 6,
    })
    const shot = model.createVideoClip({ trackId: visualTrack.id, assetId: video.id, start: 0, duration: 4 })
    p.clips[songClip.id] = songClip
    p.clips[shot.id] = shot
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const preview = new engine.PreviewController({ canvas, media: media.mediaStore })
    const states: string[] = []
    preview.subscribe(() => states.push(preview.getSnapshot().state))
    let frames = 0
    preview.onFrame(() => frames++)
    preview.setProject(p)
    preview.setViewport(480, 270, 1)
    await preview.rendered()
    // The controller drew the frame at the viewport size, whatever the page shows yet.
    const drawn = preview.stats()
    const drawnSize = [drawn.width, drawn.height]
    // With the render worker, the page's canvas is a placeholder that takes the worker canvas's size only once a frame
    // reaches the page, which can be after rendered() on a busy machine.
    for (let i = 0; i < 120 && canvas.width !== 480; i++) await new Promise((r) => requestAnimationFrame(r))
    const size = [canvas.width, canvas.height]
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    await preview.play()
    const wall0 = performance.now()
    const clock0 = preview.currentTime()
    await sleep(1500)
    const elapsed = (performance.now() - wall0) / 1000
    const advanced = preview.currentTime() - clock0
    const stats = preview.stats()
    const framesWhilePlaying = frames

    preview.pause()
    const pausedAt = preview.currentTime()
    await sleep(300)
    const drift = preview.currentTime() - pausedAt

    preview.seek(3)
    await preview.rendered()
    const seeked = preview.getSnapshot().time

    preview.setLoop({ start: 1, end: 1.5 })
    preview.seek(1)
    await preview.play()
    await sleep(200)
    // Sample the clock across two loop wraps: it must stay inside the loop and never stall at the wrap.
    const loopSamples: number[] = []
    for (let i = 0; i < 60; i++) {
      loopSamples.push(preview.currentTime())
      await sleep(20)
    }
    let longestStall = 0
    let stall = 0
    for (let i = 1; i < loopSamples.length; i++) {
      stall = loopSamples[i] === loopSamples[i - 1] ? stall + 1 : 0
      longestStall = Math.max(longestStall, stall)
    }
    const wraps = loopSamples.filter((t, i) => i > 0 && t < loopSamples[i - 1]).length
    const loopRange = [Math.min(...loopSamples), Math.max(...loopSamples)]
    preview.pause()
    preview.setLoop(null)

    preview.seek(5.5)
    await preview.play()
    await sleep(1000)
    const ended = preview.getSnapshot()
    preview.dispose()
    return {
      drawnSize,
      size,
      elapsed,
      advanced,
      stats,
      framesWhilePlaying,
      drift,
      seeked,
      wraps,
      longestStall,
      loopRange,
      ended,
      states,
    }
  })
  console.log('preview playback', JSON.stringify(r))
  expect(r.drawnSize).toEqual([480, 270])
  expect(r.size).toEqual([480, 270])
  // The clock follows real time, minus the scheduling lookahead and output latency at the start.
  expect(r.advanced).toBeGreaterThan(r.elapsed - 0.25)
  expect(r.advanced).toBeLessThan(r.elapsed + 0.05)
  expect(r.stats.fps).toBeGreaterThan(20)
  expect(r.framesWhilePlaying).toBeGreaterThan(30)
  expect(r.drift).toBe(0)
  expect(r.seeked).toBe(3)
  expect(r.wraps).toBeGreaterThanOrEqual(2)
  expect(r.longestStall).toBeLessThanOrEqual(1)
  expect(r.loopRange[0]).toBeGreaterThanOrEqual(1)
  expect(r.loopRange[1]).toBeLessThan(1.5)
  expect(r.ended).toMatchObject({ state: 'paused', time: 6, duration: 6 })
  expect(r.states).toContain('playing')
})

test('a paused preview frame matches the export render of the same time', async ({ page }) => {
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'clip.mp4')])
  const r = await page.evaluate(async () => {
    const { model, media, engine, testing } = window.mvStudio
    const video = await media.mediaStore.importFile(window.mvStudio.files()[0])
    const p = model.createProject({ name: 'match' })
    p.assets[video.id] = video
    const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const shot = model.createVideoClip({ trackId: visual.id, assetId: video.id, start: 0, duration: 4 })
    shot.transform.rotation = { value: 8 }
    shot.effects = [{ id: 'v', effectId: 'vignette', enabled: true, params: {} }]
    p.clips[shot.id] = shot
    const title = model.createTextClip({ trackId: visual.id, text: 'Frame match', start: 0, duration: 4 })
    title.trackId = model.createTrack('visual').id
    p.tracks.unshift({ ...model.createTrack('visual'), id: title.trackId })
    p.clips[title.id] = title

    const canvas = document.createElement('canvas')
    const preview = new engine.PreviewController({
      canvas,
      media: media.mediaStore,
      preserveDrawingBuffer: true,
    })
    preview.setProject(p)
    preview.setViewport(480, 270, 1)
    const exp = testing.createCompositor('export', 480, 270)
    const diffs = []
    for (const t of [0.5, 2.2, 1.1]) {
      preview.seek(t)
      await preview.rendered()
      const frame = await preview.captureFrame()
      const a = testing.readPixels(frame, 480, 270)
      frame.close()
      await exp.compositor.render(p, t)
      const b = testing.readPixels(exp.compositor.canvas, 480, 270)
      let sum = 0
      for (let i = 0; i < a.length; i += 4)
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      diffs.push(sum / (a.length / 4) / 3)
    }
    preview.dispose()
    exp.compositor.dispose()
    return diffs
  })
  for (const d of r) expect(d).toBeLessThan(0.5)
})

test('slow-motion and frozen clips show the same source frames in playing preview as in export', async ({
  page,
}) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'frames.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, engine, testing } = window.mvStudio
    const [song, video] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const p = model.createProject({ name: 'rates' })
    p.assets[song.id] = song
    p.assets[video.id] = video
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visualTrack = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: 4,
    })
    const slow = model.createVideoClip({
      trackId: visualTrack.id,
      assetId: video.id,
      start: 0,
      duration: 2.5,
    })
    slow.playbackRate = 0.5
    const frozen = model.createVideoClip({
      trackId: visualTrack.id,
      assetId: video.id,
      start: 2.5,
      duration: 1.5,
      sourceStart: 1,
    })
    frozen.playbackRate = 0
    for (const c of [songClip, slow, frozen]) p.clips[c.id] = c

    // frames.mp4 encodes its frame number N in gray levels: left half (N % 16) * 16 + 8, right half N / 16 likewise.
    const W = 320
    const H = 180
    const reader = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!
    const frameNumber = (source: CanvasImageSource) => {
      reader.drawImage(source, 0, 0, W, H)
      const d = reader.getImageData(0, 0, W, H).data
      const gray = (x: number, y: number) => {
        const i = (y * W + x) * 4
        return (d[i] + d[i + 1] + d[i + 2]) / 3
      }
      return Math.round((gray(80, 90) - 8) / 16) + 16 * Math.round((gray(240, 90) - 8) / 16)
    }

    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const preview = new engine.PreviewController({
      canvas,
      media: media.mediaStore,
      preserveDrawingBuffer: true,
    })
    preview.setProject(p)
    preview.setViewport(W, H, 1)
    await preview.rendered()
    const samples: { t: number; n: number }[] = []
    const reads: Promise<void>[] = []
    // Through captureFrame(): a canvas drawn in the render worker cannot be read here.
    preview.onFrame((t: number) =>
      reads.push(
        preview.captureFrame().then((frame: ImageBitmap) => {
          samples.push({ t, n: frameNumber(frame) })
          frame.close()
        }),
      ),
    )
    await preview.play()
    await new Promise((resolve) => setTimeout(resolve, 4300))
    await Promise.all(reads)
    preview.dispose()

    const exp = testing.createCompositor('export', W, H)
    const compared: { t: number; preview: number; export: number }[] = []
    for (const [i, s] of samples.entries()) {
      // The final still at t = 4 (the project end) is past both clips.
      if (i % 5 !== 0 || s.t >= 4) continue
      await exp.compositor.render(p, s.t)
      compared.push({ t: s.t, preview: s.n, export: frameNumber(exp.compositor.canvas) })
    }
    exp.compositor.dispose()
    return { samples, compared }
  })

  // Frame providers nudge source times 0.1 ms forward so float error never selects the previous frame.
  const expected = (t: number) => (t < 2.5 ? Math.floor((t * 0.5 + 1e-4) * 30) : 30)
  const slow = r.samples.filter((s) => s.t > 0.2 && s.t < 2.45)
  const frozen = r.samples.filter((s) => s.t > 2.55 && s.t < 4)
  expect(slow.length).toBeGreaterThan(60)
  expect(frozen.length).toBeGreaterThan(30)
  // Slow motion advances smoothly: no frame steps backwards (re-seeks against the clip rate did that).
  const backwards = slow.filter((s, i) => i > 0 && s.n < slow[i - 1].n)
  expect(backwards, JSON.stringify(slow.map((s) => [s.t.toFixed(3), s.n]))).toEqual([])
  for (const s of slow)
    expect(Math.abs(s.n - expected(s.t)), `slow-motion frame at ${s.t}`).toBeLessThanOrEqual(3)
  // A freeze holds exactly its frame.
  expect(new Set(frozen.map((s) => s.n))).toEqual(new Set([30]))
  // Export is frame-exact, and the playing preview stays within a few source frames of it.
  expect(r.compared.length).toBeGreaterThan(15)
  for (const c of r.compared) {
    expect(c.export, `export frame at ${c.t}`).toBe(expected(c.t))
    expect(Math.abs(c.preview - c.export), `preview vs export at ${c.t}`).toBeLessThanOrEqual(3)
  }
})
