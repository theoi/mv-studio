import { applyMat, fitSize, layerMatrix, type Mat2D } from '../../engine/layout.ts'
import type { Asset, EditCommand, Matte, Project } from '../../model/index.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { JobError, jobs, type JobHandle } from '../../shared/jobs.ts'
import type { SelectionClick } from '../../vision/index.ts'
import { plural } from '../format.ts'
import {
  cutoutsOf,
  footageOf,
  objectMeta,
  objectOf,
  subjectTrack,
  useBehind,
  type CutoutResult,
  type ObjectPick,
  type VideoClip,
} from './behind.ts'
import { visionService } from './footage.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { appMedia } from './media.ts'
import { startPick } from './pick.ts'
import { dispatch, editor } from './project.ts'
import { get as ui, set as setUi, toast } from './ui.ts'

/*
 * Behind an object the user clicks in the preview: the clicked object is followed through the clip (src/vision
 * selectionTrack), encoded as a mask video and used for the clip's cutout on the Subject track instead of the person.
 */

export const OBJECT_CUTOUT_LABEL = 'Put lyrics behind the object'
/** Marks object mask videos among an asset's derived media. */
const OBJECT_MASK = 'vision.object-mask'
const PICK_PROMPT = 'Click the object to put the lyrics behind'
const FIX_PROMPT = 'Click the object again, here where it was lost'

type Point = { x: number; y: number }

export interface FootageHit {
  clip: VideoClip
  asset: Asset
  /** The point in the footage frame, 0..1 from the top-left. */
  point: Point
  /** The footage time shown at the picked time. */
  mediaTime: number
}

export function mediaTimeOf(clip: VideoClip, time: number): number {
  return clip.sourceStart + (time - clip.start) * clip.playbackRate
}

/** The timeline time inside the clip where it shows footage time `t`. */
export function timelineTimeOf(clip: VideoClip, t: number): number {
  const rate = clip.playbackRate > 0 ? clip.playbackRate : 1
  const at = clip.start + (t - clip.sourceStart) / rate
  return Math.min(clip.start + clip.duration - 0.01, Math.max(clip.start, at))
}

function footageMatrix(project: Project, clip: VideoClip, asset: Asset, time: number): Mat2D {
  const { width, height } = project.settings
  const [bw, bh] = fitSize(clip.fit, asset.width ?? width, asset.height ?? height, width, height)
  return layerMatrix(clip, time - clip.start, time, bw, bh, width, height)
}

/**
 * The top-most footage clip drawn at a canvas point (0..1 from the top-left) at `time`, and the point in its frame.
 * With `onlyClipId`, only that clip counts. Cutouts are skipped: they show their host's footage.
 */
export function footageAt(
  project: Project,
  at: Point,
  time: number,
  onlyClipId?: string,
): FootageHit | undefined {
  const { width, height } = project.settings
  const visual = project.tracks.filter((t) => t.kind === 'visual' && !t.hidden)
  const soloed = visual.some((t) => t.solo)
  for (const track of visual) {
    if (soloed && !track.solo) continue
    for (const c of Object.values(project.clips)) {
      if (c.trackId !== track.id || !c.enabled || time < c.start || time >= c.start + c.duration) continue
      if (onlyClipId && c.id !== onlyClipId) continue
      const footage = footageOf(project, c)
      if (!footage) continue
      const [a, b, cc, d, e, f] = footageMatrix(project, footage.clip, footage.asset, time)
      const det = a * d - b * cc
      if (Math.abs(det) < 1e-9) continue
      const x = at.x * width - e
      const y = at.y * height - f
      const u = (d * x - cc * y) / det
      const v = (a * y - b * x) / det
      if (u < 0 || u > 1 || v < 0 || v > 1) continue
      return { ...footage, point: { x: u, y: v }, mediaTime: mediaTimeOf(footage.clip, time) }
    }
  }
  return undefined
}

/** The clip's corners on the canvas (0..1) at `time`. */
function outlineOf(project: Project, hit: FootageHit, time: number): [number, number][] {
  const m = footageMatrix(project, hit.clip, hit.asset, time)
  const { width, height } = project.settings
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => {
    const [x, y] = applyMat(m, u!, v!)
    return [x / width, y / height]
  })
}

/** How well a picked object was followed: "Followed through 86% of the clip. Lost in 2 places." */
export function trackingText(pick: ObjectPick): string {
  const followed =
    pick.tracked >= 0.995
      ? 'Followed through the whole clip.'
      : `Followed through ${Math.round(pick.tracked * 100)}% of the clip.`
  return pick.fix.length ? `${followed} Lost in ${plural(pick.fix.length, 'place')}.` : followed
}

/**
 * Commands that make the object mask the clip's cutout: the cutout clip on the Subject track gets the new matte, or
 * is added when the clip has none. One undo step with the mask asset.
 */
export function objectCutoutCommands(
  project: Project,
  hostId: string,
  mask: Asset,
  pick: ObjectPick,
): EditCommand[] {
  const footage = footageOf(project, project.clips[hostId])
  if (!footage) return []
  const { clip, asset } = footage
  const matte: Matte = { maskAssetId: mask.id, sourceAssetId: asset.id, mode: 'inside', feather: 0.15 }
  const meta = objectMeta(hostId, pick)
  const commands: EditCommand[] = project.assets[mask.id] ? [] : [{ type: 'asset.add', asset: mask }]
  const existing = cutoutsOf(project, hostId)[0]
  if (existing)
    return [
      ...commands,
      { type: 'clip.set', clipId: existing.id, path: ['matte'], value: matte },
      { type: 'clip.set', clipId: existing.id, path: ['meta'], value: meta },
    ]
  const track = subjectTrack(project)
  return [
    ...track.commands,
    ...commands,
    {
      type: 'clip.add',
      clip: {
        ...structuredClone(clip),
        id: crypto.randomUUID(),
        trackId: track.track.id,
        name: `${clip.name ?? asset.name} · subject`,
        matte,
        meta,
      },
    },
  ]
}

