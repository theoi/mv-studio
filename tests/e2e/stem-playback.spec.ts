import type { Page } from '@playwright/test'
import type { Asset, Project, TrackStems } from '../../src/model/types.ts'
import { expect, openHarness, test } from './fixtures.ts'

interface StemTest {
  sr: number
  seconds: number
  /** Sample of each drum hit. */
  bursts: number[]
  stems: Record<string, Asset>
  project(o: { stems?: boolean; flags?: TrackStems; extra?: boolean; stemAssets?: Record<string, Asset> }): {
    project: Project
    clipId: string
  }
  level(buffer: AudioBuffer, hz: number): number
  hits(buffer: AudioBuffer): { at: number; peak: number }[]
}

declare global {
  interface Window {
    stemTest: StemTest
  }
}

/**
 * Stores a synthetic song and its four stems (vocals 1 kHz, bass 80 Hz, other 300 Hz, drums: a spike followed by
 * decaying noise at known samples), an FX tone (500 Hz) and a video soundtrack (2.5 kHz), and installs helpers on
 * window.stemTest. The song is the sum of the stems, so stems need no model.
 */
async function setupStems(page: Page): Promise<void> {
  await openHarness(page)
  await page.evaluate(async () => {
    const { model, media } = window.mvStudio
    const sr = 48_000
    const seconds = 3
    const n = sr * seconds
    const tone = (hz: number) =>
      Float32Array.from({ length: n }, (_, i) => 0.1 * Math.sin((2 * Math.PI * hz * i) / sr))
    const bursts = [0.3, 1.1, 1.9, 2.6].map((t) => Math.round(t * sr) + 17)
    const drums = new Float32Array(n)
    let seed = 12345
    const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1
    for (const b of bursts) {
      drums[b] = 0.9
      for (let k = 1; k < 480; k++) drums[b + k] = 0.25 * random() * (1 - k / 480)
    }
    const signals: Record<string, Float32Array> = {
      vocals: tone(1000),
      drums,
      bass: tone(80),
      other: tone(300),
    }
    const song = new Float32Array(n)
    for (const s of Object.values(signals)) for (let i = 0; i < n; i++) song[i] += s[i]
    const wav = (x: Float32Array) => {
      const data = new DataView(new ArrayBuffer(44 + x.length * 4))
      const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)))
      text(0, 'RIFF')
      data.setUint32(4, 36 + x.length * 4, true)
      text(8, 'WAVEfmt ')
      data.setUint32(16, 16, true)
      data.setUint16(20, 1, true)
      data.setUint16(22, 2, true)
      data.setUint32(24, sr, true)
      data.setUint32(28, sr * 4, true)
      data.setUint16(32, 4, true)
      data.setUint16(34, 16, true)
      text(36, 'data')
      data.setUint32(40, x.length * 4, true)
      for (let i = 0; i < x.length; i++) {
        const v = Math.round(Math.max(-1, Math.min(1, x[i])) * 32767)
        data.setInt16(44 + i * 4, v, true)
        data.setInt16(46 + i * 4, v, true)
      }
      return new Blob([data.buffer], { type: 'audio/wav' })
    }
    const store = (x: Float32Array, name: string, origin: object) =>
      media.mediaStore.storeBlob(wav(x), { kind: 'audio', name, origin })
    const songAsset = await store(song, 'song.wav', { type: 'import' })
    const stems: Record<string, { id: string }> = {}
    for (const [name, x] of Object.entries(signals))
      stems[name] = await store(x, `song (${name}).wav`, { type: 'stem', parentAssetId: songAsset.id })
    const fx = await store(tone(500), 'fx.wav', { type: 'import' })
    const videoSound = await store(tone(2500), 'video sound.wav', { type: 'import' })
    // The mix only reads a video asset's sound, so a WAV stands in for a video file.
    const video = {
      ...videoSound,
      id: `video-${videoSound.id}`,
      kind: 'video',
      mimeType: 'video/mp4',
      hasAudio: true,
    }

    const project = (o: {
      stems?: boolean
      flags?: object
      extra?: boolean
      stemAssets?: Record<string, { id: string }>
    }) => {
      const p = model.createProject({ name: 'stems' })
      const stemAssets: Record<string, { id: string }> = { ...stems, ...o.stemAssets }
      p.assets[songAsset.id] = songAsset
      for (const a of Object.values(stemAssets)) p.assets[a.id] = a
      const music = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
      const clip = model.createAudioClip({
        trackId: music.id,
        assetId: songAsset.id,
        start: 0,
        duration: seconds,
      })
      p.clips[clip.id] = clip
      if (o.stems !== false)
        p.analysis.audio[songAsset.id] = {
          assetId: songAsset.id,
          version: 'test',
          stems: Object.fromEntries(Object.entries(stemAssets).map(([name, a]) => [name, a.id])),
        }
      if (o.flags) music.stems = o.flags
      if (o.extra) {
        const fxTrack = model.createTrack('audio', 'FX')
        p.tracks.push(fxTrack)
        p.assets[fx.id] = fx
        const hit = model.createAudioClip({
          trackId: fxTrack.id,
          assetId: fx.id,
          start: 0,
          duration: seconds,
        })
        p.clips[hit.id] = hit
        p.assets[video.id] = video
        const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
        const shot = model.createVideoClip({
          trackId: visual.id,
          assetId: video.id,
          start: 0,
          duration: seconds,
        })
        p.clips[shot.id] = shot
      }
      return { project: p, clipId: clip.id as string }
    }

    /** Magnitude in dB at `hz` over 0.25..1.75 s, a whole number of periods of every tone. */
    const level = (buffer: AudioBuffer, hz: number) => {
      const x = buffer.getChannelData(0)
      let re = 0
      let im = 0
      for (let i = Math.round(0.25 * sr); i < Math.round(1.75 * sr); i++) {
        re += x[i] * Math.cos((2 * Math.PI * hz * i) / sr)
        im -= x[i] * Math.sin((2 * Math.PI * hz * i) / sr)
      }
      return 20 * Math.log10(Math.hypot(re, im) + 1e-9)
    }
    /** Sample of the largest magnitude within 1000 samples of each drum hit, and that magnitude. */
    const hits = (buffer: AudioBuffer) => {
      const x = buffer.getChannelData(0)
      return bursts.map((b) => {
        let at = b - 1000
        for (let i = b - 1000; i < b + 1000; i++) if (Math.abs(x[i]) > Math.abs(x[at])) at = i
        return { at, peak: Math.abs(x[at]) }
      })
    }
    Object.assign(window, { stemTest: { sr, seconds, bursts, songAsset, stems, project, level, hits } })
  })
}

