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
import { layoutLine, lyricTypography, rowWidth, textWidth } from '../../../src/director/typography.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { Project, TextClip } from '../../../src/model/types.ts'
import { buildVisualAnalysis } from '../../../src/vision/index.ts'
import { LYRICS, makeProject, SECTIONS } from './fixtures.ts'

const VIDEOS = ['video1', 'video2', 'video3', 'video4']

async function lyricDraft(project: Project = makeProject(), prompt = ''): Promise<EditPlan> {
  return planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 1, prompt }))
}

const lyricLines = (p: EditPlan) => p.texts.filter((t) => t.role === 'lyric')
const main = (p: EditPlan): PlanShot[] => p.shots.filter((s) => s.layer === 'main')
/** Half the height of a text block as a fraction of the frame. */
const halfHeight = (t: PlanText) =>
  (t.text.split('\n').length * (t.style.lineHeight ?? 1.15) * (t.style.fontSize ?? 0)) / 1080 / 2

/** Every clip has a person facing the camera in the middle of the frame. */
function withFaces(project: Project): Project {
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
          focus: { x: 0.5, y: 0.42 },
          box: { x: 0.3, y: 0.15, width: 0.4, height: 0.85 },
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
    expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.75)
    const tall = lyricTypography({ aspect: '9:16', busy: false, catalog: DEFAULT_CATALOG }).style
    expect(layoutLine(text, tall, '9:16').text.split('\n').length).toBeGreaterThan(2)
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

  it('moves lines off faces', async () => {
    const plain = await lyricDraft()
    const faced = await lyricDraft(withFaces(makeProject()))
    const verse = (p: EditPlan) => p.texts.filter((t) => t.lyricLineId === 'l1' || t.lyricLineId === 'l2')
    expect(verse(plain).map((t) => t.position.y)).toEqual([0.5, 0.5])
    for (const t of verse(faced)) {
      // The face spans about y 0.3 to 0.54 of the frame.
      const top = t.position.y - halfHeight(t)
      const bottom = t.position.y + halfHeight(t)
      expect(top > 0.54 || bottom < 0.3).toBe(true)
      expect(top).toBeGreaterThanOrEqual(0.08)
      expect(bottom).toBeLessThanOrEqual(0.92)
    }
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
