/**
 * Performance probes shared by the e2e benchmark (tests/e2e/perf.spec.ts) and the ?bench=1 page: representative
 * projects, preview frame delivery and main-thread responsiveness sampling, and export speed.
 */
import { exportProject } from '../engine/export.ts'
import { PreviewController, type PreviewQuality } from '../engine/preview.ts'
import { mediaStore } from '../media/mediaStore.ts'
import { ProjectEditor } from '../model/editor.ts'
import { jobs } from '../shared/jobs.ts'
import {
  anim,
  createAudioClip,
  createProject,
  createSolidClip,
  createTextClip,
  createTrack,
  createVideoClip,
} from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type { AdjustmentClip, Asset, GeneratorClip, Project, Track } from '../model/types.ts'
import type { ExportSettings } from '../engine/types.ts'

export interface BenchAssets {
  song: Asset
  /** A 1080p video. */
  hd: Asset
  /** A small (e.g. 640x360) video. */
  sd: Asset
}

/**
 * 1920x1080 project with four simultaneous video layers (two of them 1080p), a cross-fade, blend modes, effects,
 * colour adjustments, an audio-reactive visualizer, a looks-style adjustment clip and karaoke text with a preset.
 */
export function heavyProject({ song, hd, sd }: BenchAssets, duration = 8): Project {
  const p = createProject({ name: 'Bench' })
  for (const a of [song, hd, sd]) p.assets[a.id] = a
  p.songAssetId = song.id
  const audio = p.tracks.find((t) => t.kind === 'audio') as Track
  const track = (name: string) => createTrack('visual', name)
  const t = {
    text: track('Text'),
    look: track('Look'),
    viz: track('Visualizer'),
    pipA: track('PiP A'),
    pipB: track('PiP B'),
    overlay: track('Overlay'),
    base: track('Base'),
  }
  p.tracks = [t.text, t.look, t.viz, t.pipA, t.pipB, t.overlay, t.base, audio]
  const half = duration / 2
  const hdLen = hd.duration ?? half
  const sdLen = sd.duration ?? half

  const baseA = createVideoClip({ trackId: t.base.id, assetId: hd.id, start: 0, duration: half })
  baseA.adjustments = { contrast: anim(0.1), saturation: anim(0.15) }
  const baseB = createVideoClip({ trackId: t.base.id, assetId: hd.id, start: half, duration: half })
  baseB.transitionIn = { kind: 'fade', duration: 0.5, easing: 'linear' }

  const overlay = createVideoClip({ trackId: t.overlay.id, assetId: sd.id, start: 0, duration })
  overlay.playbackRate = sdLen / duration
  overlay.blendMode = 'overlay'
  overlay.opacity = anim(0.6)

  const pipA = createVideoClip({ trackId: t.pipA.id, assetId: hd.id, start: 0, duration })
  pipA.playbackRate = hdLen / duration
  pipA.transform.x = anim(0.74)
  pipA.transform.y = anim(0.3)
  pipA.transform.scaleX = anim(0.36)
  pipA.transform.scaleY = anim(0.36)
  pipA.transform.rotation = {
    value: 0,
    keyframes: [
      { time: 0, value: -6, easing: 'ease-in-out' },
      { time: duration, value: 6, easing: 'linear' },
    ],
  }
  pipA.effects = [{ id: 'rgb', effectId: 'rgb-split', enabled: true, params: {} }]
  pipA.meta = { bench: 'drag' }

  const pipB = createVideoClip({ trackId: t.pipB.id, assetId: sd.id, start: 0, duration })
  pipB.playbackRate = sdLen / duration
  pipB.transform.x = anim(0.26)
  pipB.transform.y = anim(0.68)
  pipB.transform.scaleX = anim(0.4)
  pipB.transform.scaleY = anim(0.4)
  pipB.blendMode = 'screen'
  pipB.effects = [{ id: 'glow', effectId: 'glow', enabled: true, params: {} }]

  const visual = visualBase(t.viz.id, duration)
  const viz: GeneratorClip = {
    ...visual,
    type: 'generator',
    generatorId: 'visualizer.spectrum',
    params: {},
    blendMode: 'add',
    opacity: anim(0.8),
  }
  const look = lookClip(t.look.id, duration, [
    { id: 'vig', effectId: 'vignette', enabled: true, params: {} },
    { id: 'grain', effectId: 'film-grain', enabled: true, params: {} },
  ])
  const title = lyricClip(t.text.id, 'Several video layers, effects and karaoke text', duration, 'pop')
  const songClip = createAudioClip({ trackId: audio.id, assetId: song.id, start: 0, duration })
  for (const c of [baseA, baseB, overlay, pipA, pipB, viz, look, title, songClip]) p.clips[c.id] = c
  return p
}

