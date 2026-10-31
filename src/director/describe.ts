/**
 * Plain-language description of a plan for the Director panel: what applying it placed, and what happens in each
 * section ("Steady, grounded · cuts every bar · Night city, Singer close-up · lyrics").
 */
import type { Id, Project } from '../model/types.ts'
import type { EditPlan, PlanSection, PlanShot } from './plan.ts'

export interface PlanDescription {
  /** e.g. "Placed 38 shots, 33 lyric lines and the Neon night look" */
  placed: string
  sections: { id: Id; text: string }[]
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const assetName = (project: Project, id: Id) =>
  (project.assets[id]?.name ?? 'a clip').replace(/\.[a-z0-9]{2,4}$/i, '')

function inSection(shot: { sectionId?: string; start: number; end: number }, section: PlanSection) {
  if (shot.sectionId) return shot.sectionId === section.id
  const mid = (shot.start + shot.end) / 2
  return mid >= section.start && mid < section.end
}

/** How often the picture changes, relative to the bar. */
function cadence(shots: PlanShot[], section: PlanSection, barSeconds: number): string {
  if (shots.length <= 1) return 'one long shot'
  const mean = (section.end - section.start) / shots.length
  const bars = mean / barSeconds
  if (bars < 0.375) return 'cuts on every beat'
  if (bars < 0.75) return 'cuts every 2 beats'
  if (bars < 1.5) return 'cuts every bar'
  if (bars < 3) return 'cuts every 2 bars'
  return 'long shots'
}

function sources(shots: PlanShot[], project: Project): string | undefined {
  const names = [
    ...new Set(
      shots.flatMap((s) => (s.source.type === 'media' ? [assetName(project, s.source.assetId)] : [])),
    ),
  ]
  const generated = shots.filter((s) => s.source.type === 'generate').length
  const parts: string[] = []
  if (names.length > 2) parts.push(`${names.slice(0, 2).join(', ')} and ${names.length - 2} more`)
  else if (names.length) parts.push(list(names))
  if (generated) parts.push(plural(generated, 'AI shot'))
  return parts.length ? parts.join(', ') : undefined
}

export function describePlan(plan: EditPlan, project: Project): PlanDescription {
  const bpm = (plan.songAssetId && project.analysis.audio[plan.songAssetId]?.tempo?.bpm) || 120
  const bar = (4 * 60) / bpm
  const main = plan.shots.filter((s) => s.layer === 'main')
  const visualizer = plan.kind === 'visualizer'
  const lyricLines = new Set(plan.texts.filter((t) => t.role === 'lyric').map((t) => t.lyricLineId ?? t.id))
    .size
  const placed = [plural(main.length, visualizer ? 'scene' : 'shot')]
  if (lyricLines) placed.push(plural(lyricLines, 'lyric line'))
  if (plan.look) placed.push(`the ${plan.look.name} look`)
  return {
    placed: `Placed ${list(placed)}`,
    sections: plan.sections.map((section) => {
      const shots = main.filter((s) => inSection(s, section))
      const texts = plan.texts.filter((t) => inSection(t, section))
      const parts = [capitalize(section.mood)]
      const generators = shots.filter((s) => s.source.type === 'generator').length
      if (generators && generators === shots.length) parts.push('visuals that react to the music')
      else if (shots.length) parts.push(cadence(shots, section, bar))
      const from = sources(shots, project)
      if (from) parts.push(from)
      if (texts.some((t) => t.role === 'title')) parts.push('title card')
      if (texts.some((t) => t.behind)) parts.push('lyrics behind the subject')
      else if (texts.some((t) => t.role === 'lyric')) parts.push('lyrics')
      return { id: section.id, text: parts.join(' · ') }
    }),
  }
}
