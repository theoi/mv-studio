/**
 * The local planner: works with no keys and no network. It derives a creative brief from the song analysis, the
 * prompt and the user's media with rules, then expands it into a full plan.
 */
import type { CreativeBrief } from './brief.ts'
import { expandBrief } from './expand.ts'
import type { PlannerInput } from './inputs.ts'
import type { EditPlan } from './plan.ts'
import { DEFAULT_CONCEPT, defaultSectionBrief, defaultVisual, pickLook } from './rules.ts'
import { beatGrid, sectionsFor } from './timing.ts'

const TITLES = {
  lyric: 'Lyric video',
  visualizer: 'Visualizer',
  'beat-cut': 'Beat cut',
  ai: 'Music video',
} as const

export function ruleBrief(input: PlannerInput): CreativeBrief {
  const grid = beatGrid(input.song)
  const sections = sectionsFor(input.song, grid)
  const visual = defaultVisual(input)
  const look = pickLook(input.prompt, input.kind, input.catalog)
  const generated = visual === 'generated'
  return {
    title: input.prompt ? input.prompt.slice(0, 60) : TITLES[input.kind],
    concept: input.prompt || DEFAULT_CONCEPT[input.kind],
    lookId: look?.id,
    visual,
    text: { show: input.kind === 'lyric', karaoke: true },
    sections: sections.map((s) => defaultSectionBrief(s, input, grid.bpm, generated)),
  }
}

export function planLocally(input: PlannerInput): Promise<EditPlan> {
  return expandBrief(ruleBrief(input), input, { planner: 'local' })
}
