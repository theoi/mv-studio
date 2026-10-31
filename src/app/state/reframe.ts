import {
  framingOverrides,
  reframeCommands,
  reframedFrom,
  reframeModeOf,
  setReframeModeCommand,
  type FrameSize,
  type ProjectReframe,
  type ReframeMode,
} from '../../export/index.ts'
import type { AspectPreset, Id, Project, VisualClip } from '../../model/index.ts'
import { readSubjectTrack } from '../../vision/analysisData.ts'
import { plural } from '../format.ts'
import { dispatch, editor } from './project.ts'
import { toast } from './ui.ts'

const REFRAME_LABEL = 'Reframe automatically'

function message(aspect: AspectPreset, reframe: ProjectReframe): string {
  const kinds = Object.values(reframe.changed)
  const count = (...of: string[]) => kinds.filter((k) => of.includes(k)).length
  const followed = count('reframed')
  const moved = count('text', 'moved')
  const other = kinds.length - followed - moved
  const centred = reframe.centred.length
  const locked = reframe.locked.length
  const parts = [
    followed
      ? `${plural(followed, 'clip')} ${followed === 1 ? 'follows its subject' : 'follow their subjects'}`
      : '',
    moved ? `${plural(moved, 'title or overlay', 'titles and overlays')} moved into the safe area` : '',
    other ? `${plural(other, 'clip')} reframed` : '',
    centred
      ? `${plural(centred, 'clip')} without subject analysis ${centred === 1 ? 'stays' : 'stay'} centered`
      : '',
    locked ? `${plural(locked, 'clip')} on locked tracks left as ${locked === 1 ? 'it is' : 'they are'}` : '',
  ].filter(Boolean)
  return parts.length ? `Reframed for ${aspect}: ${parts.join(', ')}.` : `Everything already fits ${aspect}.`
}

/**
 * Lays the clips out for the project's new aspect ratio (Preview › aspect ratio › Reframe automatically), from the
 * frame they had before: footage follows its subject, text and overlays move into the safe area. One undo step.
 */
export function reframeProject(from: FrameSize): void {
  const project = editor.getProject()
  const { aspect } = project.settings
  if (aspect === from.aspect) {
    toast(`The frame is ${aspect} again, so nothing was reframed.`)
    return
  }
  const reframe = reframeCommands(project, from, { overrides: framingOverrides(project, aspect) })
  if (reframe.commands.length === 0) {
    toast(message(aspect, reframe))
    return
  }
  if (!dispatch(reframe.commands, { label: REFRAME_LABEL })) return
  toast(message(aspect, reframe), {
    label: 'Undo',
    run: () => {
      if (editor.undoLabel() === REFRAME_LABEL) editor.undo()
    },
  })
}

/** The clip and the cutouts that put text behind its subject, which are framed like it. */
function withCutouts(project: Project, clipId: Id): Id[] {
  return [
    clipId,
    ...Object.values(project.clips)
      .filter((c) => c.meta?.behindSubjectOf === clipId)
      .map((c) => c.id),
  ]
}

/** How a clip fills other aspect ratios (Inspector › Framing): its own choice, else following the subject. */
export function clipReframeMode(project: Project, clipId: Id): ReframeMode {
  return reframeModeOf(project, clipId) ?? 'auto'
}

/**
 * Sets how a clip fills other aspect ratios, in Export and when the frame changes. A clip already reframed from
 * another aspect ratio is reframed again now. One undo step.
 */
export function setClipReframe(clipId: Id, mode: ReframeMode): void {
  const project = editor.getProject()
  const ids = withCutouts(project, clipId)
  const { aspect } = project.settings
  const overrides = { ...framingOverrides(project, aspect) }
  for (const id of ids) overrides[id] = { ...overrides[id], mode }
  const reframe = reframeCommands(project, project.settings, { overrides, clipIds: ids })
  dispatch([setReframeModeCommand(project, ids, mode), ...reframe.commands], { label: 'Change framing' })
}

/** The note under Inspector › Framing: where the choice applies, and why a clip is framed on its center. */
export function framingHint(project: Project, clip: VisualClip): string {
  const from = reframedFrom(clip)
  const mode = clipReframeMode(project, clip.id)
  const asset = 'assetId' in clip ? project.assets[clip.assetId] : undefined
  const centred = mode === 'auto' && asset && readSubjectTrack(project.analysis.visual[asset.id]) === null
  if (from && centred) return `Reframed from ${from.aspect} on its center, as it has no subject analysis yet.`
  if (from)
    return mode === 'auto'
      ? `Reframed from ${from.aspect} around its subject.`
      : `Reframed from ${from.aspect}.`
  if (centred) return 'Other aspect ratios use its center, as it has no subject analysis yet.'
  return 'How this clip fills other aspect ratios: in Export, and when you switch the frame.'
}
