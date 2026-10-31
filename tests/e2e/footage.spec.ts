import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    // MediaPipe reports its TFLite setup through console.error.
    if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
  })
  return errors
}

test('footage is analyzed and subject-tracked on import without undo steps, and auto-cut cuts it to the beat in one', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['frames.mp4', 'clip.mp4', 'image.png', 'song.mp3'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, testing, vision, shared } = window.mvStudio
    const files: File[] = window.mvStudio.files()
    const [frames, clip, image, song] = await Promise.all(files.map((f) => media.mediaStore.importFile(f)))
    const p = model.createProject({ name: 'auto-cut' })
    for (const a of [frames, clip, image, song]) p.assets[a.id] = a
    p.songAssetId = song.id
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
    p.analysis.audio[song.id] = {
      assetId: song.id,
      version: 'test',
      tempo: { bpm: 120, confidence: 1 },
      beats,
      downbeats: beats.filter((_: number, i: number) => i % 4 === 0),
      sections: [
        { id: 'verse', label: 'verse', start: 0, end: 4, energy: 0.2 },
        { id: 'chorus', label: 'chorus', start: 4, end: 8, energy: 0.9 },
      ],
    }
    const editor = new model.ProjectEditor(p)

    // Model-free embeddings (mean color), so the real decode and motion pipeline runs without downloads.
    const meanColor = (bitmap: ImageBitmap) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[]
      const v = [r! / 255 + 0.01, g! / 255 + 0.01, b! / 255 + 0.01, 0.1]
      const n = Math.hypot(...v)
      return v.map((x) => x / n)
    }
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        const data = bitmaps.flatMap((b) => {
          const v = meanColor(b)
          b.close()
          return v
        })
        return { dim: 4, data: new Float32Array(data) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        return { dim: 4, data: new Float32Array(texts.flatMap(() => [0.5, 0.5, 0.5, 0.5])) }
      },
    }
    // Subject tracking uses the real MediaPipe segmenter and face detector.
    const workers = vision.createWorkerBackends()
    const service = vision.createVisionService({
      backends: { onnx: () => onnx, segmentation: (role: Untyped) => workers.segmentation(role) },
      cache: vision.createMemoryCache(),
    })
    const footage = vision.createFootageService({
      editor,
      vision: service,
      media: media.mediaStore,
      jobs: shared.jobs,
    })
    const stages = new Set<string>()
    shared.jobs.subscribe((jobs: Untyped[]) => {
      for (const j of jobs)
        if (j.kind === vision.FOOTAGE_INDEX_JOB && j.progress.stage) stages.add(j.progress.stage)
    })
    const states: string[] = []
    footage.indexing.subscribe((s: Untyped) => {
      if (states[states.length - 1] !== s.status) states.push(s.status)
    })
    const stop = footage.indexing.start()
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const s = footage.indexing.getState()
        if (s.status === 'error') reject(new Error(s.error.message))
        else if (
          s.status === 'idle' &&
          [frames, clip, image].every(
            (a) =>
              footage.indexing.statusOf(a.id) === 'indexed' &&
              ['analyzed', 'no-subject', 'failed'].includes(footage.indexing.subjectStatusOf(a.id)),
          )
        )
          resolve()
      }
      footage.indexing.subscribe(check)
      check()
    })
    stop()
    workers.dispose()
    const subjectsOf = (a: Untyped) => {
      const track = vision.readSubjectTrack(editor.getProject().analysis.visual[a.id])
      return { status: footage.indexing.subjectStatusOf(a.id), samples: track?.samples.length }
    }
    const subjects = { frames: subjectsOf(frames), clip: subjectsOf(clip), image: subjectsOf(image) }
    const index = (id: string) => vision.readClipIndex(editor.getProject().analysis.visual[id])
    const framesIndex = index(frames.id)
    const imageIndex = index(image.id)
    const undoAfterIndexing = editor.canUndo()

    const result = await vision.autoCut(
      { editor, matcher: service.matcher },
      { pace: 'beat', followEnergy: false, order: 'chronological', assetIds: [frames.id] },
    )
    const project = editor.getProject()
    const track = project.tracks.find((t: Untyped) => t.name === vision.AUTOCUT_TRACK_NAME)
    const cuts = Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => a.start - b.start)

    // frames.mp4 encodes its frame number in gray levels: left half (N mod 16) * 16 + 8, right half floor(N / 16) * 16 + 8.
    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const shown: { expected: number; frame: number }[] = []
    for (const c of cuts.slice(0, 8)) {
      const t = c.start + 0.2
      await compositor.render(project, t)
      const d = testing.readPixels(compositor.canvas, W, H)
      const left = d[(90 * W + 80) * 4]
      const right = d[(90 * W + 240) * 4]
      shown.push({
        expected: (c.sourceStart + 0.2 * c.playbackRate) * 30,
        frame: Math.round((right - 8) / 16) * 16 + Math.round((left - 8) / 16),
      })
    }
    compositor.dispose()
    const label = editor.undoLabel()
    editor.undo()
    const undone = editor.getProject()
    return {
      states,
      stages: [...stages],
      subjects,
      framesIndex: { times: framesIndex?.times.length, energy: framesIndex?.motion.meanEnergy },
      imageIndex: { times: imageIndex?.times.length, energy: imageIndex?.motion.meanEnergy },
      clipIndexed: !!index(clip.id),
      undoAfterIndexing,
      stats: result.stats,
      label,
      resultLabel: result.label,
      starts: cuts.map((c) => c.start),
      tracks: cuts.map((c) => c.trackId === track.id),
      muted: cuts.every((c) => c.muted),
      shown,
      afterUndo: {
        autoCutTrack: undone.tracks.some((t: Untyped) => t.name === vision.AUTOCUT_TRACK_NAME),
        analyses: Object.keys(undone.analysis.visual).length,
      },
    }
  })
  console.log('auto-cut e2e', JSON.stringify({ ...r, starts: r.starts.length }))
  expect(r.states).toEqual(['indexing', 'idle'])
  // The synthetic fixtures show no people; what matters is that every clip was tracked (5 Hz, a still once).
  for (const s of Object.values(r.subjects)) expect(['analyzed', 'no-subject']).toContain(s.status)
  expect(r.subjects.frames.samples).toBeGreaterThanOrEqual(19)
  expect(r.subjects.clip.samples).toBeGreaterThanOrEqual(19)
  expect(r.subjects.image.samples).toBe(1)
  expect(r.stages).toEqual(expect.arrayContaining(['indexing', 'subjects']))
  expect(r.framesIndex.times).toBe(4)
  expect(r.framesIndex.energy).toBeGreaterThan(1)
  expect(r.imageIndex).toEqual({ times: 1, energy: 0 })
  expect(r.clipIndexed).toBe(true)
  expect(r.undoAfterIndexing).toBe(false)
  expect(r.stats.cuts).toBe(r.starts.length)
  expect(r.starts.length).toBeGreaterThanOrEqual(15)
  for (const t of r.starts) expect(Math.abs(t * 2 - Math.round(t * 2))).toBeLessThan(1e-6)
  expect(r.muted).toBe(true)
  expect(r.label).toBe(r.resultLabel)
  expect(r.shown).toHaveLength(8)
  for (const s of r.shown) expect(Math.abs(s.frame - s.expected), JSON.stringify(s)).toBeLessThanOrEqual(1.5)
  // Chronological order keeps the footage's own order.
  r.shown.slice(1).forEach((s, i) => expect(s.frame).toBeGreaterThan(r.shown[i]!.frame))
  expect(r.afterUndo).toEqual({ autoCutTrack: false, analyses: 3 })
  expect(errors).toEqual([])
})