test('stems with no mute or solo mix sample for sample like the song without stems', async ({ page }) => {
  await setupStems(page)
  const r = await page.evaluate(async () => {
    const { engine, media } = window.mvStudio
    const t = window.stemTest
    const cache = new engine.audio.AudioBufferCache(media.mediaStore)
    const range = { start: 0, end: t.seconds }
    const a = await engine.audio.renderMix(t.project({}).project, cache, range, t.sr)
    const b = await engine.audio.renderMix(t.project({ stems: false }).project, cache, range, t.sr)
    let diff = 0
    for (let c = 0; c < 2; c++) {
      const x = a.getChannelData(c)
      const y = b.getChannelData(c)
      for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs(x[i] - y[i]))
    }
    return { diff, length: a.length, peak: t.hits(a)[0].peak }
  })
  expect(r.length).toBe(3 * 48_000)
  expect(r.peak).toBeGreaterThan(0.8)
  expect(r.diff).toBe(0)
})

test('muting the vocals stem removes 1 kHz only, with the drums on the same samples', async ({ page }) => {
  await setupStems(page)
  const r = await page.evaluate(async () => {
    const { engine, media } = window.mvStudio
    const t = window.stemTest
    const cache = new engine.audio.AudioBufferCache(media.mediaStore)
    const range = { start: 0, end: t.seconds }
    const all = await engine.audio.renderMix(t.project({}).project, cache, range, t.sr)
    const muted = await engine.audio.renderMix(
      t.project({ flags: { vocals: { muted: true } } }).project,
      cache,
      range,
      t.sr,
    )
    const levels = (b: AudioBuffer) => Object.fromEntries([1000, 80, 300].map((hz) => [hz, t.level(b, hz)]))
    return {
      all: levels(all),
      muted: levels(muted),
      hitsAll: t.hits(all),
      hitsMuted: t.hits(muted),
      bursts: t.bursts,
    }
  })
  console.log('vocals muted', JSON.stringify(r))
  expect(r.all[1000] - r.muted[1000]).toBeGreaterThan(30)
  expect(Math.abs(r.all[80] - r.muted[80])).toBeLessThan(1)
  expect(Math.abs(r.all[300] - r.muted[300])).toBeLessThan(1)
  expect(r.hitsMuted.map((h: { at: number }) => h.at)).toEqual(r.bursts)
  expect(r.hitsMuted.map((h: { at: number }) => h.at)).toEqual(r.hitsAll.map((h: { at: number }) => h.at))
})