/**
 * A typical edit: cuts between full-screen shots with a cross-fade, a picture-in-picture clip with one effect for part
 * of the song, a look (colour adjustments and a vignette) and karaoke lyrics.
 */
export function typicalProject({ song, hd, sd }: BenchAssets, duration = 8): Project {
  const p = createProject({ name: 'Typical' })
  for (const a of [song, hd, sd]) p.assets[a.id] = a
  p.songAssetId = song.id
  const audio = p.tracks.find((t) => t.kind === 'audio') as Track
  const t = {
    text: createTrack('visual', 'Lyrics'),
    look: createTrack('visual', 'Look'),
    pip: createTrack('visual', 'PiP'),
    base: createTrack('visual', 'Shots'),
  }
  p.tracks = [t.text, t.look, t.pip, t.base, audio]
  const half = duration / 2
  const shotA = createVideoClip({ trackId: t.base.id, assetId: hd.id, start: 0, duration: half })
  const shotB = createVideoClip({ trackId: t.base.id, assetId: hd.id, start: half, duration: half })
  shotB.transitionIn = { kind: 'fade', duration: 0.5, easing: 'linear' }
  const pip = createVideoClip({ trackId: t.pip.id, assetId: sd.id, start: duration * 0.25, duration: half })
  pip.transform.x = anim(0.75)
  pip.transform.y = anim(0.3)
  pip.transform.scaleX = anim(0.35)
  pip.transform.scaleY = anim(0.35)
  pip.effects = [{ id: 'rgb', effectId: 'rgb-split', enabled: true, params: {} }]
  pip.meta = { bench: 'drag' }
  const look = lookClip(t.look.id, duration, [{ id: 'vig', effectId: 'vignette', enabled: true, params: {} }])
  look.adjustments = { contrast: anim(0.1), saturation: anim(0.1), temperature: anim(0.05) }
  const title = lyricClip(t.text.id, 'A typical project with lyrics on top', duration, 'fade-up')
  const songClip = createAudioClip({ trackId: audio.id, assetId: song.id, start: 0, duration })
  for (const c of [shotA, shotB, pip, look, title, songClip]) p.clips[c.id] = c
  return p
}

function visualBase(trackId: string, duration: number) {
  const { color: _color, ...visual } = createSolidClip({ trackId, color: '#000000', start: 0, duration })
  return visual
}

function lookClip(trackId: string, duration: number, effects: AdjustmentClip['effects']): AdjustmentClip {
  return {
    ...visualBase(trackId, duration),
    type: 'adjustment',
    adjustments: { exposure: anim(0.05), temperature: anim(0.1) },
    effects,
  }
}

function lyricClip(trackId: string, text: string, duration: number, presetId: string) {
  const title = createTextClip({
    trackId,
    text,
    start: 0,
    duration,
    style: {
      fontSize: 84,
      stroke: { color: '#000000', width: 4 },
      shadow: { color: '#00000099', blur: 12, offsetX: 0, offsetY: 4 },
    },
  })
  title.transform.y = anim(0.82)
  title.animation = { presetId, params: {} }
  title.karaoke = { highlightColor: '#ffd400', mode: 'word' }
  return title
}

const percentile = (values: number[], q: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number
}
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits

