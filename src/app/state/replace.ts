/**
 * Replace with…: a video clip or image shows another video or image from the library and keeps everything else. From
 * the clip menu and the palette (a list of the library's media), a Library › Media card's menu, or a card dropped on
 * the clip with Alt held.
 */
import {
  createVideoClip,
  type Asset,
  type Clip,
  type EditCommand,
  type EffectInstance,
  type Id,
  type ImageClip,
  type Project,
  type VideoClip,
} from '../../model/index.ts'
import { CAMERA_EFFECT_ID } from '../../vision/render/cameraEffect.ts'
import { cutoutsOf } from './behind.ts'
import { libraryAssets, undoAction } from './library.ts'
import { dispatch, editor, viewOf } from './project.ts'
import { select, selectedClipIds, toast, type Selection } from './ui.ts'

type Picture = VideoClip | ImageClip

const baseName = (name: string) => name.replace(/\.[^.]+$/, '')

/** A clip Replace can give other footage: a video clip or image that isn't a cutout of another clip. */
export function isReplaceable(clip: Clip | undefined): clip is Picture {
  return !!clip && (clip.type === 'video' || clip.type === 'image') && !clip.meta?.behindSubjectOf
}

/** The selected clip Replace acts on, or why there is none. */
export function replaceTarget(project: Project, selection: Selection): { clip: Picture } | { why: string } {
  const ids = selectedClipIds(selection)
  if (ids.length > 1) return { why: 'Select one clip' }
  const clip = ids[0] === undefined ? undefined : project.clips[ids[0]]
  if (!isReplaceable(clip)) return { why: 'Select a video clip or image first' }
  if (project.tracks.find((t) => t.id === clip.trackId)?.locked) return { why: 'Its track is locked' }
  return { clip }
}

/** The library's videos and images, which a clip can show instead. */
export function replacementAssets(project: Project): Asset[] {
  return libraryAssets(project).filter((a) => a.kind === 'video' || a.kind === 'image')
}

/**
 * The clip showing `asset` instead. New footage plays from its start; a mask made from the old footage goes, and so does
 * the depth of a 3D camera move made from the old image: the move stays flat on a new image, and goes on a video (moves
 * are made for images).
 */
function withFootage(
  project: Project,
  clip: Picture,
  asset: Asset,
  name: string | undefined,
): { next: Picture; camera?: 'flat' | 'gone' } {
  let next: Picture
  if (asset.kind === 'image') {
    if (clip.type === 'image') next = { ...clip, assetId: asset.id }
    else {
      const { sourceStart: _s, playbackRate: _r, volume: _v, muted: _m, ...picture } = clip
      next = { ...picture, type: 'image', assetId: asset.id }
    }
  } else if (clip.type === 'video') next = { ...clip, assetId: asset.id, sourceStart: 0 }
  else {
    const fresh = createVideoClip({
      trackId: clip.trackId,
      assetId: asset.id,
      start: clip.start,
      duration: clip.duration,
    })
    next = {
      ...clip,
      type: 'video',
      assetId: asset.id,
      sourceStart: 0,
      playbackRate: 1,
      volume: fresh.volume,
      muted: fresh.muted,
    }
  }
  if (name === undefined) delete next.name
  else next.name = name
  if (next.matte?.sourceAssetId === clip.assetId) delete next.matte
  const oldDepth = (fx: EffectInstance) => {
    const depth = fx.params.depth?.value
    return (
      fx.effectId === CAMERA_EFFECT_ID &&
      typeof depth === 'string' &&
      project.assets[depth]?.origin.parentAssetId === clip.assetId
    )
  }
  if (!next.effects.some(oldDepth)) return { next }
  if (next.type === 'video')
    return { next: { ...next, effects: next.effects.filter((fx) => !oldDepth(fx)) }, camera: 'gone' }
  const effects = next.effects.map((fx) =>
    oldDepth(fx) ? { ...fx, params: { ...fx.params, depth: { ...fx.params.depth, value: '' } } } : fx,
  )
  return { next: { ...next, effects }, camera: 'flat' }
}

/**
 * Has a video clip or image show another video or image from the library, as one undo step. It keeps its id, place,
 * length, track, effects, transform, keyframes, reactions and transitions, and is selected. A name that was the old
 * file's becomes the new file's. Its cutouts for text behind the subject show the old footage, so they go with it,
 * except one on a locked track.
 */
export function replaceClipMedia(clipId: Id, assetId: Id): boolean {
  const project = editor.getProject()
  const clip = project.clips[clipId]
  const asset = project.assets[assetId]
  if (!isReplaceable(clip) || !asset || (asset.kind !== 'video' && asset.kind !== 'image')) return false
  const newName = baseName(asset.name)
  if (clip.assetId === assetId) {
    toast(`It already shows “${newName}”`)
    return false
  }
  const oldName = viewOf(project, clip).name
  const old = project.assets[clip.assetId]
  const name =
    clip.name === undefined ? undefined : old && clip.name === baseName(old.name) ? newName : clip.name
  const { next, camera } = withFootage(project, clip, asset, name)
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const cutouts = cutoutsOf(project, clip.id).filter((c) => !locked.has(c.trackId))
  const label = `Replace ${oldName} with ${newName}`
  const commands: EditCommand[] = [
    { type: 'clip.remove', clipIds: [clip.id, ...cutouts.map((c) => c.id)] },
    { type: 'clip.add', clip: next },
  ]
  if (!dispatch(commands, { label })) return false
  select({ type: 'clip', id: clip.id })
  const shorter =
    next.type === 'video' && asset.duration !== undefined
      ? clip.duration * next.playbackRate - asset.duration
      : 0
  const notes = [
    shorter > 0.05 && `It’s ${shorter.toFixed(1)} s shorter, so its last frame holds at the end.`,
    camera === 'flat' && 'Its 3D camera move is flat now: choose Add depth under Motion.',
    camera === 'gone' && '3D camera moves are for images, so its move went with the old image.',
    cutouts.length > 0 && 'Its cutout for text behind the subject went with the old footage.',
  ].filter(Boolean)
  const done = `Replaced “${oldName}” with “${newName}”`
  toast(notes.length ? `${done}. ${notes.join(' ')}` : done, undoAction(label))
  return true
}

/** The clip on a track at `time` that a media card dropped there with Alt held replaces. */
export function replaceableAt(project: Project, trackId: Id, time: number): Picture | undefined {
  return Object.values(project.clips).find(
    (c): c is Picture =>
      isReplaceable(c) && c.trackId === trackId && c.start <= time && time < c.start + c.duration,
  )
}
