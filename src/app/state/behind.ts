import type { Asset, Clip, EditCommand, Project, Track } from '../../model/index.ts'
import { mediaById } from '../mock/media.ts'
import { maskStorageKey, sceneOf } from '../mock/demoProject.ts'
import { dispatch, editor } from './project.ts'

/*
 * "Behind the subject": the footage clip is duplicated onto a Subject track above the lyrics and restricted to the
 * person with a matte, so text plays between the person and the background on exactly that clip. Masks for sample
 * footage come from the procedural scenes; imported footage gets them from src/vision.
 */

const SUBJECT_TRACK_NAME = 'Subject'
type MediaClip = Extract<Clip, { type: 'video' | 'image' }>

/** The sample scene with a person large enough to cut out, if the clip's footage has one. */
function subjectScene(project: Project, clip: Clip | undefined) {
  if (!clip || (clip.type !== 'video' && clip.type !== 'image')) return undefined
  const asset = project.assets[clip.assetId]
  const scene = sceneOf(asset)
  return scene && mediaById[clip.assetId]?.subject === 'large' ? scene : undefined
}

export function canCutOut(project: Project, clip: Clip | undefined): boolean {
  return !!subjectScene(project, clip)
}

export function cutoutsOf(project: Project, clipId: string): Clip[] {
  return Object.values(project.clips).filter((c) => c.meta?.behindSubjectOf === clipId)
}

export function hasCutout(project: Project, clipId: string): boolean {
  return cutoutsOf(project, clipId).length > 0
}

/** Footage clips on the timeline with a person who fills the frame. */
export function suitableClips(project: Project): string[] {
  return Object.values(project.clips)
    .filter((c) => !c.meta?.behindSubjectOf && canCutOut(project, c))
    .map((c) => c.id)
}

/** Cuts the subject out of each clip onto the Subject track, as one undo step. Returns how many clips changed. */
export function putBehind(clipIds: string[]): number {
  const project = editor.getProject()
  const commands: EditCommand[] = []
  let track: Track | undefined = project.tracks.find(
    (t) => t.kind === 'visual' && t.name === SUBJECT_TRACK_NAME && !t.locked,
  )
  if (!track) {
    track = {
      id: crypto.randomUUID(),
      kind: 'visual',
      name: SUBJECT_TRACK_NAME,
      muted: false,
      solo: false,
      locked: false,
      hidden: false,
    }
    commands.push({ type: 'track.add', track, index: 0 })
  }
  const masks = new Set<string>()
  let count = 0
  for (const id of clipIds) {
    const clip = project.clips[id] as MediaClip | undefined
    const scene = subjectScene(project, clip)
    if (!clip || !scene || hasCutout(project, id)) continue
    const source = project.assets[clip.assetId] as Asset
    const maskId = `mask-${source.id}`
    if (!project.assets[maskId] && !masks.has(maskId)) {
      masks.add(maskId)
      commands.push({
        type: 'asset.add',
        asset: {
          id: maskId,
          kind: 'image',
          name: `${source.name} (subject mask)`,
          mimeType: 'image/png',
          byteSize: 0,
          storageKey: maskStorageKey(scene),
          width: source.width,
          height: source.height,
          origin: { type: 'derived', parentAssetId: source.id },
          createdAt: new Date().toISOString(),
        },
      })
    }
    commands.push({
      type: 'clip.add',
      clip: {
        ...structuredClone(clip),
        id: crypto.randomUUID(),
        trackId: track.id,
        name: `${clip.name ?? source.name} · subject`,
        matte: { maskAssetId: maskId, sourceAssetId: source.id, mode: 'inside', feather: 0.15 },
        meta: { behindSubjectOf: id },
      },
    })
    count++
  }
  if (!count) return 0
  return dispatch(commands, { label: 'Put lyrics behind the subject' }) ? count : 0
}

export function bringToFront(clipIds: string[]): boolean {
  const project = editor.getProject()
  const ids = clipIds.flatMap((id) => cutoutsOf(project, id).map((c) => c.id))
  if (!ids.length) return false
  return dispatch({ type: 'clip.remove', clipIds: ids }, { label: 'Bring lyrics to the front' })
}