export interface MainThreadSample {
  seconds: number
  /** Animation frames per second the page got (60 when the main thread keeps up with a 60 Hz display). */
  rafFps: number
  rafP95Ms: number
  rafMaxMs: number
  /** Animation-frame gaps longer than 1.5 display frames. */
  missedFrames: number
  longTasks: number
  longTaskMaxMs: number
  longTaskTotalMs: number
  /** How late a 10 ms timer fires: the delay an input event would see. */
  inputDelayP95Ms: number
  inputDelayMaxMs: number
}

/** Samples main-thread responsiveness until stop() is called. */
export function sampleMainThread(): { stop(): MainThreadSample } {
  const started = performance.now()
  const raf: number[] = []
  let last = started
  let rafId = requestAnimationFrame(function tick(now) {
    raf.push(now - last)
    last = now
    rafId = requestAnimationFrame(tick)
  })
  const tasks: number[] = []
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) tasks.push(e.duration)
  })
  observer.observe({ type: 'longtask' })
  const delays: number[] = []
  let timer = 0
  const probe = () => {
    const due = performance.now() + 10
    timer = window.setTimeout(() => {
      delays.push(Math.max(0, performance.now() - due))
      probe()
    }, 10)
  }
  probe()
  return {
    stop() {
      cancelAnimationFrame(rafId)
      clearTimeout(timer)
      for (const e of observer.takeRecords()) tasks.push(e.duration)
      observer.disconnect()
      const seconds = (performance.now() - started) / 1000
      const intervals = raf.slice(1)
      const frame = percentile(intervals, 0.5) || 16.7
      return {
        seconds: round(seconds, 2),
        rafFps: round(intervals.length / seconds),
        rafP95Ms: round(percentile(intervals, 0.95)),
        rafMaxMs: round(Math.max(0, ...intervals)),
        missedFrames: intervals.filter((d) => d > frame * 1.5).length,
        longTasks: tasks.length,
        longTaskMaxMs: round(Math.max(0, ...tasks)),
        longTaskTotalMs: round(tasks.reduce((a, b) => a + b, 0)),
        inputDelayP95Ms: round(percentile(delays, 0.95)),
        inputDelayMaxMs: round(Math.max(0, ...delays)),
      }
    },
  }
}

