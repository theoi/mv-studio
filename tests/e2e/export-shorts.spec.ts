import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Download, Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

function probe(file: string) {
  const json = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  )
  const video = json.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
  const audio = json.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
  return { video, audio, duration: Number(json.format.duration) }
}

/** Every frame of the file, decoded as small gray images. */
function grayFrames(file: string, width: number, height: number): Uint8Array[] {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `scale=${width}:${height},format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 256 * 1024 * 1024 },
  )
  const size = width * height
  return Array.from({ length: raw.length / size }, (_, i) => raw.subarray(i * size, (i + 1) * size))
}

/** The left channel of the audio, at `rate`. */
function samples(file: string, rate: number): Float32Array {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-af', 'pan=mono|c0=c0', '-ar', String(rate), '-f', 'f32le', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length))
}

const mean = (frame: Uint8Array) => frame.reduce((a, b) => a + b, 0) / frame.length
const diff = (a: Uint8Array, b: Uint8Array) =>
  a.reduce((sum, x, i) => sum + Math.abs(x - b[i]!), 0) / a.length
const rms = (x: Float32Array, from: number, to: number) => {
  const part = x.subarray(Math.max(0, from), Math.min(x.length, to))
  return Math.sqrt(part.reduce((a, b) => a + b * b, 0) / Math.max(1, part.length))
}

async function saveDownloads(
  page: Page,
  downloads: Download[],
  count: number,
  outputPath: (f: string) => string,
) {
  await expect.poll(() => downloads.length).toBe(count)
  const files: Record<string, string> = {}
  for (const d of downloads) {
    const out = outputPath(d.suggestedFilename())
    await d.saveAs(out)
    files[d.suggestedFilename()] = out
  }
  void page
  return files
}

test('a chorus teaser renders the loudest chorus, on bars, fading in and out', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  await openHarness(page)
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  const r = await page.evaluate(async () => {
    const { model, media, exporting } = window.mvStudio
    // A 40 s, 120 BPM "song": a quiet verse with a soft chorus at 4-12 s and a loud one at 20-36 s.
    const rate = 22050
    const seconds = 40
    const level = (t: number) => (t >= 20 && t < 36 ? 0.8 : t >= 4 && t < 12 ? 0.4 : 0.15)
    const pcm = new Int16Array(rate * seconds)
    for (let i = 0; i < pcm.length; i++) {
      const t = i / rate
      pcm[i] = Math.round(32767 * level(t) * Math.sin(2 * Math.PI * 220 * t))
    }
    const header = new DataView(new ArrayBuffer(44))
    const ascii = (at: number, s: string) =>
      [...s].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)))
    ascii(0, 'RIFF')
    header.setUint32(4, 36 + pcm.byteLength, true)
    ascii(8, 'WAVEfmt ')
    header.setUint32(16, 16, true)
    header.setUint16(20, 1, true)
    header.setUint16(22, 1, true)
    header.setUint32(24, rate, true)
    header.setUint32(28, rate * 2, true)
    header.setUint16(32, 2, true)
    header.setUint16(34, 16, true)
    ascii(36, 'data')
    header.setUint32(40, pcm.byteLength, true)
    const file = new File([header.buffer, pcm.buffer], 'long-song.wav', { type: 'audio/wav' })
    const song = await media.mediaStore.importFile(file)

    const p = model.createProject({ name: 'Teaser' })
    p.assets[song.id] = song
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: seconds,
    })
    const white = model.createSolidClip({ trackId: visual.id, color: '#ffffff', start: 0, duration: seconds })
    p.clips[songClip.id] = songClip
    p.clips[white.id] = white
    const beats = Array.from({ length: seconds * 2 + 1 }, (_, i) => i / 2)
    p.analysis.audio[song.id] = {
      assetId: song.id,
      version: 'e2e',
      tempo: { bpm: 120, confidence: 1 },
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
      sections: [
        { id: 'a', start: 0, end: 4, label: 'intro', energy: 0.15 },
        { id: 'b', start: 4, end: 12, label: 'chorus', repeatGroup: 2, energy: 0.4 },
        { id: 'c', start: 12, end: 20, label: 'verse', repeatGroup: 1, energy: 0.15 },
        { id: 'd', start: 20, end: 36, label: 'chorus', repeatGroup: 2, energy: 0.8 },
        { id: 'e', start: 36, end: 40, label: 'outro', energy: 0.15 },
      ],
    }

    const spec = exporting.newOutput(p, 'teaser', { resolution: '720p', fps: 15 })
    const planned = exporting.planOutput(p, spec)
    const [result] = await exporting.startExport(p, [spec]).promise
    const link = document.createElement('a')
    link.href = URL.createObjectURL(result.file)
    link.download = result.file.name
    document.body.appendChild(link)
    link.click()
    return {
      name: result.file.name,
      range: planned.range,
      teaser: planned.teaser,
      duration: result.durationSeconds,
    }
  })
  console.log('teaser', JSON.stringify(r))
  expect(r.name).toBe('Teaser - Teaser.mp4')
  expect(r.teaser).toMatchObject({ start: 20, end: 36, source: 'chorus', label: 'chorus' })
  expect(r.range).toEqual({ start: 20, end: 36 })

  const files = await saveDownloads(page, downloads, 1, (f) => testInfo.outputPath(f))
  const file = files[r.name]!
  const p = probe(file)
  expect(p.video).toMatchObject({ codec_name: 'h264', width: 720, height: 1280, nb_read_frames: '240' })
  expect(p.audio).toMatchObject({ codec_name: 'aac' })
  expect(p.duration).toBeGreaterThanOrEqual(15)
  expect(p.duration).toBeLessThanOrEqual(30)
  expect(p.duration).toBeCloseTo(16, 1)

  // Video fades from black over 0.3 s and to black over the last 0.6 s.
  const frames = grayFrames(file, 36, 64).map(mean)
  console.log('teaser luma', frames.slice(0, 6).map(Math.round), frames.slice(-6).map(Math.round))
  expect(frames).toHaveLength(240)
  expect(frames[0]).toBeLessThan(40)
  expect(frames[2]).toBeGreaterThan(40)
  expect(frames[2]).toBeLessThan(215)
  expect(frames[30]).toBeGreaterThan(215)
  expect(frames[200]).toBeGreaterThan(215)
  expect(frames[239]).toBeLessThan(60)

  // The audio is the loud chorus (not the soft one or the verse), faded in over 0.25 s and out over 1 s.
  const rate = 8000
  const audio = samples(file, rate)
  const body = rms(audio, 2 * rate, 14 * rate)
  console.log(
    'teaser rms',
    body,
    rms(audio, 0, 0.025 * rate),
    rms(audio, audio.length - 0.05 * rate, audio.length),
  )
  expect(body).toBeGreaterThan(0.45)
  expect(body).toBeLessThan(0.7)
  expect(rms(audio, 0, 0.025 * rate) / body).toBeLessThan(0.3)
  expect(rms(audio, audio.length - 0.05 * rate, audio.length) / body).toBeLessThan(0.2)
  expect(rms(audio, 15 * rate - 0.05 * rate, 15 * rate) / body).toBeGreaterThan(0.6)
})

test('a Canvas loop is 2-8 bars of vertical video whose last frame leads into its first', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  const r = await page.evaluate(async () => {
    const { model, media, exporting } = window.mvStudio
    const [song, video] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const p = model.createProject({ name: 'Shorts' })
    p.assets[song.id] = song
    p.assets[video.id] = video
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: 8,
    })
    // Footage from 1 s to 5 s, then black: a plain cut from the end of the loop to its start would jump.
    const shot = model.createVideoClip({ trackId: visual.id, assetId: video.id, start: 1, duration: 4 })
    shot.muted = true
    for (const c of [songClip, shot]) p.clips[c.id] = c
    const beats = Array.from({ length: 17 }, (_, i) => i / 2)
    p.analysis.audio[song.id] = {
      assetId: song.id,
      version: 'e2e',
      tempo: { bpm: 120, confidence: 1 },
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
    }

    const specs = [
      exporting.newOutput(p, 'loop', { resolution: '720p' }),
      exporting.newOutput(p, 'loop', { resolution: '720p', audio: true, name: 'Shorts - Canvas with audio' }),
    ]
    const planned = exporting.planOutput(p, specs[0])
    const results: { file: File }[] = await exporting.startExport(p, specs).promise
    for (const result of results) {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(result.file)
      link.download = result.file.name
      document.body.appendChild(link)
      link.click()
    }
    return { names: results.map((x) => x.file.name), loop: planned.loop }
  })
  console.log('loop', JSON.stringify(r))
  expect(r.names).toEqual(['Shorts - Canvas.mp4', 'Shorts - Canvas with audio.mp4'])
  expect(r.loop).toMatchObject({ start: 2, end: 6, bars: 2, crossfade: 0.5, barAligned: true })

  const files = await saveDownloads(page, downloads, 2, (f) => testInfo.outputPath(f))
  const silent = files['Shorts - Canvas.mp4']!
  const p = probe(silent)
  expect(p.video).toMatchObject({ codec_name: 'h264', width: 720, height: 1280, nb_read_frames: '120' })
  expect(p.audio).toBeUndefined()
  expect(p.duration).toBeCloseTo(4, 1)

  // Seam continuity: last frame to first frame changes about as much as one frame to the next, unlike the cut
  // a loop without the crossfade would make (black, after the footage ends, to footage).
  const frames = grayFrames(silent, 90, 160)
  expect(frames).toHaveLength(120)
  const steps = frames.slice(1).map((f, i) => diff(frames[i]!, f))
  const median = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]!
  const seam = diff(frames[119]!, frames[0]!)
  const cut = diff(frames[100]!, frames[0]!)
  console.log('loop seam', { seam, median, max: Math.max(...steps), cut })
  expect(cut).toBeGreaterThan(20)
  expect(seam).toBeLessThan(Math.max(3 * median, median + 2))
  expect(seam).toBeLessThan(cut / 5)

  const withAudio = files['Shorts - Canvas with audio.mp4']!
  const q = probe(withAudio)
  expect(q.video).toMatchObject({ width: 720, height: 1280, nb_read_frames: '120' })
  expect(q.audio).toMatchObject({ codec_name: 'aac' })
  expect(Number(q.audio.duration)).toBeCloseTo(4, 1)
  // The song plays through the seam: no fade to silence at either end.
  const rate = 8000
  const audio = samples(withAudio, rate)
  const body = rms(audio, rate, 3 * rate)
  expect(rms(audio, audio.length - 0.1 * rate, audio.length) / body).toBeGreaterThan(0.5)
  expect(rms(audio, 0, 0.1 * rate) / body).toBeGreaterThan(0.5)
})