/**
 * Follows the clicked object through the clip and makes it the clip's cutout, as a job and one undo step.
 * `corrections` are later clicks on the same object where it was lost.
 */
export function cutOutObject(
  hostId: string,
  click: SelectionClick,
  corrections: SelectionClick[] = [],
): JobHandle<CutoutResult> | undefined {
  if (isRunning(JOB_KINDS.cutout)) return undefined
  let jobId = ''
  const handle = jobs.run({
    kind: JOB_KINDS.cutout,
    title: 'Cutting out the object',
    run: async (ctx) => {
      const gone = () => new JobError('invalid-input', 'The clip is no longer on the timeline.')
      const start = editor.getProject()
      const footage = footageOf(start, start.clips[hostId])
      if (!footage) throw gone()
      const { clip, asset } = footage
      const message = `Following the object · ${asset.name}`
      ctx.progress({ fraction: 0, message })
      const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
      const source = v.createAssetFrameSource(asset, appMedia)
      try {
        const end = Math.min(
          source.duration,
          clip.sourceStart + clip.duration * Math.max(0, clip.playbackRate),
        )
        const selection = await vision.selectionTrack(source, click, {
          corrections,
          range: end > clip.sourceStart ? { start: clip.sourceStart, end } : undefined,
          signal: ctx.signal,
          onProgress: (p) => ctx.progress({ fraction: 0.85 * (p.fraction ?? 0), message }),
        })
        if (selection.trackedFraction <= 0)
          throw new JobError('invalid-input', 'Nothing to follow there. Click on the object itself.')
        const blob = await v.encodeMaskVideo(selection.track, {
          duration: asset.duration ?? source.duration,
          signal: ctx.signal,
          onProgress: (p) => ctx.progress({ fraction: 0.85 + 0.1 * (p.fraction ?? 0), message }),
        })
        const info = v.maskAssetInfo(asset, blob)
        const mask = await mediaStore.storeBlob(blob, {
          ...info,
          name: info.name.replace('(subject mask)', '(object mask)'),
          origin: { ...info.origin, provider: OBJECT_MASK },
        })
        ctx.throwIfCancelled()
        const pick: ObjectPick = {
          click,
          corrections,
          tracked: selection.trackedFraction,
          fix: selection.needsCorrection,
        }
        const commands = objectCutoutCommands(editor.getProject(), hostId, mask, pick)
        if (!commands.length) throw gone()
        if (!dispatch(commands, { label: OBJECT_CUTOUT_LABEL }))
          throw new JobError(
            'invalid-input',
            'The cutout could not be added. Unlock the Subject track and try again.',
          )
        const result: CutoutResult = { count: 1, skipped: 0, label: OBJECT_CUTOUT_LABEL, object: pick }
        useBehind.setState((s) => ({ results: { ...s.results, [jobId]: result } }))
        return result
      } finally {
        source.dispose()
      }
    },
  })
  jobId = handle.id
  useBehind.setState((s) => ({ requests: { ...s.requests, [jobId]: { clips: [hostId], object: true } } }))
  return handle
}

function undoToast(message: string, result: CutoutResult) {
  toast(message, {
    label: 'Undo',
    run: () => {
      if (editor.undoLabel() === result.label) editor.undo()
      else toast('The project has changed since. Use Undo in the top bar to step back.')
    },
  })
}

/**
 * Enters pick mode for the object to put the lyrics behind: in the clip `hostId` (the playhead moves into it when
 * outside), or in whichever footage clip is clicked.
 */
export function pickObject(hostId?: string, fixing?: ObjectPick): void {
  if (isRunning(JOB_KINDS.cutout)) return
  const host = hostId ? editor.getProject().clips[hostId] : undefined
  if (hostId && !host) return
  const t = ui().playhead
  if (host && (t < host.start || t >= host.start + host.duration))
    setUi({ playhead: host.start + Math.min(0.1, host.duration / 2) })
  startPick({
    prompt: fixing ? FIX_PROMPT : PICK_PROMPT,
    hover: (p) => {
      const project = editor.getProject()
      const time = ui().playhead
      const hit = footageAt(project, p, time, hostId)
      return hit ? outlineOf(project, hit, time) : null
    },
    onPick: (p) => {
      const hit = footageAt(editor.getProject(), p, p.time, hostId)
      if (!hit) {
        toast(hostId ? 'Click inside the clip, where it shows in the preview' : 'Click on a video clip')
        pickObject(hostId, fixing)
        return
      }
      const click: SelectionClick = { t: hit.mediaTime, points: [hit.point] }
      const handle = fixing
        ? cutOutObject(hit.clip.id, fixing.click, [...fixing.corrections, click])
        : cutOutObject(hit.clip.id, click)
      handle?.promise.then(
        (result) =>
          undoToast(
            fixing ? 'The cutout follows the object there now' : 'Lyrics now sit behind the object',
            result,
          ),
        () => undefined,
      )
    },
  })
}

/** Moves the playhead to where the clip's object was lost and asks for a click on it there. */
export function fixObject(hostId: string, mediaTime: number): void {
  const project = editor.getProject()
  const host = project.clips[hostId]
  const pick = objectOf(cutoutsOf(project, hostId)[0])
  if (host?.type !== 'video' || !pick) return
  setUi({ playhead: timelineTimeOf(host, mediaTime + 0.05) })
  pickObject(hostId, pick)
}