export interface PreviewSample {
  canvas: [number, number]
  /** Render scale at the end of the measurement (below 1 when the preview lowered its resolution). */
  scale: number
  /** Preview frames drawn per second. */
  fps: number
  /** Percentiles of the interval between drawn frames. */
  frameP50Ms: number
  frameP95Ms: number
  frameP99Ms: number
  /** Mean main-thread time to issue a frame. */
  renderMs: number
  /** Animation frames skipped because the previous frame was still rendering. */
  dropped: number
  main: MainThreadSample
  /** Edits applied while measuring (one per animation frame, like a drag). */
  edits?: { count: number; applyMeanMs: number; applyMaxMs: number; responseP95Ms: number }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A host pinned to the top-left of the viewport. The canvas must be on screen: Chrome skips compositing off-screen
 * canvases, and compositing is where a software-composited (GPU-less) browser blocks the main thread on WebGL readback.
 */
function onScreenHost(): HTMLElement {
  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;'
  document.body.appendChild(host)
  return host
}

/**
 * Measures the preview for `seconds` in its current state (playing, or paused with `scrub` seeking every animation
 * frame). With `drag`, moves a clip every animation frame through the editor, like a timeline or canvas drag.
 */
export async function measurePreview(
  preview: PreviewController,
  options: {
    seconds: number
    scrub?: { from: number; to: number }
    drag?: { editor: ProjectEditor; clipId: string }
  },
): Promise<PreviewSample> {
  const frameTimes: number[] = []
  let editAt = 0
  const responses: number[] = []
  const off = preview.onFrame(() => {
    const now = performance.now()
    frameTimes.push(now)
    if (editAt) {
      responses.push(now - editAt)
      editAt = 0
    }
  })
  const droppedBefore = preview.stats().dropped
  const renderSamples: number[] = []
  const statsTimer = setInterval(() => {
    const s = preview.stats()
    if (s.fps > 0) renderSamples.push(s.renderMs)
  }, 250)
  const applies: number[] = []
  let running = true
  let step = 0
  const driver = () => {
    if (!running) return
    step++
    if (options.scrub) {
      const { from, to } = options.scrub
      const span = to - from
      preview.seek(from + ((step * 0.05) % span))
    }
    if (options.drag) {
      const { editor, clipId } = options.drag
      const t0 = performance.now()
      editor.dispatch(
        {
          type: 'clip.set',
          clipId,
          path: ['transform', 'x', 'value'],
          value: 0.5 + 0.25 * Math.sin(step / 10),
        },
        { coalesceKey: 'bench-drag' },
      )
      preview.setProject(editor.getProject())
      const t1 = performance.now()
      applies.push(t1 - t0)
      if (!editAt) editAt = t0
    }
    requestAnimationFrame(driver)
  }
  const main = sampleMainThread()
  const started = performance.now()
  if (options.scrub || options.drag) requestAnimationFrame(driver)
  await sleep(options.seconds * 1000)
  running = false
  options.drag?.editor.endGesture()
  await preview.rendered()
  const mainSample = main.stop()
  const elapsed = (performance.now() - started) / 1000
  clearInterval(statsTimer)
  off()
  const intervals = frameTimes.slice(1).map((t, i) => t - (frameTimes[i] as number))
  const stats = preview.stats()
  return {
    canvas: [stats.width, stats.height],
    scale: stats.scale,
    fps: round(frameTimes.length / elapsed),
    frameP50Ms: round(percentile(intervals, 0.5)),
    frameP95Ms: round(percentile(intervals, 0.95)),
    frameP99Ms: round(percentile(intervals, 0.99)),
    renderMs: round(mean(renderSamples), 2),
    dropped: preview.stats().dropped - droppedBefore,
    main: mainSample,
    edits: options.drag
      ? {
          count: applies.length,
          applyMeanMs: round(mean(applies), 2),
          applyMaxMs: round(Math.max(0, ...applies), 2),
          responseP95Ms: round(percentile(responses, 0.95)),
        }
      : undefined,
  }
}

export type BenchProjectKind = 'heavy' | 'typical'

export interface BenchScenario {
  project: BenchProjectKind
  /** Preview box in CSS pixels. */
  css: [number, number]
  dpr: number
  quality: PreviewQuality
  /** Also measure a clip drag during playback, and scrubbing while paused. */
  interact?: boolean
}

export interface BenchRow {
  project: BenchProjectKind
  viewport: string
  quality: PreviewQuality
  playing: PreviewSample
  dragging?: PreviewSample
  scrubbing?: PreviewSample
}

/**
 * Plays each scenario's project in a visible preview and measures it. One preview per project is reused across
 * scenarios, so 'auto' quality starts from the level it reached before (as it would in the app).
 */
export async function runPreviewBenchmark(options: {
  assets: BenchAssets
  scenarios: BenchScenario[]
  container?: HTMLElement
  warmupSeconds?: number
  seconds?: number
  /** Where the previews draw (PreviewOptions.renderer); default: the app's setting. */
  renderer?: 'main' | 'worker'
  onRow?: (row: BenchRow) => void
}): Promise<BenchRow[]> {
  const container = options.container ?? onScreenHost()
  const previews = new Map<
    BenchProjectKind,
    { editor: ProjectEditor; preview: PreviewController; canvas: HTMLCanvasElement; dragId?: string }
  >()
  const rows: BenchRow[] = []
  try {
    for (const sc of options.scenarios) {
      let entry = previews.get(sc.project)
      if (!entry) {
        const project = sc.project === 'heavy' ? heavyProject(options.assets) : typicalProject(options.assets)
        const editor = new ProjectEditor(project)
        const canvas = document.createElement('canvas')
        container.appendChild(canvas)
        const preview = new PreviewController({ canvas, media: mediaStore, renderer: options.renderer })
        preview.setProject(project)
        preview.setLoop({ start: 0, end: projectDuration(project) })
        const dragId = Object.values(project.clips).find((c) => c.meta?.bench === 'drag')?.id
        entry = { editor, preview, canvas, dragId }
        previews.set(sc.project, entry)
      }
      const { editor, preview, canvas, dragId } = entry
      for (const [kind, other] of previews)
        other.canvas.style.display = kind === sc.project ? 'block' : 'none'
      canvas.style.width = `${sc.css[0]}px`
      canvas.style.height = `${sc.css[1]}px`
      preview.setViewport(sc.css[0], sc.css[1], sc.dpr)
      preview.setQuality(sc.quality)
      preview.seek(0)
      await preview.rendered()
      await preview.play()
      await sleep((options.warmupSeconds ?? 2) * 1000)
      const playing = await measurePreview(preview, { seconds: options.seconds ?? 2.5 })
      const interact = sc.interact && dragId
      const dragging = interact
        ? await measurePreview(preview, { seconds: 1.5, drag: { editor, clipId: dragId } })
        : undefined
      preview.pause()
      const scrubbing = sc.interact
        ? await measurePreview(preview, { seconds: 1.5, scrub: { from: 0.5, to: 7.5 } })
        : undefined
      const row: BenchRow = {
        project: sc.project,
        viewport: `${sc.css[0]}x${sc.css[1]} @${sc.dpr}x`,
        quality: sc.quality,
        playing,
        dragging,
        scrubbing,
      }
      rows.push(row)
      options.onRow?.(row)
    }
  } finally {
    for (const { preview, canvas } of previews.values()) {
      preview.dispose()
      canvas.remove()
    }
    if (container !== options.container) container.remove()
  }
  return rows
}

export interface ExportBenchResult {
  project: BenchProjectKind
  size: string
  seconds: number
  /** Exported seconds per wall-clock second. */
  realtime: number
  main: MainThreadSample
}

/** Exports the first `seconds` of a bench project and samples main-thread responsiveness meanwhile. */
export async function runExportBenchmark(
  kind: BenchProjectKind,
  assets: BenchAssets,
  settings: { width: number; height: number; fps: number; seconds: number },
): Promise<ExportBenchResult> {
  const project = kind === 'heavy' ? heavyProject(assets) : typicalProject(assets)
  const exportSettings: ExportSettings = {
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    aspect: '16:9',
    range: { start: 0, end: settings.seconds },
  }
  const sampler = sampleMainThread()
  const started = performance.now()
  const job = jobs.run({
    kind: 'export.mp4',
    title: 'Benchmark export',
    run: (ctx) => exportProject(project, exportSettings, ctx),
  })
  await job.promise
  const elapsed = (performance.now() - started) / 1000
  return {
    project: kind,
    size: `${settings.width}x${settings.height}@${settings.fps}`,
    seconds: round(elapsed, 2),
    realtime: round(settings.seconds / elapsed, 3),
    main: sampler.stop(),
  }
}

/**
 * Beat-cut edit of one footage file, as splits and auto-cuts produce: contiguous pieces, jumps back and forth in the
 * source, and a freeze (rate 0). Each piece is its own clip, so each cut switches to a new clip id.
 */
export function cutProject({ song, footage }: { song: Asset; footage: Asset }): Project {
  const p = createProject({ name: 'Cuts' })
  p.assets[song.id] = song
  p.assets[footage.id] = footage
  p.songAssetId = song.id
  const audio = p.tracks.find((t) => t.kind === 'audio') as Track
  const visual = p.tracks.find((t) => t.kind === 'visual') as Track
  const shots: [start: number, duration: number, sourceStart: number, rate: number][] = [
    [0, 2, 0, 1],
    [2, 2, 2, 1],
    [4, 1, 0.5, 1],
    [5, 1, 3, 0],
    [6, 2, 1.5, 1],
  ]
  for (const [start, duration, sourceStart, rate] of shots) {
    const clip = createVideoClip({ trackId: visual.id, assetId: footage.id, start, duration, sourceStart })
    clip.playbackRate = rate
    p.clips[clip.id] = clip
  }
  const songClip = createAudioClip({ trackId: audio.id, assetId: song.id, start: 0, duration: 8 })
  p.clips[songClip.id] = songClip
  return p
}

export interface CutSample {
  at: number
  /** Extra time the cut's first frames took beyond a normal frame interval. */
  stallMs: number
  /** Frames within 0.2 s after the cut that showed a source frame more than two frames off. */
  wrongFrames: number
}

export interface CutsResult {
  frameMs: number
  cuts: CutSample[]
  maxStallMs: number
  meanStallMs: number
  wrongFrames: number
}

/**
 * Plays a cutProject() and measures each cut. The footage must encode its frame number N in gray levels at the top of
 * the frame (left half (N % 16) * 16 + 8, right half floor(N / 16) * 16 + 8), like the e2e fixture frames.mp4 and
 * syntheticVideo(..., { frameCode: true }).
 */
export async function measureCuts(
  project: Project,
  host?: HTMLElement,
  options: { renderer?: 'main' | 'worker' } = {},
): Promise<CutsResult> {
  const container = host ?? onScreenHost()
  const W = 480
  const H = 270
  const canvas = document.createElement('canvas')
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`
  container.appendChild(canvas)
  const preview = new PreviewController({
    canvas,
    media: mediaStore,
    preserveDrawingBuffer: true,
    renderer: options.renderer,
  })
  const reader = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })
  if (!reader) throw new Error('2D canvas is not available')
  const frameNumber = (frame: ImageBitmap) => {
    reader.drawImage(frame, 0, 0, W, H)
    frame.close()
    const y = Math.round(H * 0.03)
    const left = reader.getImageData(Math.round(W / 4), y, 1, 1).data
    const right = reader.getImageData(Math.round((3 * W) / 4), y, 1, 1).data
    const gray = (d: Uint8ClampedArray) => ((d[0] as number) + (d[1] as number) + (d[2] as number)) / 3
    return Math.round((gray(left) - 8) / 16) + 16 * Math.round((gray(right) - 8) / 16)
  }
  const fps = Object.values(project.assets).find((a) => a.kind === 'video')?.frameRate ?? 30
  const clips = Object.values(project.clips).filter((c) => c.type === 'video')
  const expected = (t: number) => {
    const c = clips.find((v) => t >= v.start && t < v.start + v.duration)
    return c ? Math.floor((c.sourceStart + (t - c.start) * c.playbackRate + 1e-4) * fps) : -1
  }
  const frames: { at: number; t: number; n: number }[] = []
  const reads: Promise<void>[] = []
  try {
    preview.setProject(project)
    preview.setViewport(W, H, 1)
    preview.setQuality('full')
    await preview.rendered()
    preview.onFrame((t) => {
      const at = performance.now()
      reads.push(preview.captureFrame().then((frame) => void frames.push({ at, t, n: frameNumber(frame) })))
    })
    await preview.play()
    const end = projectDuration(project)
    while (preview.getSnapshot().state === 'playing' && preview.currentTime() < end - 0.05) await sleep(50)
    await Promise.all(reads)
    frames.sort((a, b) => a.at - b.at)
  } finally {
    preview.dispose()
    canvas.remove()
    if (container !== host) container.remove()
  }
  const intervals = frames.slice(1).map((f, i) => f.at - (frames[i] as { at: number }).at)
  const frameMs = percentile(intervals, 0.5)
  const cutTimes = [...new Set(clips.map((c) => c.start))].filter((t) => t > 0).sort((a, b) => a - b)
  const cuts = cutTimes.map((at): CutSample => {
    const i = frames.findIndex((f) => f.t >= at)
    let gap = 0
    for (let k = Math.max(1, i); k < Math.min(frames.length, i + 3); k++)
      gap = Math.max(gap, (frames[k] as { at: number }).at - (frames[k - 1] as { at: number }).at)
    const after = frames.filter((f) => f.t >= at && f.t < at + 0.2)
    return {
      at,
      stallMs: round(Math.max(0, gap - frameMs)),
      wrongFrames: after.filter((f) => Math.abs(f.n - expected(f.t)) > 2).length,
    }
  })
  return {
    frameMs: round(frameMs),
    cuts,
    maxStallMs: round(Math.max(0, ...cuts.map((c) => c.stallMs))),
    meanStallMs: round(mean(cuts.map((c) => c.stallMs))),
    wrongFrames: cuts.reduce((a, c) => a + c.wrongFrames, 0),
  }
}