test('soloing the bass stem leaves only 80 Hz and silences other tracks and video sound', async ({
  page,
}) => {
  await setupStems(page)
  const r = await page.evaluate(async () => {
    const { engine, media } = window.mvStudio
    const t = window.stemTest
    const cache = new engine.audio.AudioBufferCache(media.mediaStore)
    const range = { start: 0, end: t.seconds }
    const all = await engine.audio.renderMix(t.project({ extra: true }).project, cache, range, t.sr)
    const solo = await engine.audio.renderMix(
      t.project({ extra: true, flags: { bass: { solo: true } } }).project,
      cache,
      range,
      t.sr,
    )
    const levels = (b: AudioBuffer) =>
      Object.fromEntries([1000, 80, 300, 500, 2500].map((hz) => [hz, t.level(b, hz)]))
    return { all: levels(all), solo: levels(solo), hits: t.hits(solo) }
  })
  console.log('bass soloed', JSON.stringify(r))
  expect(Math.abs(r.all[80] - r.solo[80])).toBeLessThan(1)
  // Vocals, other, the FX track and the video's sound: all present without the solo, all gone with it.
  for (const hz of [1000, 300, 500, 2500]) {
    expect(r.all[hz], `${hz} Hz without solo`).toBeGreaterThan(r.all[80] - 1)
    expect(r.all[hz] - r.solo[hz], `${hz} Hz`).toBeGreaterThan(30)
  }
  for (const hit of r.hits) expect(hit.peak).toBeLessThan(0.15)
})

test('a stem that cannot be decoded fails the mix with a decode error instead of changing the sound', async ({
  page,
}) => {
  await setupStems(page)
  const r = await page.evaluate(async () => {
    const { engine, media } = window.mvStudio
    const t = window.stemTest
    const drums = t.stems.drums
    const corrupt = { ...drums, id: `corrupt-${drums.id}`, storageKey: `${drums.storageKey}-corrupt` }
    await media.mediaStore.restore(corrupt, new Blob([new Uint8Array(4096).fill(7)]))
    const cache = new engine.audio.AudioBufferCache(media.mediaStore)
    const range = { start: 0, end: t.seconds }
    // Without stem flags the stems are not used, so the mix plays as before.
    const plain = await engine.audio.renderMix(
      t.project({ stemAssets: { drums: corrupt } }).project,
      cache,
      range,
      t.sr,
    )
    try {
      await engine.audio.renderMix(
        t.project({ stemAssets: { drums: corrupt }, flags: { vocals: { muted: true } } }).project,
        cache,
        range,
        t.sr,
      )
      return { plainPeak: t.hits(plain)[0].peak, error: null }
    } catch (error) {
      const e = error as { name: string; code: string; message: string }
      return {
        plainPeak: t.hits(plain)[0].peak,
        error: { name: e.name, code: e.code, message: e.message, cached: cache.error(corrupt.id)?.code },
      }
    }
  })
  expect(r.plainPeak).toBeGreaterThan(0.8)
  expect(r.error).toMatchObject({ name: 'JobError', code: 'decode', cached: 'decode' })
  expect(r.error?.message).toContain('The stems could not be loaded for the export')
})

