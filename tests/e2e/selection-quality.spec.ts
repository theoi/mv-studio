import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * Click-to-select quality on real footage (not part of CI): follows a clicked object through moving clips with the
 * real MagicTouch selector, measures mask stability and dropouts, renders contact sheets with the mask over the
 * frames, and renders text behind the selected object through the export compositor.
 *
 *   node scripts/fetch-vision-fixtures.mjs && npm run build
 *   SELECTION_QUALITY=1 [SELECTION_LABEL=after] npx playwright test tests/e2e/selection-quality.spec.ts
 *
 * Output: tests/fixtures/.cache/selection-review/<label>/<scene>.jpg, <scene>-export.jpg and metrics.json (outside
 * test-results, which Playwright empties on every run, so labels can be compared).
 */
// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

interface Scene {
  name: string
  source: string
  start: number
  duration: number
  crop?: string
  /** Click time within the segment and normalized points. */
  click: { t: number; points: { x: number; y: number }[] }
  /** Extra clicks at other times, for the correction-click check. */
  corrections?: { t: number; points: { x: number; y: number }[] }[]
  what: string
  /** Where the text goes for the export check (normalized), if this scene gets one. */
  textY?: number
  textX?: number
  /** Export render times (seconds), default spread over the clip. */
  exportTimes?: number[]
}

const SCENES: Scene[] = [
  {
    name: 'dance_tree',
    source: 'people_dance',
    start: 0,
    duration: 8,
    crop: '540:480:90:0',
    click: { t: 0, points: [{ x: 0.405, y: 0.5 }] },
    what: 'tree trunk: the camera pans and dancers walk in front of it',
    textY: 0.5,
  },
  {
    name: 'dance_dancer',
    source: 'people_dance',
    start: 4,
    duration: 8,
    crop: '540:480:90:0',
    click: { t: 0, points: [{ x: 0.925, y: 0.62 }] },
    what: 'dancer in black walking across the square past other dancers',
  },
  {
    name: 'city_car',
    source: 'city_street',
    start: 36,
    duration: 6,
    click: { t: 0, points: [{ x: 0.64, y: 0.66 }] },
    what: 'parked silver car: handheld walking camera, a black car in front, then it leaves the frame',
  },
  {
    name: 'city_green',
    source: 'city_street',
    start: 80,
    duration: 5,
    click: { t: 2, points: [{ x: 0.19, y: 0.48 }] },
    what: 'man in green pushing a pram: walking camera, a man in front of him, then he leaves the frame',
    textX: 0.3,
    textY: 0.5,
    exportTimes: [0.5, 1.2, 2.5, 4, 4.95],
  },
  {
    name: 'city_green_fix',
    source: 'city_street',
    start: 80,
    duration: 5,
    click: { t: 2, points: [{ x: 0.19, y: 0.48 }] },
    corrections: [{ t: 0.5, points: [{ x: 0.336, y: 0.58 }] }],
    what: 'the same with a correction click at 0.5 s, where the man in green stands behind the man in front',
    textX: 0.3,
    textY: 0.5,
    exportTimes: [0.5, 1.2, 2.5, 4, 4.95],
  },
  {
    name: 'rain_umbrella',
    source: 'rain_street',
    start: 0,
    duration: 5.5,
    click: { t: 0.5, points: [{ x: 0.56, y: 0.2 }] },
    what: 'umbrella (not a person): slow dolly in heavy rain',
    textY: 0.24,
  },
]

const VISION = path.join(FIXTURE_DIR, 'vision')
const CUTS = path.join(FIXTURE_DIR, 'selection')
const LABEL = process.env.SELECTION_LABEL ?? 'run'
const ONLY = process.env.SELECTION_SCENES?.split(',')
const OUT = path.join(FIXTURE_DIR, 'selection-review', LABEL)

