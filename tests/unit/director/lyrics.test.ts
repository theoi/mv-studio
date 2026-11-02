import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  compilePlan,
  DEFAULT_CATALOG,
  planLocally,
  type BrightnessProbe,
  type BrightnessRequest,
  type EditPlan,
  type PlanShot,
  type PlanText,
} from '../../../src/director/index.ts'
import {
  frameWidth,
  layoutLine,
  lyricTypography,
  rowWidth,
  textWidth,
} from '../../../src/director/typography.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { AspectPreset, Project, TextClip } from '../../../src/model/types.ts'
import { buildVisualAnalysis } from '../../../src/vision/index.ts'
import { LYRICS, makeProject, SECTIONS, timedLine } from './fixtures.ts'

const VIDEOS = ['video1', 'video2', 'video3', 'video4']

async function lyricDraft(project: Project = makeProject(), prompt = ''): Promise<EditPlan> {
  return planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 1, prompt }))
}

const lyricLines = (p: EditPlan) => p.texts.filter((t) => t.role === 'lyric')
const main = (p: EditPlan): PlanShot[] => p.shots.filter((s) => s.layer === 'main')
/** Half the height of a text block as a fraction of the frame. */
const halfHeight = (t: PlanText) =>
  (t.text.split('\n').length * (t.style.lineHeight ?? 1.15) * (t.style.fontSize ?? 0)) / 1080 / 2

/**
 * Every clip has a person facing the camera in the middle of the frame, the face centered at `faceY`, the person
 * `height` tall (from the top of the head).
 */
function withFaces(project: Project, faceY = 0.42, height = 0.85): Project {
  const sourceSize = { width: 1920, height: 1080 }
  for (const id of VIDEOS) {
    project.analysis.visual[id] = buildVisualAnalysis({
      assetId: id,
      duration: 30,
      sourceSize,
      subjects: {
        version: 1,
        mediaId: id,
        sourceSize,
        samples: Array.from({ length: 151 }, (_, i) => ({
          t: i * 0.2,
          focus: { x: 0.5, y: faceY },
          box: { x: 0.3, y: faceY - 0.27 * height, width: 0.4, height },
          confidence: 0.9,
          source: 'face' as const,
        })),
      },
    })
  }
  return project
}

