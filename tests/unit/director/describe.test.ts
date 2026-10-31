import { describe, expect, it } from 'vitest'
import { buildPlannerInput, describePlan, planLocally, type EditPlan } from '../../../src/director/index.ts'
import type { Project } from '../../../src/model/types.ts'
import { makeProject } from './fixtures.ts'

async function draft(project: Project, kind: 'lyric' | 'visualizer'): Promise<EditPlan> {
  return planLocally(await buildPlannerInput(project, { kind, seed: 1 }))
}

describe('describePlan', () => {
  it('says what a lyric draft placed and what each section does', async () => {
    const project = makeProject()
    const plan = await draft(project, 'lyric')
    const { placed, sections } = describePlan(plan, project)
    const shots = plan.shots.filter((s) => s.layer === 'main').length
    expect(placed).toBe(`Placed ${shots} shots, 5 lyric lines and the ${plan.look!.name} look`)
    expect(sections.map((s) => s.id)).toEqual(plan.sections.map((s) => s.id))
    const text = (id: string) => sections.find((s) => s.id === id)!.text
    expect(text('s-intro')).toContain('title card')
    expect(text('s-chorus1')).toMatch(
      /^[A-Z].* · cuts (on every beat|every 2 beats|every bar|every 2 bars) · .*video\d.* · lyrics$/,
    )
    expect(text('s-outro')).not.toContain('lyrics')
  })

  it('counts scenes for visualizers', async () => {
    const project = makeProject({ videos: 0 })
    const plan = await draft(project, 'visualizer')
    const { placed, sections } = describePlan(plan, project)
    expect(placed).toMatch(/^Placed \d+ scenes/)
    expect(sections.find((s) => s.id === 's-verse')!.text).toContain('visuals that react to the music')
  })

  it('words the cutting rate against the bar (2 s at 120 BPM)', async () => {
    const project = makeProject()
    const plan = await draft(project, 'lyric')
    const template = plan.shots.find((s) => s.layer === 'main' && s.source.type === 'media')!
    const section = { ...plan.sections[0]!, id: 'x', start: 0, end: 8 }
    const every = (length: number) => {
      const shots = Array.from({ length: 8 / length }, (_, i) => ({
        ...template,
        id: `s${i}`,
        sectionId: 'x',
        start: i * length,
        end: (i + 1) * length,
      }))
      return describePlan({ ...plan, sections: [section], shots, texts: [] }, project).sections[0]!.text
    }
    expect(every(0.5)).toContain('cuts on every beat')
    expect(every(1)).toContain('cuts every 2 beats')
    expect(every(2)).toContain('cuts every bar')
    expect(every(4)).toContain('cuts every 2 bars')
    expect(every(8)).toContain('one long shot')
  })
})
