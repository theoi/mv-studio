import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * Director quality review on real songs (not part of CI): drafts every video kind with the local planner on real
 * analysis and lyric timings, renders contact sheets and a timeline with the real engine, and prints rhythm,
 * readability and clip-choice numbers. Kind `autocut` runs src/vision's auto-cut on the same song and clips.
 *
 *   sh scripts/fetch-analysis-fixtures.sh en && node scripts/fetch-vision-fixtures.mjs
 *   # plus the dataset's lyrics/<song>.txt (same revision as the script) in tests/fixtures/.cache/jamendolyrics/lyrics/
 *   npm run build
 *   DIRECTOR_QUALITY="Rxbyn_-_Bad_Side,Cortez_-_Feel__Stripped_" [DIRECTOR_QUALITY_KINDS=beat-cut,autocut] \
 *     [DIRECTOR_QUALITY_PROMPT="neon city at night"] \
 *     npx playwright test tests/e2e/director-quality.spec.ts
 *
 * Output: test-results/director-quality/<song>/<kind>-{sheet,opening,timeline}.jpg and metrics.json. Lyric text
 * comes from lyrics/<song>.txt, one word per timed word in words/<song>.csv.
 */
// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

const SONGS = (process.env.DIRECTOR_QUALITY ?? '').split(',').filter(Boolean)
const KINDS = (process.env.DIRECTOR_QUALITY_KINDS ?? 'lyric,beat-cut,visualizer,ai').split(',')
/** A prompt for every draft (it picks the look); outputs go to <song>__<prompt>. */
const PROMPT = process.env.DIRECTOR_QUALITY_PROMPT ?? ''
const JAMENDO = path.join(FIXTURE_DIR, 'jamendolyrics')
const VISION = path.join(FIXTURE_DIR, 'vision')
const FOOTAGE = path.join(FIXTURE_DIR, 'director-footage')
const OUT = path.resolve('test-results/director-quality')

/** CC0 / public-domain segments cut from the vision fixtures' sources: [source, start, duration]. */
const CUTS: [string, number, number][] = [
  ['city_street', 4, 10],
  ['city_street', 40, 9],
  ['city_street', 85, 12],
  ['nature_creek', 2, 10],
  ['nature_creek', 24, 12],
  ['people_dance', 0, 12],
  ['people_dance', 16, 12],
  ['people_interview', 100, 8],
  ['people_teacher', 200, 8],
  ['rain_street', 0, 5.5],
]