describe('lyric typography', () => {
  it('sets lyrics in the text style the look pairs with, big enough to read at a glance', async () => {
    const p = await lyricDraft()
    expect(p.look?.id).toBe('clean')
    const lines = lyricLines(p)
    expect(lines).toHaveLength(LYRICS.length)
    for (const t of lines) {
      // The look's karaoke style: heavy outlined type that lights up word by word.
      expect(t.style.fontFamily).toMatch(/^Montserrat/)
      expect(t.style.fontWeight).toBeGreaterThanOrEqual(800)
      expect(t.style.stroke?.color).toBe('#000000')
      expect(t.animationPresetId).toBe('sweep')
      expect(t.karaoke).toEqual({ highlightColor: '#facc15', mode: 'word' })
      // At least 9% of the frame height, so capitals are 6 to 7% of it.
      expect((t.style.fontSize as number) / 1080).toBeGreaterThanOrEqual(0.09)
    }

    const neon = await lyricDraft(makeProject(), 'neon city at night')
    expect(neon.look?.id).toBe('neon')
    const glowing = lyricLines(neon)
    expect(glowing.every((t) => t.animationPresetId === 'flicker' && t.style.uppercase && !t.karaoke)).toBe(
      true,
    )
    // The style's pink glow takes the look's cyan accent.
    expect(glowing[0]!.style.shadow?.color.slice(0, 7)).toBe('#22d3ee')
  })

  it('shows the stressed word of chorus lines bigger, below the line, as it is sung', async () => {
    const p = await lyricDraft()
    const chorus = p.texts.filter((t) => t.lyricLineId === 'l3')
    expect(chorus.map((t) => [t.role, t.text])).toEqual([
      ['lyric', 'Hold on hold on'],
      ['emphasis', 'tonight'],
    ])
    const [head, tail] = chorus as [PlanText, PlanText]
    expect(tail.start).toBeCloseTo(LYRICS[2]!.words[4]!.start - 0.06, 3)
    expect(tail.end).toBe(head.end)
    expect(tail.style.fontSize).toBeGreaterThan((head.style.fontSize as number) * 1.4)
    expect(tail.style.color).toBe('#facc15')
    expect(tail.position.y - halfHeight(tail)).toBeGreaterThanOrEqual(
      head.position.y + halfHeight(head) - 1e-6,
    )
    // Verse lines whose last word is short stay whole.
    expect(p.texts.filter((t) => t.lyricLineId === 'l1').map((t) => t.role)).toEqual(['lyric'])
  })

  it('breaks long lines into balanced rows that fit the frame', () => {
    const text = 'I keep on running through the night'
    const wide = lyricTypography({ aspect: '16:9', busy: false, catalog: DEFAULT_CATALOG }).style
    const rows = layoutLine(text, wide, '16:9').text.split('\n')
    expect(rows).toHaveLength(2)
    expect(rows.join(' ')).toBe(text)
    const widths = rows.map((r) => textWidth(r, wide))
    for (const w of widths) expect(w).toBeLessThanOrEqual(rowWidth(wide, '16:9'))
    // Room to spare within the clip's wrap width, even for a line that needs smaller type, so a slightly narrow
    // estimate never makes the renderer wrap a word onto a row of its own.
    const long = layoutLine("maybe you're just playing games a game i don't wanna play", wide, '16:9')
    expect(long.fontSize).toBeLessThan(wide.fontSize as number)
    // It fits the rows allowed at 70% or more, so it keeps them.
    expect(long.rows).toBe(2)
    for (const row of long.text.split('\n'))
      expect(textWidth(row, wide, long.fontSize)).toBeLessThanOrEqual(0.92 * (wide.maxWidth as number) * 1920)
    expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.75)
    const tall = lyricTypography({ aspect: '9:16', busy: false, catalog: DEFAULT_CATALOG }).style
    expect(layoutLine(text, tall, '9:16').text.split('\n').length).toBeGreaterThan(2)
  })

  it.each([
    ['9:16', 4],
    ['1:1', 3],
  ] as const)(
    'at %s, lays a line too long for the rows allowed even in smaller type out in %i rows, each within the clip',
    (aspect, rows) => {
      const style = lyricTypography({ aspect, busy: false, catalog: DEFAULT_CATALOG }).style
      const text = 'Counting heartbeats as the trains roll by until the morning comes around again'
      const laid = layoutLine(text, style, aspect)
      expect(laid.rows).toBe(rows)
      expect(laid.text.replace(/\n/g, ' ')).toBe(text)
      for (const row of laid.text.split('\n'))
        expect(textWidth(row, style, laid.fontSize)).toBeLessThanOrEqual(rowWidth(style, aspect))
    },
  )

  it.each(['9:16', '4:5'] as const)(
    'shrinks a word too long for the frame even at half the size until it fits the frame, at %s',
    (aspect) => {
      const style = lyricTypography({ aspect, busy: false, catalog: DEFAULT_CATALOG }).style
      const laid = layoutLine('Supercalifragilisticexpialidocious', style, aspect)
      expect(laid.fontSize).toBeLessThan((style.fontSize as number) / 2)
      expect(textWidth('Supercalifragilisticexpialidocious', style, laid.fontSize)).toBeLessThanOrEqual(
        frameWidth(aspect),
      )
    },
  )

  it('keeps a chorus line whole when its stressed ending is too wide for the clip at the line’s size', async () => {
    const lyrics = LYRICS.map((l) =>
      l.id === 'l3' ? timedLine('l3', 'Hold on to me unbreakable me', 25) : l,
    )
    const draft = async (aspect: AspectPreset) => {
      const project = makeProject({ lyrics })
      project.settings = { ...project.settings, aspect }
      return (await lyricDraft(project)).texts.filter((t) => t.lyricLineId === 'l3')
    }
    expect((await draft('16:9')).map((t) => [t.role, t.text])).toEqual([
      ['lyric', 'Hold on to me'],
      ['emphasis', 'unbreakable me'],
    ])
    const tall = await draft('9:16')
    expect(tall.map((t) => t.role)).toEqual(['lyric'])
    expect(tall[0]!.text.replace(/\s+/g, ' ')).toBe('Hold on to me unbreakable me')
  })

  it('keeps each lyric line on one shot', async () => {
    const p = await lyricDraft()
    const sectionStarts = new Set(SECTIONS.map((s) => s.start))
    const cuts = main(p)
      .map((s) => s.start)
      .filter((t) => !sectionStarts.has(t))
    expect(cuts.length).toBeGreaterThan(5)
    for (const t of cuts) {
      for (const line of lyricLines(p)) expect(t > line.start + 0.12 && t < line.end - 0.12).toBe(false)
    }
  })

  it('moves lines off faces, keeping a chorus line whole when its emphasized word would not fit clear', async () => {
    const plain = await lyricDraft()
    const lines = (p: EditPlan) => p.texts.filter((t) => ['l1', 'l2', 'l3'].includes(t.lyricLineId ?? ''))
    expect(lines(plain).map((t) => t.position.y)).toEqual([0.5, 0.5, expect.any(Number), expect.any(Number)])
    // Face boxes span the face center plus or minus 0.12 of the frame height.
    for (const [faceY, chorusRoles] of [
      [0.42, ['lyric', 'emphasis']],
      [0.5, ['lyric']],
    ] as const) {
      const faced = lines(await lyricDraft(withFaces(makeProject(), faceY)))
      expect(faced.filter((t) => t.lyricLineId === 'l3').map((t) => t.role)).toEqual(chorusRoles)
      for (const t of faced) {
        const top = t.position.y - halfHeight(t)
        const bottom = t.position.y + halfHeight(t)
        expect(top > faceY + 0.12 || bottom < faceY - 0.12).toBe(true)
        expect(top).toBeGreaterThanOrEqual(0.08)
        expect(bottom).toBeLessThanOrEqual(0.92)
      }
    }
    // People far from the camera may stand behind the words.
    const far = lines(await lyricDraft(withFaces(makeProject(), 0.42, 0.25)))
    expect(far.map((t) => t.position.y)).toEqual(lines(plain).map((t) => t.position.y))
  })

  it('puts a soft scrim behind text over bright footage, and a dark outline over all footage, whatever the look', async () => {
    const requests: BrightnessRequest[] = []
    // video1 is a white sky; the other clips are dark.
    const brightness: BrightnessProbe = async (batch) => {
      requests.push(...batch)
      return batch.map((r) => (r.assetId === 'video1' ? 0.9 : 0.15))
    }
    for (const prompt of ['', 'neon city at night', 'warm summer sunset']) {
      const input = await buildPlannerInput(makeProject(), { kind: 'lyric', seed: 1, prompt, brightness })
      const p = await planLocally(input)
      const assetAt = (t: number) => {
        const s = main(p).find((x) => x.start <= t && x.end > t)
        return s?.source.type === 'media' ? s.source.assetId : undefined
      }
      const overBright = (t: PlanText) =>
        assetAt(t.start + Math.min(0.3, (t.end - t.start) / 4)) === 'video1' ||
        assetAt((t.start + t.end) / 2) === 'video1'
      expect(p.texts.some(overBright)).toBe(true)
      expect(p.texts.some((t) => !overBright(t))).toBe(true)
      for (const t of p.texts) {
        if (t.role === 'emphasis') {
          expect(t.style.background).toBeUndefined()
          if (overBright(t)) expect(t.style.shadow?.color).toBe('#000000cc')
        } else expect(!!t.style.background).toBe(overBright(t))
        expect(t.style.stroke?.color).toMatch(/^#000000/)
      }
    }
    for (const r of requests) {
      expect(r.box.x).toBeGreaterThanOrEqual(0)
      expect(r.box.x + r.box.width).toBeLessThanOrEqual(1)
      expect(r.box.y).toBeGreaterThanOrEqual(0)
      expect(r.box.y + r.box.height).toBeLessThanOrEqual(1)
    }
  })

  it('puts one chorus behind the subject when its clips have subject masks', async () => {
    const project = makeProject()
    for (const id of VIDEOS) {
      project.assets[`${id}-mask`] = {
        ...project.assets[id]!,
        id: `${id}-mask`,
        name: `${id} (subject mask).webm`,
        origin: { type: 'derived', parentAssetId: id },
      }
    }
    const p = await lyricDraft(project)
    const behind = p.texts.filter((t) => t.behind)
    expect(behind.length).toBeGreaterThan(0)
    for (const t of behind) {
      expect(t.sectionId).toBe('s-chorus1')
      const shot = main(p).find((s) => s.start <= t.start && s.end >= t.end)
      const asset = shot?.source.type === 'media' ? shot.source.assetId : undefined
      expect(t.behind).toEqual({ maskAssetId: `${asset}-mask`, sourceAssetId: asset })
    }
    const editor = new ProjectEditor(project)
    editor.dispatch(compilePlan(p, project).commands)
    const matted = Object.values(editor.getProject().clips).filter(
      (c): c is TextClip => c.type === 'text' && !!c.matte,
    )
    expect(matted).toHaveLength(behind.length)
    expect(matted[0]!.matte).toMatchObject({ mode: 'outside', maskAssetId: behind[0]!.behind!.maskAssetId })

    expect((await lyricDraft()).texts.some((t) => t.behind)).toBe(false)
  })
})

