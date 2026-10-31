/**
 * Auto-cut: cuts the user's footage to the song's beats and sections. `planAutoCut` decides the shots (where to
 * cut, which clip, which part of it); `applyAutoCut` puts them on the Auto-cut track as one undo step.
 */
import { mediaFromProject, songInfoFromProject } from '../../director/inputs.ts'
import type { ProjectEditor } from '../../model/editor.ts'
import { newId } from '../../model/factory.ts'
import type { Id, Project } from '../../model/types.ts'
import { JobError } from '../../shared/jobs.ts'
import { readClipIndex } from '../analysisData.ts'
import { songEnergyScale } from '../footage/song.ts'
import type { FootageMatcher } from '../matching/matcher.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import type { TimeRange } from '../types.ts'
import {
  autoCutTrackState,
  compileAutoCut,
  expandRange,
  type AutoCutCompiled,
  type AutoCutShot,
} from './apply.ts'
import { chooseClips, MIN_PLAYBACK_RATE, type AutoCutOrder, type PoolItem } from './choose.ts'
import { cutSpans, type AutoCutOn, type AutoCutPace } from './rhythm.ts'

export type { AutoCutOn, AutoCutOrder, AutoCutPace, AutoCutShot, AutoCutCompiled }

export interface AutoCutOptions {
  /** Base cut interval (default 'bar'). */
  pace?: AutoCutPace
  /** Cut twice as often in high-energy sections and half as often in calm ones (default true). */
  followEnergy?: boolean
  /** Grid lines cuts may land on (default 'beats'). */
  cutOn?: AutoCutOn
  /** How clips are chosen (default 'matched'). */
  order?: AutoCutOrder
  /** Clips and stills to use (default: every imported or generated video and image). */
  assetIds?: Id[]
  /** Timeline range to cut (default: the whole song). */
  range?: TimeRange
  /** Same seed and project, same cut; "Try another" changes it (default 1). */
  seed?: number
}

export interface AutoCutPlan {
  version: 1
  id: string
  options: Required<Omit<AutoCutOptions, 'assetIds' | 'range'>> & { assetIds?: Id[] }
  /** Timeline range the cut replaces (the requested range, grown to whole earlier auto-cut clips). */
  range: TimeRange
  shots: AutoCutShot[]
  bpm: number
  /** True when there was no beat analysis and cuts follow an even grid. */
  estimatedGrid: boolean
  warnings: string[]
}

export interface AutoCutDeps {
  /** Footage matcher (`vision.matcher`); without it "matched" picks for variety. */
  matcher?: Pick<FootageMatcher, 'model' | 'rankAll'>
}

/** Job kind for `jobs.run`, so the Assist panel can follow a running auto-cut. */
export const AUTOCUT_JOB = 'edit.autocut'

const DEFAULTS = { pace: 'bar', followEnergy: true, cutOn: 'beats', order: 'matched', seed: 1 } as const

function poolFor(project: Project, assetIds: Id[] | undefined): PoolItem[] {
  const wanted = assetIds ? new Set(assetIds) : undefined
  return mediaFromProject(project)
    .filter((m) => !wanted || wanted.has(m.assetId))
    .filter((m) => m.kind === 'image' || (m.duration ?? 0) > 0)
    .map((m) => {
      const index = readClipIndex(project.analysis.visual[m.assetId])
      return {
        assetId: m.assetId,
        kind: m.kind,
        name: m.name,
        ...(m.kind === 'video' ? { duration: m.duration } : {}),
        ...(index ? { index } : {}),
      }
    })
}

