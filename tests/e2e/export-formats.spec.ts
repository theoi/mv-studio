import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Download } from '@playwright/test'
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

interface TitlePlacement {
  box: { left: number; right: number; top: number; bottom: number }
  heightPx: number
  safe: { top: number; right: number; bottom: number; left: number }
}

test('one job exports 16:9, 9:16, 1:1 and 4:5 files, each with the title inside its safe area', async ({
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
    const { model, media, exporting, testing } = window.mvStudio
    const [song, video] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const p = model.createProject({ name: 'Formats' })
    p.assets[song.id] = song
    p.assets[video.id] = video
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visual = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const titleTrack = model.createTrack('visual', 'Titles')
    p.tracks.unshift(titleTrack)
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: 2,
    })
    const shot = model.createVideoClip({ trackId: visual.id, assetId: video.id, start: 0, duration: 2 })
    shot.muted = true
    const title = model.createTextClip({
      trackId: titleTrack.id,
      text: 'Under the neon skyline we run',
      start: 0,
      duration: 2,
      style: { fontSize: 72, color: '#ff00ff' },
    })
    title.transform.y = { value: 0.88 }
    for (const c of [songClip, shot, title]) p.clips[c.id] = c

    const specs = ['16:9', '9:16', '1:1', '4:5'].map((aspect) =>
      exporting.newOutput(p, 'video', { aspect, resolution: '720p' }),
    )
    // Where the title lands in each format: the pixels that change when the title is removed.
    const titles: Record<string, TitlePlacement> = {}
    for (const spec of specs) {
      const planned = exporting.planOutput(p, spec)
      const { width, height } = planned.settings
      const { compositor } = testing.createCompositor('export', width, height)
      await compositor.render(planned.project, 1)
      const withTitle = testing.readPixels(compositor.canvas, width, height)
      const { [title.id]: _removed, ...rest } = planned.project.clips
      await compositor.render({ ...planned.project, clips: rest }, 1)
      const without = testing.readPixels(compositor.canvas, width, height)
      compositor.dispose()
      let [left, top, right, bottom] = [width, height, 0, 0]
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          const d =
            Math.abs(withTitle[i] - without[i]) +
            Math.abs(withTitle[i + 1] - without[i + 1]) +
            Math.abs(withTitle[i + 2] - without[i + 2])
          if (d > 60) {
            left = Math.min(left, x)
            right = Math.max(right, x)
            top = Math.min(top, y)
            bottom = Math.max(bottom, y)
          }
        }
      titles[spec.aspect] = {
        box: { left: left / width, right: right / width, top: top / height, bottom: bottom / height },
        heightPx: bottom - top,
        safe: exporting.SAFE_AREAS[spec.aspect],
      }
    }

    const progress: number[] = []
    const job = exporting.startExport(p, specs)
    job.subscribe((s: { progress: { fraction?: number } }) => progress.push(s.progress.fraction ?? 0))
    const results: { file: File; spec: { aspect: string } }[] = await job.promise
    for (const result of results) {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(result.file)
      link.download = result.file.name
      document.body.appendChild(link)
      link.click()
    }
    return {
      kind: job.snapshot().kind,
      files: results.map((x) => ({
        name: x.file.name,
        aspect: x.spec.aspect,
        size: x.file.size,
      })),
      titles,
      lastProgress: progress[progress.length - 1],
      monotonic: progress.every((f, i) => i === 0 || f >= progress[i - 1]! - 1e-9),
    }
  })
  console.log('formats', JSON.stringify(r))
  expect(r.kind).toBe('export.outputs')
  expect(r.files.map((f) => f.name)).toEqual([
    'Formats.mp4',
    'Formats - Vertical.mp4',
    'Formats - Square.mp4',
    'Formats - Portrait.mp4',
  ])
  expect(r.lastProgress).toBe(1)
  expect(r.monotonic).toBe(true)

  await expect.poll(() => downloads.length).toBe(4)
  const sizes: Record<string, [number, number]> = {
    '16:9': [1280, 720],
    '9:16': [720, 1280],
    '1:1': [720, 720],
    '4:5': [720, 900],
  }
  for (const d of downloads) {
    const out = testInfo.outputPath(d.suggestedFilename())
    await d.saveAs(out)
    const aspect = r.files.find((f) => f.name === d.suggestedFilename())!.aspect
    const p = probe(out)
    expect(p.video, aspect).toMatchObject({
      codec_name: 'h264',
      width: sizes[aspect]![0],
      height: sizes[aspect]![1],
      nb_read_frames: '60',
    })
    expect(p.audio, aspect).toMatchObject({ codec_name: 'aac' })
    expect(p.duration, aspect).toBeCloseTo(2, 1)
  }

  for (const [aspect, t] of Object.entries(r.titles)) {
    // The title is drawn, and all of it is inside the safe area (anti-aliasing allowed).
    expect(t.heightPx, aspect).toBeGreaterThan(20)
    expect(t.box.left, aspect).toBeGreaterThanOrEqual(t.safe.left - 0.01)
    expect(t.box.right, aspect).toBeLessThanOrEqual(1 - t.safe.right + 0.01)
    expect(t.box.top, aspect).toBeGreaterThanOrEqual(t.safe.top - 0.01)
    expect(t.box.bottom, aspect).toBeLessThanOrEqual(1 - t.safe.bottom + 0.01)
  }
})