/** A line sung fast: a word every `step` seconds. */
function fastLine(id: string, text: string, start: number, step = 0.2) {
  const words = text
    .split(' ')
    .map((w, i) => ({ text: w, start: start + i * step, end: start + i * step + step * 0.85 }))
  return { id, text, start, end: words[words.length - 1]!.end, words }
}

const FAST = [
  fastLine('f1', 'Running down the empty road tonight', 9),
  fastLine('f2', 'Every light is flashing by so fast', 10.3),
  fastLine('f3', 'Holding on to every word you say', 11.8),
  fastLine('f4', 'Never looking back again tonight', 13.3),
  fastLine('c1', 'Oh oh oh', 16, 0.25),
  fastLine('c2', 'Yeah yeah yeah', 16.9, 0.25),
  fastLine('s1', 'Walking home alone', 20, 0.4),
  fastLine('d1', 'Oh oh oh', 40.5, 0.25),
  fastLine('d2', 'Yeah yeah yeah', 41.3, 0.5),
  fastLine('d3', 'Fast forward to the end of every night', 42.8, 0.15),
  fastLine('d4', 'Into the light', 44.1, 0.3),
]

describe('fast passages', () => {
  const fastDraft = () => lyricDraft(makeProject({ lyrics: FAST }))
  const of = (p: EditPlan, id: string, role?: PlanText['role']) =>
    p.texts.filter((t) => t.lyricLineId === id && (!role || t.role === role))

  it('shows every line long enough to read: the next line waits below the current one, then rolls up', async () => {
    const p = await fastDraft()
    // On screen as the current or the next line, no line reads faster than 15 characters per second.
    for (const line of FAST) {
      const spans = of(p, line.id).map((t) => [t.start, t.end] as const)
      expect(spans.length).toBeGreaterThan(0)
      const visible = Math.max(...spans.map((s) => s[1])) - Math.min(...spans.map((s) => s[0]))
      expect(line.text.length / visible).toBeLessThan(15)
    }
    for (const [i, id] of ['f1', 'f2', 'f3'].entries()) {
      const current = of(p, id, 'lyric')[0]!
      const next = of(p, `f${i + 2}`, 'preview')[0]!
      expect([next.start, next.end]).toEqual([current.start, current.end])
      expect(next.position.y).toBeGreaterThan(current.position.y + halfHeight(current))
      expect(next).toMatchObject({ scale: 0.72, opacity: 0.5 })
      expect(next.style).toEqual(current.style)
      // When its turn comes it rolls up from where it waited, at full size, in the same style.
      const rolled = of(p, `f${i + 2}`, 'lyric')[0]!
      expect(rolled.start).toBe(current.end)
      expect(rolled.enter).toEqual({ y: next.position.y, scale: 0.72, opacity: 0.5, duration: 0.2 })
      expect(rolled.animationPresetId).toBeUndefined()
      expect(rolled.karaoke).toBeDefined()
    }
    expect(of(p, 'f1', 'lyric')[0]!.enter).toBeUndefined()
    expect(of(p, 'f4', 'preview')).toHaveLength(1)
    // A slow line on its own is shown as before.
    expect(p.texts.filter((t) => t.lyricLineId === 's1').map((t) => t.role)).toEqual(['lyric'])
  })

  it('keeps a couplet of short lines on screen together until its second line is sung', async () => {
    const p = await fastDraft()
    const [first] = of(p, 'c1', 'lyric')
    const [waiting] = of(p, 'c2', 'preview')
    const [second] = of(p, 'c2', 'lyric')
    expect(first!.end).toBe(second!.end)
    expect([waiting!.start, waiting!.end]).toEqual([first!.start, second!.start])
    expect(second!.position.y).toBe(waiting!.position.y)
    expect(second!.position.y).toBeGreaterThan(first!.position.y)
    expect(second!.enter).toMatchObject({ scale: 0.72, opacity: 0.5 })
    expect(second!.enter?.y).toBeUndefined()
  })

  it('rolls up instead of keeping a couplet when the line after it would flash by', async () => {
    const p = await fastDraft()
    // d3 wraps to two rows and is sung right before d4, so it needs its turn waiting below d2.
    expect(of(p, 'd3', 'lyric')[0]!.text).toContain('\n')
    expect(of(p, 'd1', 'lyric')[0]!.end).toBe(of(p, 'd2', 'lyric')[0]!.start)
    const [waiting] = of(p, 'd3', 'preview')
    expect([waiting!.start, waiting!.end]).toEqual([
      of(p, 'd2', 'lyric')[0]!.start,
      of(p, 'd3', 'lyric')[0]!.start,
    ])
  })

  it('compiles the next line unlinked, smaller and dimmer, and the roll-up as keyframes', async () => {
    const project = makeProject({ lyrics: FAST })
    const p = await lyricDraft(project)
    const editor = new ProjectEditor(project)
    editor.dispatch(compilePlan(p, project).commands)
    const clips = Object.values(editor.getProject().clips).filter((c): c is TextClip => c.type === 'text')
    const meta = (c: TextClip) => c.meta?.director as { textRole?: string; lyricLineId?: string } | undefined
    const preview = clips.find((c) => meta(c)?.textRole === 'preview' && meta(c)?.lyricLineId === 'f2')!
    expect(preview.lyricLineId).toBeUndefined()
    expect(preview.opacity.value).toBe(0.5)
    expect(preview.transform.scaleX.value).toBe(0.72)
    const rolled = clips.find((c) => c.lyricLineId === 'f2')!
    expect(meta(rolled)).toMatchObject({ textRole: 'lyric', lyricLineId: 'f2' })
    expect(rolled.transform.y.keyframes?.map((k) => k.value)).toEqual([
      preview.transform.y.value,
      expect.any(Number),
    ])
    expect(rolled.transform.scaleY.keyframes?.map((k) => k.value)).toEqual([0.72, 1])
    expect(rolled.opacity.keyframes?.map((k) => [k.time, k.value])).toEqual([
      [0, 0.5],
      [0.2, 1],
    ])
  })
})
