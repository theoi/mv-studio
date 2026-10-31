import { existsSync } from 'node:fs'
import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * Real-model benchmark on CC0 footage (downloads ~250 MB of models on first run). Not part of CI:
 *   node scripts/fetch-vision-fixtures.mjs && npm run build && VISION_HEAVY=1 npx playwright test tests/e2e/vision-models.spec.ts
 */
const DIR = path.join(FIXTURE_DIR, 'vision')
// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

const CLIPS = [
  'people_teacher',
  'people_interview',
  'people_dance',
  'city_street',
  'nature_creek',
  'rain_street',
]

test.skip(!process.env.VISION_HEAVY, 'set VISION_HEAVY=1 to run the real-model vision benchmark')

test('vision models on real footage: masks, selection, matching, reframe', async ({ page }) => {
  test.setTimeout(30 * 60_000)
  for (const c of CLIPS)
    expect(
      existsSync(path.join(DIR, `${c}.webm`)),
      `${c} missing: run scripts/fetch-vision-fixtures.mjs`,
    ).toBe(true)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    CLIPS.map((c) => path.join(DIR, `${c}.webm`)),
  )

  const result = await page.evaluate(async (names: string[]) => {
    const { vision } = window.mvStudio
    const files: File[] = window.mvStudio.files()
    const backends = vision.createWorkerBackends()
    const service = vision.createVisionService({ backends, cache: vision.createMemoryCache() })
    const sources: Record<string, Awaited<ReturnType<typeof vision.createVideoElementSource>>> = {}
    for (let i = 0; i < names.length; i++)
      sources[names[i]!] = await vision.createVideoElementSource(files[i], names[i], { frameRate: 30 })
    const time = async (fn: () => Promise<Untyped>) => {
      const t0 = performance.now()
      const value = await fn()
      return { value, ms: performance.now() - t0 }
    }
    const out: Record<string, unknown> = {
      threads: (await window.mvStudio.shared.detectCapabilities()).wasmThreads,
    }

    // Text behind the subject: suitability on every clip, export track on the teacher clip with an HQ range.
    const suitability: Record<string, unknown> = {}
    for (const n of names) {
      const r = await time(() => service.checkSuitability(sources[n]))
      suitability[n] = {
        verdict: r.value.verdict,
        reasons: r.value.reasons,
        coverage: +r.value.meanCoverage.toFixed(3),
        stability: r.value.stability && +r.value.stability.toFixed(3),
        ms: Math.round(r.ms),
      }
    }
    out.suitability = suitability
    const teacher = sources.people_teacher
    const std = await time(() => service.personTrack(teacher, { faceFps: 5 }))
    out.personTrack = {
      frames: std.value.track.meta.frameCount,
      msPerFrame: +(std.ms / std.value.track.meta.frameCount).toFixed(1),
      verdict: std.value.suitability.verdict,
    }
    const hq = await time(() =>
      service.personTrack(teacher, { hqRanges: [{ start: 2, end: 4 }], faceFps: 0 }),
    )
    out.personTrackHq = {
      frames: hq.value.track.meta.frameCount,
      hqFrames: hq.value.hqFrames,
      extraMsPerHqFrame: +((hq.ms - std.ms) / 60).toFixed(1),
    }

    // Click-to-select the interviewee at the centre of her person box, compare with the person mask.
    const interview = sources.people_interview
    const person = await service.personTrack(interview, { fps: 10, faceFps: 0 })
    const reader = vision.createTrackReader(person.track)
    const m0 = reader.at(4)
    let sx = 0,
      sy = 0,
      n = 0
    for (let y = 0; y < m0.height; y++)
      for (let x = 0; x < m0.width; x++)
        if (m0.data[y * m0.width + x] >= 128) {
          sx += x
          sy += y
          n++
        }
    const click = { x: sx / n / m0.width, y: sy / n / m0.height }
    const sel = await time(() => service.selectionTrack(interview, { t: 4, points: [click] }, { fps: 10 }))
    const selReader = vision.createTrackReader(sel.value.track)
    const ious: number[] = []
    for (let t = 0.5; t < 8; t += 1) {
      const a = selReader.at(t),
        b = reader.at(t)
      let inter = 0,
        uni = 0
      for (let i = 0; i < a.data.length; i++) {
        const p = a.data[i] >= 128,
          q = b.data[i] >= 128
        if (p && q) inter++
        if (p || q) uni++
      }
      ious.push(uni ? inter / uni : 1)
    }
    out.selection = {
      frames: sel.value.track.meta.frameCount,
      msPerFrame: +(sel.ms / sel.value.track.meta.frameCount).toFixed(1),
      trackedFraction: sel.value.trackedFraction,
      meanIouWithPersonMask: +(ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(3),
    }

    // Footage matching.
    const indexes: Untyped[] = []
    const indexMs: Record<string, number> = {}
    for (const n of names) {
      const r = await time(() => service.indexClip(sources[n]))
      indexes.push(r.value)
      indexMs[n] = Math.round(r.ms)
    }
    out.indexMs = indexMs
    const queries: Array<[string, string[]]> = [
      ['a man being interviewed in an office', ['people_teacher']],
      ['a woman talking to the camera', ['people_interview']],
      ['people dancing together in a park', ['people_dance']],
      ['a narrow old town street with shops', ['city_street']],
      ['a stream flowing through a green forest', ['nature_creek']],
      ['a rainy street at night with neon lights', ['rain_street']],
      ['someone explaining something', ['people_teacher', 'people_interview']],
      ['water', ['nature_creek', 'rain_street']],
    ]
    const ranked = await time(() =>
      service.matcher.rankAll(
        indexes,
        queries.map(([text]) => ({ text })),
      ),
    )
    out.matching = {
      rankMs: Math.round(ranked.ms),
      top1: queries.map(([text, want], i) => ({
        text,
        top: ranked.value[i][0].mediaId,
        ok: want.includes(ranked.value[i][0].mediaId),
      })),
    }
    const project = {
      analysis: {
        audio: {},
        visual: Object.fromEntries(
          indexes.map((ix) => [
            ix.mediaId,
            vision.buildVisualAnalysis({
              assetId: ix.mediaId,
              duration: ix.duration,
              sourceSize: { width: 854, height: 480 },
              index: ix,
            }),
          ]),
        ),
      },
    }
    const director = vision.createDirectorFootageMatcher({
      matcher: service.matcher,
      getProject: () => project,
    })
    out.footageInfo = await director.info()

    // Auto-reframe the interview to 9:16 and check the face stays in the crop.
    const subjects = await service.subjects(interview)
    const plan = service.reframe(subjects, '9:16')
    let inside = 0
    const faces = subjects.samples.filter((s: { source: string }) => s.source === 'face')
    for (const s of faces) {
      const crop = vision.cropAt(plan, s.t)
      if (s.focus.x >= crop.x && s.focus.x <= crop.x + crop.width) inside++
    }
    out.reframe = {
      samples: subjects.samples.length,
      faceSamples: faces.length,
      faceInsideCrop: faces.length ? +(inside / faces.length).toFixed(3) : null,
      keyframes: plan.keyframes.length,
    }
    backends.dispose()
    return out
  }, CLIPS)

  console.log(JSON.stringify(result, null, 1))
  await test.info().attach('vision-benchmark.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  const matching = result.matching as { top1: Array<{ ok: boolean }> }
  expect(matching.top1.filter((q) => q.ok).length).toBeGreaterThanOrEqual(6)
  expect((result.selection as { meanIouWithPersonMask: number }).meanIouWithPersonMask).toBeGreaterThan(0.6)
  expect((result.suitability as Record<string, { verdict: string }>).people_teacher!.verdict).not.toBe(
    'unsuitable',
  )
})