function footage(): string[] {
  mkdirSync(FOOTAGE, { recursive: true })
  return CUTS.map(([name, start, duration], i) => {
    const out = path.join(FOOTAGE, `${String(i + 1).padStart(2, '0')}_${name}.webm`)
    if (!existsSync(out)) {
      execFileSync('ffmpeg', [
        ...['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start)],
        ...['-i', path.join(VISION, `${name}.source.webm`), '-t', String(duration), '-an'],
        ...['-vf', 'scale=-2:360', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'realtime'],
        out,
      ])
    }
    return out
  })
}

interface Line {
  text: string
  words: { text: string; start: number; end: number }[]
}

/** JamendoLyrics words CSV (word_start, word_end, line_end) zipped with the words of lyrics/<song>.txt. */
function lyrics(song: string): Line[] {
  const rows = readFileSync(path.join(JAMENDO, 'words', `${song}.csv`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
  const textLines = readFileSync(path.join(JAMENDO, 'lyrics', `${song}.txt`), 'utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/).filter(Boolean))
    .filter((l) => l.length > 0)
  const timings = rows.map((r) => r.split(',').map(Number) as [number, number, number])
  const lines: Line[] = []
  let k = 0
  for (const words of textLines) {
    const timed = words.map((text) => {
      const [start, end] = timings[k++] ?? [NaN, NaN]
      return { text, start, end }
    })
    if (timed.every((w) => Number.isFinite(w.start))) lines.push({ text: words.join(' '), words: timed })
  }
  return lines
}

test('director drafts on real songs', async ({ page }) => {
  test.skip(SONGS.length === 0 || !existsSync(JAMENDO), 'set DIRECTOR_QUALITY and fetch the fixtures first')
  test.setTimeout(SONGS.length * 600_000)
  const clips = footage()
  await openHarness(page)
  for (const song of SONGS) {
    const dir = path.join(OUT, PROMPT ? `${song}__${PROMPT.replace(/[^a-z0-9]+/gi, '-')}` : song)
    mkdirSync(dir, { recursive: true })
    await page.setInputFiles('#e2e-file-input', [path.join(JAMENDO, 'mp3', `${song}.mp3`), ...clips])
    const result = await page.evaluate(
      async ({ lines, kinds, prompt }) => {
        const { model, media, analysis, director, testing, vision } = window.mvStudio
        const [songFile, ...videoFiles] = window.mvStudio.files() as File[]
        const songAsset = await media.mediaStore.importFile(songFile)
        const videos = []
        for (const f of videoFiles) videos.push(await media.mediaStore.importFile(f))
        const service = new analysis.SongAnalysisService()
        const audio = await analysis.decodeAudioFile(songFile)
        const fast = await service.analyze(songAsset.id, audio).promise
        const refined = await service.refine(songAsset.id).promise
        service.dispose()
        // Nothing is corrected by hand here, so the refinement replaces the fast grid and sections.
        const songAnalysis = {
          ...fast,
          tempo: refined.tempo,
          beats: refined.beats,
          downbeats: refined.downbeats,
          sections: refined.sections,
        }

        const base = model.createProject({ name: songFile.name, aspect: '16:9' })
        base.assets[songAsset.id] = songAsset
        for (const v of videos) base.assets[v.id] = v
        base.songAssetId = songAsset.id
        base.analysis = { audio: { [songAsset.id]: songAnalysis }, visual: {} }
        base.lyrics = {
          audioAssetId: songAsset.id,
          source: 'pasted',
          lines: lines.map((l: Line, i: number) => ({
            id: `l${i + 1}`,
            text: l.text,
            start: l.words[0]!.start,
            end: l.words[l.words.length - 1]!.end,
            words: l.words,
          })),
        }
        const duration = songAsset.duration as number

        const W = 384
        const H = 216
        const { compositor } = testing.createCompositor('export', W, H)
        const toDataUrl = async (canvas: OffscreenCanvas) => {
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let s = ''
          for (let i = 0; i < bytes.length; i += 0x8000)
            s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          return `data:image/jpeg;base64,${btoa(s)}`
        }
        const sheet = async (
          project: unknown,
          times: number[],
          cols: number,
          label: (t: number) => string,
        ) => {
          const rows = Math.ceil(times.length / cols)
          const canvas = new OffscreenCanvas(cols * W, rows * (H + 18))
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#111'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          for (const [i, t] of times.entries()) {
            await compositor.render(project, t)
            const x = (i % cols) * W
            const y = Math.floor(i / cols) * (H + 18)
            ctx.drawImage(compositor.canvas, x, y, W, H)
            ctx.fillStyle = '#ddd'
            ctx.font = '12px sans-serif'
            ctx.fillText(label(t), x + 4, y + H + 13)
          }
          return toDataUrl(canvas)
        }

        // Larger frames for judging lyric typography.
        const LW = 768
        const LH = 432
        const big = testing.createCompositor('export', LW, LH).compositor
        const probe = new OffscreenCanvas(W, H)
        const probeCtx = probe.getContext('2d', { willReadFrequently: true })!
        const pixels = async (project: unknown, t: number) => {
          await compositor.render(project, t)
          probeCtx.drawImage(compositor.canvas, 0, 0, W, H)
          return probeCtx.getImageData(0, 0, W, H).data
        }
        const lumaAt = (d: Uint8ClampedArray, i: number) =>
          (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255
        /**
         * Legibility of a text at time t: renders with and without the text track, finds the pixels the text changes,
         * and measures the background's brightness there and the luma spread (95th minus 5th percentile) of the
         * frame with text: high when letters stand out from their outline or halo, low when white text sits on white.
         */
        const legibility = async (project: Untyped, t: number) => {
          const hidden = {
            ...project,
            tracks: project.tracks.map((tr: { name: string }) =>
              tr.name === 'Director · Text' ? { ...tr, hidden: true } : tr,
            ),
          }
          const fg = await pixels(project, t)
          const bg = await pixels(hidden, t)
          const changed: number[] = []
          for (let i = 0; i < fg.length; i += 4)
            if (Math.abs(lumaAt(fg, i) - lumaAt(bg, i)) > 0.06) changed.push(i)
          if (changed.length < 20) return null
          const xs = changed.map((i) => (i / 4) % W)
          const ys = changed.map((i) => Math.floor(i / 4 / W))
          const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
          const inBox: number[] = []
          let bgSum = 0
          for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
              const i = (y * W + x) * 4
              inBox.push(lumaAt(fg, i))
              bgSum += lumaAt(bg, i)
            }
          inBox.sort((a, b) => a - b)
          const q = (p: number) => inBox[Math.floor(p * (inBox.length - 1))]!
          return { bg: bgSum / inBox.length, spread: q(0.95) - q(0.05), height: (y1 - y0 + 1) / H }
        }

        const out: Record<string, unknown> = {}
        for (const kind of kinds) {
          // `autocut` is src/vision's auto-cut on the same song and clips, for comparison.
          let plan: Untyped
          let project: Untyped
          try {
            if (kind === 'autocut') {
              const cut = await vision.planAutoCut(base, { seed: 1 })
              const editor = new model.ProjectEditor(base)
              editor.dispatch(vision.autoCutCommands(base, cut).commands)
              project = editor.getProject()
              plan = {
                summary: `Auto-cut with ${cut.shots.length} shots`,
                warnings: cut.warnings,
                texts: [],
                shots: cut.shots.map(
                  (s: {
                    start: number
                    end: number
                    assetId: string
                    sourceStart: number
                    playbackRate: number
                    sectionId: string
                  }) => ({
                    layer: 'main',
                    start: s.start,
                    end: s.end,
                    sectionId: s.sectionId,
                    source: {
                      type: 'media',
                      assetId: s.assetId,
                      sourceStart: s.sourceStart,
                      playbackRate: s.playbackRate,
                    },
                  }),
                ),
              }
            } else {
              // `media` lets the director measure footage brightness under lyrics, as the app's media store does.
              plan = await director.planLocally(
                await director.buildPlannerInput(base, { kind, seed: 1, prompt, media: media.mediaStore }),
              )
              const editor = new model.ProjectEditor(base)
              editor.dispatch(director.compilePlan(plan, base).commands)
              project = editor.getProject()
            }
          } catch (error) {
            out[kind] = { error: String(error) }
            continue
          }
          const sections = songAnalysis.sections ?? []
          const sectionAt = (t: number) =>
            sections.find((s: { start: number; end: number }) => t >= s.start && t < s.end)
          const shotAt = (t: number) =>
            plan.shots.find(
              (s: { layer: string; start: number; end: number }) =>
                s.layer === 'main' && t >= s.start && t < s.end,
            )
          const label = (t: number) => {
            const s = sectionAt(t)
            const shot = shotAt(t)
            const src =
              shot?.source.type === 'media'
                ? (project.assets[shot.source.assetId]?.name ?? '').slice(0, 14)
                : (shot?.source.generatorId ?? shot?.source.type ?? '')
            return `${t.toFixed(1)}s ${s?.label ?? ''} ${src}`
          }
          const grid = Array.from({ length: 24 }, (_, i) => ((i + 0.5) * duration) / 24)
          const opening = Array.from({ length: 12 }, (_, i) => 0.25 + i * 1.5)
          const ending = Array.from({ length: 6 }, (_, i) => duration - 11 + i * 2)

          // Timeline: sections, beats, main shots, overlays, lyric text vs sung lines.
          const TW = 1800
          const TH = 230
          const px = (t: number) => (t / duration) * TW
          const tl = new OffscreenCanvas(TW, TH)
          const c = tl.getContext('2d')!
          c.fillStyle = '#0d0d12'
          c.fillRect(0, 0, TW, TH)
          c.font = '11px sans-serif'
          for (const s of sections) {
            c.fillStyle = `hsla(${(s.repeatGroup ?? 0) * 67}, 50%, ${20 + 30 * s.energy}%, 1)`
            c.fillRect(px(s.start), 0, px(s.end) - px(s.start) - 1, 30)
            c.fillStyle = '#fff'
            c.fillText(`${s.label} ${s.energy.toFixed(2)}`, px(s.start) + 3, 19)
          }
          c.fillStyle = '#556'
          for (const b of songAnalysis.beats) c.fillRect(px(b), 34, 1, 6)
          c.fillStyle = '#aab'
          for (const b of songAnalysis.downbeats ?? []) c.fillRect(px(b), 32, 1, 10)
          const colors = new Map<string, string>()
          const colorOf = (key: string) => {
            if (!colors.has(key)) colors.set(key, `hsl(${(colors.size * 137) % 360}, 60%, 55%)`)
            return colors.get(key)!
          }
          for (const s of plan.shots) {
            const key = s.source.type === 'media' ? s.source.assetId : (s.source.generatorId ?? s.source.type)
            c.fillStyle = colorOf(key)
            const y = s.layer === 'main' ? 48 : 82
            c.fillRect(px(s.start), y, Math.max(1, px(s.end) - px(s.start) - 1), 28)
            if (s.transitionIn) {
              c.fillStyle = '#fff'
              c.fillRect(px(s.start), y + 22, Math.max(2, px(s.transitionIn.duration)), 6)
            }
          }
          c.fillStyle = '#ccc'
          c.fillText('main', 2, 66)
          c.fillText('overlay', 2, 100)
          for (const l of base.lyrics.lines) {
            c.fillStyle = '#3a6'
            c.fillRect(px(l.start), 120, Math.max(1, px(l.end) - px(l.start)), 14)
          }
          for (const t of plan.texts) {
            c.fillStyle = t.role === 'title' ? '#e94' : '#49e'
            c.fillRect(px(t.start), 140, Math.max(1, px(t.end) - px(t.start) - 1), 14)
          }
          c.fillStyle = '#ccc'
          c.fillText('sung', 2, 131)
          c.fillText('text', 2, 151)
          for (let t = 0; t < duration; t += 10) {
            c.fillStyle = '#666'
            c.fillRect(px(t), 160, 1, 6)
            c.fillText(`${t}`, px(t) + 2, 178)
          }
          c.fillStyle = '#ddd'
          c.fillText(plan.summary.slice(0, 260), 4, 200)
          c.fillText(
            `look ${plan.look?.name ?? 'none'} · warnings: ${plan.warnings.join(' | ').slice(0, 200)}`,
            4,
            220,
          )

          // Rhythm and readability numbers.
          const main = plan.shots
            .filter((s: { layer: string }) => s.layer === 'main')
            .sort((a: { start: number }, b: { start: number }) => a.start - b.start)
          const near = (t: number, list: number[]) => list.some((b) => Math.abs(b - t) < 0.04)
          const cuts = main.slice(1).map((s: { start: number }) => s.start)
          const bySection = sections.map(
            (s: { label: string; start: number; end: number; energy: number }) => {
              const inside = main.filter((m: { start: number }) => m.start >= s.start && m.start < s.end)
              const len = inside.reduce(
                (sum: number, m: { start: number; end: number }) => sum + m.end - m.start,
                0,
              )
              return {
                label: s.label,
                energy: Number(s.energy.toFixed(2)),
                shots: inside.length,
                meanShot: inside.length ? Number((len / inside.length).toFixed(2)) : null,
              }
            },
          )
          const lineById = new Map(base.lyrics.lines.map((l: { id: string }) => [l.id, l]))
          const lyricTexts = plan.texts.filter((t: { role: string }) => t.role === 'lyric')
          const lyricStats = lyricTexts.map(
            (t: { lyricLineId?: string; start: number; end: number; text: string }) => {
              const line = lineById.get(t.lyricLineId ?? '') as { start: number; end: number } | undefined
              return {
                lead: line ? line.start - t.start : null,
                tail: line ? t.end - line.end : null,
                shown: t.end - t.start,
                cps: t.text.length / Math.max(0.1, t.end - t.start),
              }
            },
          )
          const lengths = main.map((m: { start: number; end: number }) => m.end - m.start)
          const midLine = (t: number) =>
            base.lyrics.lines.some(
              (l: { start: number; end: number }) => t > l.start + 0.2 && t < l.end - 0.1,
            )
          const duringText = (t: number) =>
            lyricTexts.some((l: { start: number; end: number }) => t > l.start + 0.12 && t < l.end - 0.12)
          const legible = []
          for (const l of lyricTexts as { start: number; end: number }[]) {
            const r = await legibility(project, Math.max(l.start + 0.6, (l.start + l.end) / 2))
            if (r) legible.push(r)
          }
          const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)
          const spreads = legible.map((r) => r.spread).sort((a, b) => a - b)
          const bands: number[][] = songAnalysis.features?.bands ?? []
          const bandValues = bands.flat()
          // Clip choice: source seconds shown more than once, how evenly clips are used, slowed shots, closest reuse.
          const ranges = new Map<string, [number, number][]>()
          const uses = new Map<string, number[]>()
          main.forEach(
            (
              m: {
                start: number
                end: number
                source: { type: string; assetId?: string; sourceStart?: number; playbackRate?: number }
              },
              i: number,
            ) => {
              if (m.source.type !== 'media' || !m.source.assetId) return
              const s0 = m.source.sourceStart ?? 0
              const list = ranges.get(m.source.assetId) ?? []
              list.push([s0, s0 + (m.end - m.start) * (m.source.playbackRate ?? 1)])
              ranges.set(m.source.assetId, list)
              uses.set(m.source.assetId, [...(uses.get(m.source.assetId) ?? []), i])
            },
          )
          let shownSeconds = 0
          let uniqueSeconds = 0
          for (const list of ranges.values()) {
            list.sort((x, y) => x[0] - y[0])
            let [cs, ce] = list[0]!
            for (const [s, e] of list) {
              shownSeconds += e - s
              if (s > ce) {
                uniqueSeconds += ce - cs
                ;[cs, ce] = [s, e]
              } else ce = Math.max(ce, e)
            }
            uniqueSeconds += ce - cs
          }
          const perAsset = [...ranges.values()].map((l) => l.reduce((a, [s, e]) => a + e - s, 0))
          const meanUse = perAsset.reduce((a, b) => a + b, 0) / Math.max(1, perAsset.length)
          const gaps = [...uses.values()].flatMap((idx) => idx.slice(1).map((v, i) => v - idx[i]!))
          const metrics = {
            kind,
            summary: plan.summary,
            look: plan.look?.name,
            warnings: plan.warnings,
            bpm: songAnalysis.tempo.bpm,
            duration,
            mainShots: main.length,
            shortestShot: Math.min(...lengths),
            longestShot: Math.max(...lengths),
            cutsOnBeat: cuts.length
              ? cuts.filter((t: number) => near(t, songAnalysis.beats)).length / cuts.length
              : null,
            cutsOnDownbeat: cuts.length
              ? cuts.filter((t: number) => near(t, songAnalysis.downbeats ?? [])).length / cuts.length
              : null,
            sameAssetAdjacent: main
              .slice(1)
              .filter(
                (s: { source: { assetId?: string } }, i: number) =>
                  s.source.assetId && s.source.assetId === main[i].source.assetId,
              ).length,
            assetsUsed: new Set(
              main.map((m: { source: { assetId?: string } }) => m.source.assetId).filter(Boolean),
            ).size,
            bySection,
            lyricLines: base.lyrics.lines.length,
            lyricTexts: lyricTexts.length,
            maxCps: lyricStats.length ? Math.max(...lyricStats.map((s: { cps: number }) => s.cps)) : null,
            minShown: lyricStats.length
              ? Math.min(...lyricStats.map((s: { shown: number }) => s.shown))
              : null,
            meanLead: lyricStats.length
              ? lyricStats.reduce((a: number, s: { lead: number | null }) => a + (s.lead ?? 0), 0) /
                lyricStats.length
              : null,
            texts: plan.texts.length,
            title: plan.texts.find((t: { role: string }) => t.role === 'title')?.text,
            titles: plan.texts
              .filter((t: { role: string }) => t.role === 'title')
              .map((t: { text: string }) => t.text),
            cutsMidLine: cuts.length ? cuts.filter(midLine).length / cuts.length : null,
            cutsDuringText: cuts.length ? cuts.filter(duringText).length / cuts.length : null,
            legibility: legible.length
              ? {
                  measured: legible.length,
                  brightBackgrounds: legible.filter((r) => r.bg > 0.55).length / legible.length,
                  backgroundLuma: mean(legible.map((r) => r.bg)),
                  spreadMean: mean(spreads),
                  spreadP10: spreads[Math.floor(spreads.length * 0.1)],
                  spreadMin: spreads[0],
                  textHeight: mean(legible.map((r) => r.height)),
                }
              : null,
            generators: [
              ...new Set(
                main.map((m: { source: { generatorId?: string } }) => m.source.generatorId).filter(Boolean),
              ),
            ],
            fadeIn: main[0]?.transitionIn?.kind ?? null,
            bandsSaturated: bandValues.length
              ? bandValues.filter((v) => v >= 0.99).length / bandValues.length
              : null,
            bandsMean: bandValues.length ? bandValues.reduce((a, b) => a + b, 0) / bandValues.length : null,
            repeatedFrames: shownSeconds ? 1 - uniqueSeconds / shownSeconds : null,
            usageCv: perAsset.length
              ? Math.sqrt(perAsset.reduce((a, v) => a + (v - meanUse) ** 2, 0) / perAsset.length) / meanUse
              : null,
            slowed: main.filter(
              (m: { source: { playbackRate?: number } }) => (m.source.playbackRate ?? 1) < 0.999,
            ).length,
            minReuseGap: gaps.length ? Math.min(...gaps) : null,
            firstShot: main[0] ? [main[0].start, main[0].end] : null,
            lastShot: main.length
              ? [
                  main[main.length - 1].start,
                  main[main.length - 1].end,
                  main[main.length - 1].transitionOut ?? null,
                ]
              : null,
          }
          const lyricMoments = lyricTexts
            .filter((_: unknown, i: number) => i % Math.max(1, Math.floor(lyricTexts.length / 8)) === 0)
            .slice(0, 8)
            .map((l: { start: number; end: number }) => Math.max(l.start + 0.6, (l.start + l.end) / 2))
          let lyricSheet: string | undefined
          if (lyricMoments.length) {
            const canvas = new OffscreenCanvas(4 * LW, Math.ceil(lyricMoments.length / 4) * (LH + 18))
            const lc = canvas.getContext('2d')!
            lc.fillStyle = '#111'
            lc.fillRect(0, 0, canvas.width, canvas.height)
            for (const [i, t] of lyricMoments.entries()) {
              await big.render(project, t)
              const x = (i % 4) * LW
              const y = Math.floor(i / 4) * (LH + 18)
              lc.drawImage(big.canvas, x, y, LW, LH)
              lc.fillStyle = '#ddd'
              lc.font = '13px sans-serif'
              lc.fillText(label(t), x + 4, y + LH + 14)
            }
            lyricSheet = await toDataUrl(canvas)
          }
          out[kind] = {
            metrics,
            ...(lyricSheet ? { lyrics: lyricSheet } : {}),
            sheet: await sheet(project, grid, 6, label),
            opening: await sheet(project, [...opening, ...ending], 6, label),
            timeline: await toDataUrl(tl),
          }
        }
        compositor.dispose()
        big.dispose()
        return out
      },
      { lines: lyrics(song), kinds: KINDS, prompt: PROMPT },
    )
    const metrics: Record<string, unknown> = {}
    for (const [kind, value] of Object.entries(result) as [string, Record<string, unknown>][]) {
      metrics[kind] = value.metrics ?? value
      for (const name of ['sheet', 'opening', 'timeline', 'lyrics']) {
        const url = value[name] as string | undefined
        if (url)
          writeFileSync(path.join(dir, `${kind}-${name}.jpg`), Buffer.from(url.split(',')[1]!, 'base64'))
      }
    }
    writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2))
    console.log(song, JSON.stringify(metrics, null, 1).slice(0, 4000))
    expect(readdirSync(dir).length).toBeGreaterThan(1)
  }
})