function cut(scene: Scene): string {
  mkdirSync(CUTS, { recursive: true })
  const out = path.join(CUTS, `${scene.name}.webm`)
  if (!existsSync(out)) {
    execFileSync('ffmpeg', [
      ...['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(scene.start)],
      ...['-i', path.join(VISION, `${scene.source}.source.webm`), '-t', String(scene.duration), '-an'],
      ...(scene.crop ? ['-vf', `crop=${scene.crop}`] : []),
      ...['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-row-mt', '1'],
      out,
    ])
  }
  return out
}

function save(dataUrl: string, file: string) {
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1]!, 'base64'))
}

async function runScene(page: Page, scene: Scene) {
  await page.setInputFiles('#e2e-file-input', [cut(scene)])
  return page.evaluate(async (scene: Scene) => {
    const { model, media, testing, vision } = window.mvStudio
    const [file] = window.mvStudio.files() as File[]
    const asset = await media.mediaStore.importFile(file)
    const source = vision.createAssetFrameSource(asset, media.mediaStore)
    const backends = vision.createWorkerBackends()
    const service = vision.createVisionService({ backends, cache: vision.createMemoryCache() })
    const t0 = performance.now()
    const result: Untyped = await service.selectionTrack(source, scene.click, {
      fps: 10,
      ...(scene.corrections ? { corrections: scene.corrections } : {}),
    })
    const ms = performance.now() - t0
    const track = result.track
    const reader = vision.createTrackReader(track)
    const { frameCount, fps, start, lostFrames } = track.meta
    const lost = new Set<number>(lostFrames ?? [])

    const area = (m: { data: Uint8Array }) => {
      let n = 0
      for (const v of m.data) if (v >= 128) n++
      return n / m.data.length
    }
    const iou = (a: { data: Uint8Array }, b: { data: Uint8Array }) => {
      let inter = 0
      let union = 0
      for (let i = 0; i < a.data.length; i++) {
        const x = a.data[i]! >= 128
        const y = b.data[i]! >= 128
        if (x && y) inter++
        if (x || y) union++
      }
      return union ? inter / union : 1
    }
    const coverage: number[] = []
    const ious: (number | null)[] = []
    for (let i = 0; i < frameCount; i++) {
      coverage.push(area(reader.frame(i)))
      if (i > 0)
        ious.push(
          lost.has(i) || lost.has(i - 1) || !coverage[i] || !coverage[i - 1]
            ? null
            : iou(reader.frame(i - 1), reader.frame(i)),
        )
    }
    const valid = ious.filter((v): v is number => v !== null).sort((a, b) => a - b)
    const q = (p: number) =>
      valid.length ? valid[Math.min(valid.length - 1, Math.floor(p * valid.length))]! : 0
    const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0

    // Contact sheet: fifteen frames with the mask tinted by state (magenta tracking, orange uncertain, red lost,
    // grey out of frame), then a strip with IoU (green), area (blue) and lost (red).
    const states: string[] = result.states ?? []
    const stateOf = (i: number) => states[i] ?? (lost.has(i) ? 'lost' : 'tracking')
    const TINT: Record<string, [number, number, number]> = {
      tracking: [255, 0, 220],
      uncertain: [255, 150, 0],
      lost: [255, 60, 60],
      'out-of-frame': [150, 150, 150],
    }
    const W = 320
    const H = Math.round((W * source.height) / source.width)
    const cols = 5
    const rows = 3
    const picks = Array.from({ length: cols * rows }, (_, k) =>
      Math.round((k * (frameCount - 1)) / (cols * rows - 1)),
    )
    const stripH = 90
    const sheet = new OffscreenCanvas(cols * W, rows * (H + 18) + stripH)
    const ctx = sheet.getContext('2d')!
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    const tint = (m: { width: number; height: number; data: Uint8Array }, rgb: [number, number, number]) => {
      const img = new ImageData(m.width, m.height)
      for (let i = 0; i < m.data.length; i++) {
        if (m.data[i]! < 128) continue
        img.data[i * 4] = rgb[0]
        img.data[i * 4 + 1] = rgb[1]
        img.data[i * 4 + 2] = rgb[2]
        img.data[i * 4 + 3] = 130
      }
      const c = new OffscreenCanvas(m.width, m.height)
      c.getContext('2d')!.putImageData(img, 0, 0)
      return c
    }
    for (const [k, i] of picks.entries()) {
      const t = start + i / fps
      const x = (k % cols) * W
      const y = Math.floor(k / cols) * (H + 18)
      const frame = await source.frameAt(t, { maxSide: W })
      ctx.drawImage(frame, x, y, W, H)
      frame.close()
      const state = stateOf(i)
      ctx.drawImage(tint(reader.frame(i), TINT[state] ?? TINT.lost!), x, y, W, H)
      for (const [color, c] of [
        ['#ff0', scene.click],
        ...(scene.corrections ?? []).map((c) => ['#0ff', c] as const),
      ] as const) {
        if (Math.abs(t - c.t) >= 0.5 / fps) continue
        ctx.strokeStyle = color
        ctx.lineWidth = 3
        for (const p of c.points) {
          ctx.beginPath()
          ctx.arc(x + p.x * W, y + p.y * H, 7, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
      ctx.fillStyle = state === 'tracking' ? '#ddd' : '#f96'
      ctx.font = '13px sans-serif'
      const iouHere = i > 0 ? ious[i - 1] : null
      const label = state === 'tracking' ? '' : `${state.toUpperCase()}  `
      ctx.fillText(
        `${t.toFixed(1)} s  ${label}area ${(coverage[i]! * 100).toFixed(1)}%${iouHere != null ? `  IoU ${iouHere.toFixed(2)}` : ''}`,
        x + 4,
        y + H + 14,
      )
    }
    const sy = rows * (H + 18)
    const sw = sheet.width
    const maxArea = Math.max(...coverage, 1e-6)
    for (let i = 0; i < frameCount; i++) {
      if (!lost.has(i)) continue
      ctx.fillStyle = 'rgba(255,60,60,0.45)'
      ctx.fillRect((i / frameCount) * sw, sy, sw / frameCount + 1, stripH)
    }
    const line = (values: (number | null)[], color: string, scale: number, offset: number) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      let pen = false
      values.forEach((v, i) => {
        const px = ((i + offset) / frameCount) * sw
        if (v === null) {
          pen = false
          return
        }
        const py = sy + stripH - 6 - (v / scale) * (stripH - 12)
        if (pen) ctx.lineTo(px, py)
        else ctx.moveTo(px, py)
        pen = true
      })
      ctx.stroke()
    }
    line(coverage, '#4af', maxArea, 0)
    line(ious, '#4f4', 1, 1)
    ctx.fillStyle = '#ddd'
    ctx.font = '13px sans-serif'
    ctx.fillText(`${scene.name}: IoU between frames (green, 0..1), mask area (blue), lost (red)`, 6, sy + 14)
    const toUrl = async (c: OffscreenCanvas) => {
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `data:image/jpeg;base64,${btoa(s)}`
    }
    const sheetUrl = await toUrl(sheet)

    // Text behind the selected object, rendered by the export compositor from the encoded mask video.
    let exportUrl: string | undefined
    if (scene.textY !== undefined) {
      const blob = await vision.encodeMaskVideo(track, { duration: asset.duration })
      const maskAsset = await media.mediaStore.storeBlob(blob, vision.maskAssetInfo(asset, blob))
      const p = model.createProject({ name: scene.name, aspect: '16:9' })
      p.assets[asset.id] = asset
      p.assets[maskAsset.id] = maskAsset
      const footage = p.tracks.find((t: Untyped) => t.kind === 'visual')
      const textTrack = model.createTrack('visual', 'Lyrics')
      const subject = model.createTrack('visual', 'Subject')
      p.tracks = [subject, textTrack, ...p.tracks]
      const base = model.createVideoClip({
        trackId: footage.id,
        assetId: asset.id,
        start: 0,
        duration: asset.duration,
      })
      const text = model.createTextClip({
        trackId: textTrack.id,
        text: 'BEHIND IT',
        start: 0,
        duration: asset.duration,
        style: { fontSize: 230, color: '#ffe14a' },
      })
      text.transform.y.value = scene.textY
      if (scene.textX !== undefined) text.transform.x.value = scene.textX
      const cutout = {
        ...structuredClone(base),
        id: 'cutout',
        trackId: subject.id,
        matte: { maskAssetId: maskAsset.id, sourceAssetId: asset.id, mode: 'inside', feather: 0.15 },
      }
      p.clips = { [base.id]: base, [text.id]: text, cutout }
      const EW = 480
      const EH = 270
      const { compositor } = testing.createCompositor('export', EW, EH)
      const times = scene.exportTimes ?? [0.2, 0.3, 0.5, 0.7, 0.9].map((f) => f * asset.duration)
      const out = new OffscreenCanvas(times.length * EW, EH + 18)
      const octx = out.getContext('2d')!
      octx.fillStyle = '#111'
      octx.fillRect(0, 0, out.width, out.height)
      for (const [k, t] of times.entries()) {
        await compositor.render(p, t)
        octx.drawImage(compositor.canvas, k * EW, 0, EW, EH)
        octx.fillStyle = '#ddd'
        octx.font = '13px sans-serif'
        octx.fillText(`export render ${t.toFixed(1)} s`, k * EW + 4, EH + 14)
      }
      compositor.dispose()
      exportUrl = await toUrl(out)
    }
    backends.dispose()
    source.dispose()
    return {
      scene: scene.name,
      what: scene.what,
      ms: Math.round(ms),
      frames: frameCount,
      lostFrames: lost.size,
      lostPercent: +((100 * lost.size) / frameCount).toFixed(1),
      emptyFrames: coverage.filter((c) => c === 0).length,
      stateFrames: Object.fromEntries(
        Object.keys(TINT).map((s) => [
          s,
          Array.from({ length: frameCount }, (_, i) => stateOf(i)).filter((x) => x === s).length,
        ]),
      ),
      iou: {
        mean: +mean.toFixed(3),
        median: +q(0.5).toFixed(3),
        p10: +q(0.1).toFixed(3),
        min: +q(0).toFixed(3),
      },
      jumps: valid.filter((v) => v < 0.5).length,
      spans: result.spans ?? null,
      needsCorrection: result.needsCorrection ?? null,
      sheetUrl,
      exportUrl,
    }
  }, scene)
}

test('click-to-select follows objects through moving real footage', async ({ page }) => {
  test.skip(!process.env.SELECTION_QUALITY, 'set SELECTION_QUALITY=1 to run the selection quality review')
  test.setTimeout(SCENES.length * 300_000)
  const scenes = SCENES.filter((s) => !ONLY || ONLY.includes(s.name))
  for (const s of new Set(scenes.map((s) => s.source)))
    expect(existsSync(path.join(VISION, `${s}.source.webm`)), `${s} missing`).toBe(true)
  mkdirSync(OUT, { recursive: true })
  await openHarness(page)
  const file = path.join(OUT, 'metrics.json')
  const metrics: { scene: string }[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  for (const scene of scenes) {
    const { sheetUrl, exportUrl, ...m } = await runScene(page, scene)
    save(sheetUrl, path.join(OUT, `${scene.name}.jpg`))
    if (exportUrl) save(exportUrl, path.join(OUT, `${scene.name}-export.jpg`))
    console.log('selection', JSON.stringify(m))
    const at = metrics.findIndex((x) => x.scene === m.scene)
    if (at >= 0) metrics[at] = m
    else metrics.push(m)
  }
  metrics.sort(
    (a, b) => SCENES.findIndex((s) => s.name === a.scene) - SCENES.findIndex((s) => s.name === b.scene),
  )
  writeFileSync(file, JSON.stringify(metrics, null, 2) + '\n')
})
