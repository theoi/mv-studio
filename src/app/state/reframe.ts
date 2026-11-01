import {
  aspectCommands,
  framingOverrides,
  layoutFrameOf,
  projectReframe,
  reframeCommands,
  reframedFrom,
  reframeModeOf,
  reframeOffer,
  setReframeModeCommand,
  type ProjectReframe,
  type ReframeMode,
} from '../../export/index.ts'
import {
  settingsForAspect,
  type AspectPreset,
  type Id,
  type Project,
  type VisualClip,
} from '../../model/index.ts'
import { readSubjectTrack } from '../../vision/analysisData.ts'
import { plural } from '../format.ts'
import { dispatch, editor } from './project.ts'
import { set, toast, type Toast } from './ui.ts'

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
      ? `${plural(centred, 'clip')} ${centred === 1 ? 'stays' : 'stay'} centered (no subject analysis yet)`
      : '',
    locked ? `${plural(locked, 'clip')} on locked tracks left as ${locked === 1 ? 'it is' : 'they are'}` : '',
  ].filter(Boolean)
  return parts.length
    ? [`Reframed for ${aspect}`, ...parts].join(' · ')
    : `Everything already fits ${aspect}.`
}

const OFFERS = { reframe: 'Reframe automatically', restore: 'Restore layout' } as const

type ToastAction = NonNullable<Toast['action']>

/** The actions of the offers and results shown here, which a newer frame change makes stale. */
const shown = new WeakSet<ToastAction>()

/** The offer on screen. It stays until it is taken or dismissed, or no longer applies (see below). */
let offerShown: ToastAction | null = null

function show(message: string, action: ToastAction, offer = false): void {
  shown.add(action)
  if (offer) offerShown = action
  toast(message, action, { sticky: offer })
}

/** Removes earlier offers and results with Undo: after a newer frame change they no longer apply. */
function withdrawToasts(): void {
  set((s) => ({ toasts: s.toasts.filter((t) => !t.action || !shown.has(t.action)) }))
  offerShown = null
}

// An offer outlives the change that made it, so it goes once the clips fit the frame by other means: the aspect change
// undone, or the offer taken in Inspector › Project.
editor.subscribe(() => {
  const offer = offerShown
  if (!offer || reframeOffer(editor.getProject())) return
  offerShown = null
  set((s) => ({ toasts: s.toasts.filter((t) => t.action !== offer) }))
})

/** What Inspector › Project says under Aspect while the clips are laid out for another frame, and its button. */
export function lastingOffer(project: Project): { note: string; label: string } | null {
  const offer = reframeOffer(project)
  if (!offer) return null
  return offer === 'restore'
    ? { note: `The clips can go back to their ${project.settings.aspect} layout.`, label: OFFERS.restore }
    : { note: `The clips are still laid out for ${layoutFrameOf(project).aspect}.`, label: OFFERS.reframe }
}

/**
 * Lays the clips out for the project's frame from the frame they are laid out for (the offer after an aspect
 * change): footage follows its subject, text and overlays move into the safe area, and clips back in the frame they
 * were made for get their layout back. One undo step.
 */
export function reframeProject(): void {
  const project = editor.getProject()
  const { aspect } = project.settings
  const offer = reframeOffer(project)
  if (!offer) {
    toast(`The clips already fit ${aspect}.`)
    return
  }
  const reframe = projectReframe(project, { overrides: framingOverrides(project, aspect) })
  const label = OFFERS[offer]
  if (!dispatch(reframe.commands, { label })) return
  const restored = Object.keys(reframe.changed).length
  show(
    offer === 'restore'
      ? `Restored the ${aspect} layout of ${plural(restored, 'clip')}.`
      : message(aspect, reframe),
    {
      label: 'Undo',
      run: () => {
        if (editor.undoLabel() === label) editor.undo()
      },
    },
  )
}

/**
 * Changes the project's aspect ratio (Preview, Inspector › Project, the palette), then offers to reframe the clips
 * for it, or to restore the layout they had in it. The clips are not touched until the offer is taken.
 */
export function changeAspect(aspect: AspectPreset): void {
  const project = editor.getProject()
  if (aspect === project.settings.aspect) return
  const settings = settingsForAspect(aspect, project.settings.fps)
  if (!dispatch(aspectCommands(project, settings), { label: 'Change aspect ratio' })) return
  withdrawToasts()
  const offer = reframeOffer(editor.getProject())
  if (offer === 'restore')
    show(
      `Back to ${aspect}. Restore the ${aspect} layout?`,
      { label: OFFERS.restore, run: reframeProject },
      true,
    )
  else if (offer === 'reframe')
    show(
      `Switched to ${aspect}. Keep subjects in frame?`,
      { label: OFFERS.reframe, run: reframeProject },
      true,
    )
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
  const reframe = reframeCommands(project, layoutFrameOf(project), { overrides, clipIds: ids })
  dispatch([setReframeModeCommand(project, ids, mode), ...reframe.commands], { label: 'Change framing' })
}

/** The note under Inspector › Framing: where the choice applies, and why a clip is framed on its center. */
export function framingHint(project: Project, clip: VisualClip): string {
  const from = reframedFrom(clip)
  const mode = clipReframeMode(project, clip.id)
  const asset = 'assetId' in clip ? project.assets[clip.assetId] : undefined
  const centred = mode === 'auto' && asset && readSubjectTrack(project.analysis.visual[asset.id]) === null
  if (from && centred)
    return `Reframed from ${from.aspect} and kept centered: it has no subject analysis yet.`
  if (from)
    return mode === 'auto'
      ? `Reframed from ${from.aspect} around its subject.`
      : `Reframed from ${from.aspect}.`
  if (centred) return 'Other aspect ratios keep it centered: it has no subject analysis yet.'
  return 'Used in Export and when you change the aspect ratio.'
}