test('playback keeps the mix while stems decode, then switches without a jump; a bad stem plays the mix and reports why', async ({
  page,
}) => {
  await setupStems(page)
  const r = await page.evaluate(async () => {
    const { engine, media } = window.mvStudio
    const t = window.stemTest
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    // A media source whose stems arrive only when the test says so.
    const slow = {
      getFile: async (asset: { origin: { type: string } }) => {
        if (asset.origin.type === 'stem') await gate
        return media.mediaStore.getFile(asset)
      },
    }
    const clock = new engine.WebAudioPlaybackClock(slow)
    const ids = () => clock.scheduledClips.map((c: { clipId: string }) => c.clipId)
    const { project, clipId } = t.project({})
    clock.setProject(project)
    await clock.play()
    const before = ids()
    const muted = structuredClone(project)
    for (const track of muted.tracks) if (track.kind === 'audio') track.stems = { vocals: { muted: true } }
    clock.setProject(muted)
    await sleep(400)
    const whileDecoding = ids()
    const times: number[] = []
    release()
    const deadline = performance.now() + 3000
    while (!ids().some((id: string) => id.includes(':stem:')) && performance.now() < deadline) {
      times.push(clock.currentTime())
      await sleep(5)
    }
    for (let i = 0; i < 20; i++) {
      times.push(clock.currentTime())
      await sleep(5)
    }
    const after = ids()
    clock.dispose()

    // A stem that cannot be decoded: the full mix plays and the clock says why.
    const drums = t.stems.drums
    const corrupt = { ...drums, id: `corrupt-${drums.id}`, storageKey: `${drums.storageKey}-corrupt` }
    await media.mediaStore.restore(corrupt, new Blob([new Uint8Array(4096).fill(7)]))
    const failing = new engine.WebAudioPlaybackClock({ getFile: (a: object) => media.mediaStore.getFile(a) })
    const errors: { code: string; message: string }[] = []
    failing.onAudioError((e: { code: string; message: string }) =>
      errors.push({ code: e.code, message: e.message }),
    )
    const bad = t.project({ stemAssets: { drums: corrupt }, flags: { vocals: { muted: true } } })
    failing.setProject(bad.project)
    await failing.play()
    await sleep(100)
    const fallback = failing.scheduledClips.map((c: { clipId: string }) => c.clipId)
    const state = failing.state
    failing.dispose()
    return { clipId, before, whileDecoding, after, times, errors, fallback, badClipId: bad.clipId, state }
  })
  console.log('clock', JSON.stringify({ ...r, times: r.times.length }))
  expect(r.before).toEqual([r.clipId])
  expect(r.whileDecoding).toEqual([r.clipId])
  expect(r.after).toEqual(['drums', 'bass', 'other'].map((s) => `${r.clipId}:stem:${s}`))
  // The clock never steps back or stalls across the switch.
  const steps = r.times.slice(1).map((t: number, i: number) => t - r.times[i])
  expect(Math.min(...steps)).toBeGreaterThanOrEqual(0)
  expect(r.times[r.times.length - 1] - r.times[0]).toBeGreaterThan(0.08)
  expect(r.errors).toHaveLength(1)
  expect(r.errors[0].code).toBe('decode')
  expect(r.fallback).toEqual([r.badClipId])
  expect(r.state).toBe('playing')
})

test('Play starts at once on the song while newly soloed stems decode, then switches to them', async ({
  page,
}) => {
  await setupStems(page)
  const r = await page.evaluate(async () => {
    const { engine, media } = window.mvStudio
    const t = window.stemTest
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    // Stems take 1.5 s to arrive, like the stems of a long song decoding.
    const slow = {
      getFile: async (asset: { origin: { type: string } }) => {
        if (asset.origin.type === 'stem') await sleep(1500)
        return media.mediaStore.getFile(asset)
      },
    }
    const clock = new engine.WebAudioPlaybackClock(slow)
    const ids = () => clock.scheduledClips.map((c: { clipId: string }) => c.clipId)
    const { project, clipId } = t.project({})
    clock.setProject(project)
    // The song is decoded and the audio running, as after editing for a while; then the user solos the vocals.
    await clock.play()
    clock.pause()
    const soloed = structuredClone(project)
    for (const track of soloed.tracks) if (track.kind === 'audio') track.stems = { vocals: { solo: true } }
    clock.setProject(soloed)
    const t0 = performance.now()
    await clock.play()
    const startMs = performance.now() - t0
    const atStart = ids()
    const state = clock.state
    const deadline = performance.now() + 5000
    while (!ids().some((id: string) => id.includes(':stem:')) && performance.now() < deadline) await sleep(20)
    const after = ids()
    clock.dispose()
    return { clipId, startMs, atStart, state, after }
  })
  console.log('play while stems decode', JSON.stringify(r))
  expect(r.state).toBe('playing')
  expect(r.startMs).toBeLessThan(100)
  expect(r.atStart).toEqual([r.clipId])
  expect(r.after).toEqual([`${r.clipId}:stem:vocals`])
})