/** Shots for an auto-cut of the project's song. Throws JobError('invalid-input') without a song or clips. */
export async function planAutoCut(
  project: Project,
  options: AutoCutOptions = {},
  deps: AutoCutDeps = {},
  task: TaskOptions = {},
): Promise<AutoCutPlan> {
  const progress = createProgress(task.onProgress)
  const resolved = {
    pace: options.pace ?? DEFAULTS.pace,
    followEnergy: options.followEnergy ?? DEFAULTS.followEnergy,
    cutOn: options.cutOn ?? DEFAULTS.cutOn,
    order: options.order ?? DEFAULTS.order,
    seed: options.seed ?? DEFAULTS.seed,
    ...(options.assetIds ? { assetIds: [...options.assetIds] } : {}),
  }
  const song = songInfoFromProject(project)
  if (!song.assetId || !(song.duration > 0))
    throw new JobError('invalid-input', 'Add a song first: auto-cut cuts your clips to its beats.')
  const pool = poolFor(project, options.assetIds)
  if (!pool.length)
    throw new JobError(
      'invalid-input',
      'Import some video clips or images first: auto-cut cuts them to the song.',
    )
  progress(0.05, 'planning')

  const state = autoCutTrackState(project)
  const requested = {
    start: Math.max(0, options.range?.start ?? 0),
    end: Math.min(song.duration, options.range?.end ?? song.duration),
  }
  if (!(requested.end - requested.start > 0.05))
    throw new JobError('invalid-input', 'The range to cut is empty.')
  const range = expandRange(requested, state.replaceable)
  const avoid = state.kept.map((c) => ({ start: c.start, end: c.start + c.duration }))
  const stills = pool.some((p) => p.kind === 'image')
  const longest = Math.max(0, ...pool.map((p) => p.duration ?? 0))
  const rhythm = cutSpans(song, {
    pace: resolved.pace,
    followEnergy: resolved.followEnergy,
    cutOn: resolved.cutOn,
    range,
    avoid,
    ...(stills ? {} : { maxShot: longest / MIN_PLAYBACK_RATE }),
  })
  progress(0.15, 'matching')

  const energyAt = songEnergyScale(project)
  const { picks, warnings } = await chooseClips({
    spans: rhythm.spans,
    pool,
    order: resolved.order,
    ...(project.lyrics ? { lyrics: project.lyrics } : {}),
    ...(energyAt ? { energyAt } : {}),
    ...(deps.matcher ? { matcher: deps.matcher } : {}),
    seed: resolved.seed,
    ...(task.signal ? { signal: task.signal } : {}),
  })
  const shots: AutoCutShot[] = []
  rhythm.spans.forEach((span, i) => {
    const pick = picks[i]
    if (pick) shots.push({ start: span.start, end: span.end, sectionId: span.sectionId, ...pick })
  })
  if (rhythm.grid.estimated)
    warnings.unshift(
      `The song's beats aren't analyzed yet, so cuts follow an even ${Math.round(rhythm.grid.bpm)} BPM grid.`,
    )
  if (state.lockedTrack && !state.track)
    warnings.push('The Auto-cut track is locked, so the new cut goes on a new track above it.')
  progress(1, 'done')
  return {
    version: 1,
    id: newId(),
    options: resolved,
    range,
    shots,
    bpm: rhythm.grid.bpm,
    estimatedGrid: rhythm.grid.estimated,
    warnings,
  }
}

/** Commands for a plan against the project as it is now (see `compileAutoCut`). */
export function autoCutCommands(project: Project, plan: AutoCutPlan): AutoCutCompiled {
  const compiled = compileAutoCut(project, plan)
  const warnings = [...plan.warnings, ...compiled.warnings.filter((w) => !plan.warnings.includes(w))]
  return { ...compiled, warnings }
}

/** Applies a plan as one undo step. */
export function applyAutoCut(
  editor: Pick<ProjectEditor, 'getProject' | 'dispatch'>,
  plan: AutoCutPlan,
): AutoCutCompiled {
  const compiled = autoCutCommands(editor.getProject(), plan)
  if (compiled.stats.cuts === 0)
    throw new JobError('invalid-input', 'There was nothing to cut in that range.')
  editor.dispatch(compiled.commands, { label: compiled.label })
  return compiled
}

export interface AutoCutResult extends AutoCutCompiled {
  plan: AutoCutPlan
}

/**
 * Plans and applies an auto-cut, for `jobs.run({ kind: 'edit.autocut', run: (ctx) => autoCut(deps, options,
 * fromJob(ctx)) })`. Undo is the editor's: the cut is the latest undo step, labeled `label`.
 */
export async function autoCut(
  deps: AutoCutDeps & { editor: Pick<ProjectEditor, 'getProject' | 'dispatch'> },
  options: AutoCutOptions = {},
  task: TaskOptions = {},
): Promise<AutoCutResult> {
  const plan = await planAutoCut(deps.editor.getProject(), options, deps, task)
  if (task.signal?.aborted) throw new JobError('cancelled', 'Cancelled')
  return { ...applyAutoCut(deps.editor, plan), plan }
}