const VISION_DIR = path.join(FIXTURE_DIR, 'vision')
const CC0 = [
  'people_teacher',
  'people_interview',
  'people_dance',
  'city_street',
  'nature_creek',
  'rain_street',
]

/**
 * Real-model timing (downloads the CLIP and MediaPipe models on first run). Not part of CI:
 *   node scripts/fetch-vision-fixtures.mjs && npm run build && VISION_HEAVY=1 npx playwright test tests/e2e/footage.spec.ts
 */
test('timing: background analysis (matching and subjects) of 10 clips and an auto-cut with real models', async ({
  page,
}) => {
  test.skip(!process.env.VISION_HEAVY, 'set VISION_HEAVY=1 to run the real-model timing')
  test.setTimeout(20 * 60_000)
  for (const c of CC0) expect(existsSync(path.join(VISION_DIR, `${c}.webm`)), `${c} missing`).toBe(true)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    CC0.map((c) => path.join(VISION_DIR, `${c}.webm`)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, vision, shared } = window.mvStudio
    const files: File[] = window.mvStudio.files()
    // Ten clips: the six CC0 clips, then four of them imported again as separate assets.
    const assets: Untyped[] = []
    for (const f of [...files, ...files.slice(2, 6)]) assets.push(await media.mediaStore.importFile(f))
    const p = model.createProject({ name: 'timing' })
    for (const a of assets) p.assets[a.id] = a
    const editor = new model.ProjectEditor(p)
    const service = vision.createVisionService({
      backends: vision.createWorkerBackends(),
      cache: vision.createMemoryCache(),
    })
    const footage = vision.createFootageService({
      editor,
      vision: service,
      media: media.mediaStore,
      jobs: shared.jobs,
    })
    const t0 = performance.now()
    /** When each clip's matching and subject steps started, in run order. */
    const marks: { assetId: string; step: string; at: number }[] = []
    footage.indexing.subscribe((s: Untyped) => {
      const last = marks[marks.length - 1]
      if (s.current && (last?.assetId !== s.current.assetId || last.step !== s.current.step))
        marks.push({ assetId: s.current.assetId, step: s.current.step, at: performance.now() - t0 })
    })
    const settled = ['analyzed', 'no-subject', 'failed']
    const stop = footage.indexing.start()
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const s = footage.indexing.getState()
        if (s.status === 'error') reject(new Error(s.error.message))
        else if (
          s.status === 'idle' &&
          assets.every(
            (a) =>
              footage.indexing.statusOf(a.id) === 'indexed' &&
              settled.includes(footage.indexing.subjectStatusOf(a.id)),
          )
        )
          resolve()
      }
      footage.indexing.subscribe(check)
      check()
    })
    const totalMs = performance.now() - t0
    stop()
    const stepMs = (step: string) =>
      assets.map((a) => {
        const i = marks.findIndex((m) => m.assetId === a.id && m.step === step)
        return i < 0 ? 0 : Math.round((marks[i + 1]?.at ?? totalMs) - marks[i]!.at)
      })
    const matchingMs = stepMs('matching')
    const subjectsMs = stepMs('subjects')
    const perClip = matchingMs.map((m, i) => m + subjectsMs[i]!)
    const footageSeconds = assets.reduce((s, a) => s + (a.duration ?? 0), 0)
    const steadySeconds = assets.slice(1).reduce((s, a) => s + (a.duration ?? 0), 0)
    const steady = (ms: number[]) => Math.round(ms.slice(1).reduce((a, b) => a + b, 0) / steadySeconds)
    const subjects = assets.map((a) => {
      const track = vision.readSubjectTrack(editor.getProject().analysis.visual[a.id])
      const sources: Record<string, number> = {}
      for (const s of track?.samples ?? []) sources[s.source] = (sources[s.source] ?? 0) + 1
      return { name: a.name, status: footage.indexing.subjectStatusOf(a.id), sources }
    })

    // Auto-cut of a 3-minute, 120 BPM song (synthetic grid and lyrics) over the ten analyzed clips.
    const song = {
      ...assets[0],
      id: 'song',
      kind: 'audio',
      name: 'song.mp3',
      duration: 180,
      origin: { type: 'import' },
    }
    const beats = Array.from({ length: 360 }, (_, i) => i * 0.5)
    const sections = [0, 30, 60, 90, 120, 150].map((start, i) => ({
      id: `s${i}`,
      label: i % 2 ? 'chorus' : 'verse',
      start,
      end: start + 30,
      energy: i % 2 ? 0.9 : 0.4,
    }))
    const words = [
      'dancing in the park',
      'a teacher explains',
      'rain on a neon street',
      'walking down an old street',
      'a quiet forest creek',
    ]
    const lines = Array.from({ length: 36 }, (_, i) => ({
      id: `l${i}`,
      text: words[i % words.length],
      start: i * 5,
      end: i * 5 + 4,
      words: [],
    }))
    editor.dispatch([
      { type: 'asset.add', asset: song },
      { type: 'project.setSong', assetId: 'song' },
      {
        type: 'analysis.setAudio',
        analysis: {
          assetId: 'song',
          version: 'test',
          tempo: { bpm: 120, confidence: 1 },
          beats,
          downbeats: beats.filter((_, i) => i % 4 === 0),
          sections,
        },
      },
      { type: 'lyrics.set', lyrics: { audioAssetId: 'song', source: 'pasted', lines } },
    ])
    const a0 = performance.now()
    const plan = await vision.planAutoCut(editor.getProject(), {}, { matcher: service.matcher })
    const planMs = performance.now() - a0
    const applied = vision.applyAutoCut(editor, plan)
    const lyricPicks = plan.shots.filter((s: Untyped) => s.reason === 'lyric')
    const lyricHits: Record<string, Record<string, number>> = {}
    for (const s of lyricPicks) {
      const line = lines.find((l) => l.id === s.lyricLineId)!.text
      const name = editor.getProject().assets[s.assetId].name.replace('.webm', '')
      lyricHits[line] ??= {}
      lyricHits[line][name] = (lyricHits[line][name] ?? 0) + 1
    }
    return {
      threads: (await shared.detectCapabilities()).wasmThreads,
      clips: assets.length,
      footageSeconds: +footageSeconds.toFixed(1),
      totalMs: Math.round(totalMs),
      perClip,
      matchingMs,
      subjectsMs,
      steadyMsPerFootageSecond: {
        matching: steady(matchingMs),
        subjects: steady(subjectsMs),
        total: steady(perClip),
      },
      subjects,
      autoCut: { planMs: Math.round(planMs), shots: plan.shots.length, cuts: applied.stats.cuts, lyricHits },
    }
  })
  console.log('footage timing', JSON.stringify(r, null, 1))
  expect(r.clips).toBe(10)
  expect(r.autoCut.cuts).toBeGreaterThan(100)
  // The teacher and interview clips show a person talking to the camera.
  for (const s of r.subjects.slice(0, 2)) expect(s, JSON.stringify(s)).toMatchObject({ status: 'analyzed' })
})
