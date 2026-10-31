import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Asset, Clip, EditCommand, Id, JsonObject, Project, Track } from '../../model/index.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { JobError, jobs, type JobHandle } from '../../shared/jobs.ts'
import { modelCache } from '../../shared/models.ts'
import type {
  SelectionClick,
  SuitabilityReason,
  SuitabilityReport,
  SuitabilityVerdict,
} from '../../vision/index.ts'
import { VISION_MODELS } from '../../vision/runtime/models.ts'
import { mediaById } from '../mock/media.ts'
import { maskStorageKey, sceneOf } from '../mock/demoProject.ts'
import { isSampleAsset } from '../mock/sampleMedia.ts'
import { visionService } from './footage.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { appMedia } from './media.ts'
import { dispatch, editor } from './project.ts'

/*
 * "Behind the subject": the footage clip is duplicated onto a Subject track above the lyrics and restricted to the
 * person with a matte, so text plays between the person and the background on exactly that clip. Sample footage has
 * its masks drawn with its scenes. Imported footage is checked for a person (src/vision checkSuitability) and cut
 * out with a person mask track encoded as a mask video, as a job. Any other object can be picked in the preview
 * instead (./behindObject.ts).
 */

const SUBJECT_TRACK_NAME = 'Subject'
export const CUTOUT_LABEL = 'Put lyrics behind the subject'
/** Marks person mask videos among an asset's derived media. */
const PERSON_MASK = 'vision.person-mask'

export type VideoClip = Extract<Clip, { type: 'video' }>

export type Suitability =
  | { status: 'checked'; verdict: SuitabilityVerdict; reasons: SuitabilityReason[] }
  | { status: 'unchecked' }
  | { status: 'checking' }
  | { status: 'failed'; message: string }
  | { status: 'unsupported' }

/**
 * The object a cutout follows instead of the person, kept on the cutout clip (`meta.object`): the click that chose
 * it, later clicks that corrected it, and how well it was followed. Times are media times of the footage.
 */
export interface ObjectPick {
  click: SelectionClick
  corrections: SelectionClick[]
  /** Fraction of the clip where the object was found. */
  tracked: number
  /** Where it was lost while expected in view: a click there helps. */
  fix: number[]
}

export function objectOf(clip: Clip | undefined): ObjectPick | undefined {
  const o = clip?.meta?.object
  return o && typeof o === 'object' && !Array.isArray(o) && 'click' in o
    ? (o as unknown as ObjectPick)
    : undefined
}

export const objectMeta = (hostId: string, pick: ObjectPick): JsonObject => ({
  behindSubjectOf: hostId,
  object: structuredClone(pick) as unknown as JsonObject,
})

export interface CutoutResult {
  /** Clips that got a cutout. */
  count: number
  /** Requested clips left as they were: no person to cut out, or already behind. */
  skipped: number
  /**
   * Clips the check offered but the person track then judged unsuitable, with why (the "Not suitable" text), so the
   * offer is not followed by a silent skip.
   */
  refused?: Array<{ assetId: Id; name: string; why: string }>
  /**
   * Clips cut out although the person track found that their cutout flickers, with why. Only the track can measure
   * flicker, so the check could not warn before the cutout.
   */
  flickers?: Array<{ assetId: Id; name: string; why: string }>
  label: string
  /** Set when the cutout follows a picked object. */
  object?: ObjectPick
}

export interface CutoutRequest {
  clips: readonly string[]
  object: boolean
}

export const useBehind = create<{
  checks: Record<Id, Suitability>
  results: Record<string, CutoutResult>
  /** What each cutout job was asked for, so progress and failures show next to those clips. */
  requests: Record<string, CutoutRequest>
}>(() => ({ checks: {}, results: {}, requests: {} }))

function setCheck(assetId: Id, check: Suitability) {
  useBehind.setState((s) => ({ checks: { ...s.checks, [assetId]: check } }))
}

const fromReport = (r: SuitabilityReport): Suitability => ({
  status: 'checked',
  verdict: r.verdict,
  reasons: r.reasons,
})

const REASONS: Record<SuitabilityReason, string> = {
  // The person segmenter finds nobody both in empty shots and in wide shots of small people, so this must not claim
  // the shot is empty.
  'no-subject': 'No one in this shot is large enough to cut out',
  'subject-too-small': 'People are too small in this wide shot',
  'subject-fills-frame': 'The person fills the frame, so text behind them would barely show',
  'many-small-subjects': 'Too many small people to cut out cleanly',
  'unstable-mask': 'The cutout flickers in this shot',
}

/** A marginal shot has a person in some parts, so a reason about the whole shot would contradict "Person found". */
const MARGINAL_REASONS: Partial<Record<SuitabilityReason, string>> = {
  'no-subject': 'In the other parts, no one is large enough to cut out',
}

/** What the inspector and Assist say about a shot: a short status and, when it matters, why. */
export function suitabilityText(s: Suitability): { status: string; why?: string; ok: boolean } {
  switch (s.status) {
    case 'checked': {
      const first = s.reasons[0]
      const reason = first ? REASONS[first] : undefined
      if (s.verdict === 'good') return { status: 'Person found', ok: true }
      if (s.verdict === 'marginal') {
        // Flicker alone makes a shot marginal with a person in all of it, so "works in parts" would be wrong.
        if (first === 'unstable-mask')
          return {
            status: 'Person found',
            why: 'The cutout flickers in places, so what is behind the person can show through for a moment.',
            ok: true,
          }
        const partly = first ? (MARGINAL_REASONS[first] ?? reason) : undefined
        return {
          status: 'Person found',
          why: partly ? `Works in parts of this shot. ${partly}.` : undefined,
          ok: true,
        }
      }
      return {
        status: 'Not suitable',
        why: `${reason ?? 'This shot has no clear person to cut out'}.`,
        ok: false,
      }
    }
    case 'checking':
      return { status: 'Looking for people…', ok: false }
    case 'failed':
      return { status: 'Not checked', why: s.message, ok: false }
    case 'unchecked':
      return { status: 'Not checked yet', ok: true }
    default:
      return { status: 'Video clips only', ok: false }
  }
}

export function footageOf(
  project: Project,
  clip: Clip | undefined,
): { clip: VideoClip; asset: Asset } | undefined {
  if (!clip || clip.type !== 'video' || clip.meta?.behindSubjectOf) return undefined
  const asset = project.assets[clip.assetId]
  return asset?.kind === 'video' ? { clip, asset } : undefined
}

/** Whether the person in a clip's footage can be cut out, as far as is known. */
export function suitabilityOf(
  project: Project,
  clip: Clip | undefined,
  checks: Record<Id, Suitability> = useBehind.getState().checks,
): Suitability {
  const footage = footageOf(project, clip)
  return footage ? assetSuitability(footage.asset, checks) : { status: 'unsupported' }
}

/** Whether the person in a video asset can be cut out, as far as is known. */
export function assetSuitability(
  asset: Asset,
  checks: Record<Id, Suitability> = useBehind.getState().checks,
): Suitability {
  if (asset.kind !== 'video') return { status: 'unsupported' }
  if (isSampleAsset(asset)) {
    const subject = mediaById[asset.id]?.subject
    if (subject === 'large' && sceneOf(asset)) return { status: 'checked', verdict: 'good', reasons: [] }
    return {
      status: 'checked',
      verdict: 'unsuitable',
      reasons: [subject === 'small' ? 'subject-too-small' : 'no-subject'],
    }
  }
  return checks[asset.id] ?? { status: 'unchecked' }
}

/** True when the clip has a person to cut out, or might have one (not checked yet). */
export function canTryCutout(s: Suitability): boolean {
  return (
    s.status === 'unchecked' ||
    s.status === 'failed' ||
    (s.status === 'checked' && s.verdict !== 'unsuitable')
  )
}

export function cutoutsOf(project: Project, clipId: string): Clip[] {
  return Object.values(project.clips).filter((c) => c.meta?.behindSubjectOf === clipId)
}

export function hasCutout(project: Project, clipId: string): boolean {
  return cutoutsOf(project, clipId).length > 0
}

/** The person mask video already made for an imported asset, if the project still has it. */
export function findPersonMask(project: Pick<Project, 'assets'>, assetId: Id): Asset | undefined {
  return Object.values(project.assets).find(
    (a) =>
      a.kind === 'video' &&
      a.origin.type === 'derived' &&
      a.origin.parentAssetId === assetId &&
      a.origin.provider === PERSON_MASK,
  )
}

/** Footage clips on the timeline whose shot is known to have a person to cut out. */
export function suitableClips(project: Project, checks?: Record<Id, Suitability>): string[] {
  return Object.values(project.clips)
    .filter((c) => {
      const s = suitabilityOf(project, c, checks)
      return s.status === 'checked' && s.verdict !== 'unsuitable'
    })
    .map((c) => c.id)
}

export interface FootageRow {
  asset: Asset
  suitability: Suitability
  /** Footage clips on the timeline showing this asset. */
  clips: number
}

const rowRank = (s: Suitability) =>
  s.status === 'checked' ? (s.verdict === 'unsuitable' ? 2 : 0) : s.status === 'unsupported' ? 3 : 1

/**
 * One row per video on the timeline for Assist › Behind the subject: shots with a person first, then shots still
 * being checked, then the ones that are not suitable; in order of first use within each group.
 */
export function footageRows(
  project: Project,
  checks: Record<Id, Suitability> = useBehind.getState().checks,
): FootageRow[] {
  const seen = new Map<Id, { asset: Asset; start: number; clips: number }>()
  for (const c of Object.values(project.clips)) {
    const f = footageOf(project, c)
    if (!f) continue
    const prev = seen.get(f.asset.id)
    if (prev) {
      prev.clips++
      prev.start = Math.min(prev.start, c.start)
    } else seen.set(f.asset.id, { asset: f.asset, start: c.start, clips: 1 })
  }
  return [...seen.values()]
    .sort((a, b) => a.start - b.start)
    .map(({ asset, clips }) => ({ asset, clips, suitability: assetSuitability(asset, checks) }))
    .sort((a, b) => rowRank(a.suitability) - rowRank(b.suitability))
}

/** Uncompressed size of the MediaPipe vision runtime (JS and WebAssembly), loaded once with the first model. */
const MEDIAPIPE_RUNTIME_BYTES = 14_800_000

/** Bytes finding and cutting out people still has to download (models and runtime, once), 0 when cached. */
export async function personDownloadBytes(): Promise<number> {
  const needed = [
    VISION_MODELS.selfieLandscape,
    VISION_MODELS.selfie,
    VISION_MODELS.faceShortRange,
    VISION_MODELS.personDetector,
  ]
  const mediapipe = [...needed, VISION_MODELS.magicTouch, VISION_MODELS.selfieMulticlass]
  const fileOf = (m: (typeof mediapipe)[number]) => Object.values(m.files)[0]
  const cached = await Promise.all(
    mediapipe.map((m) => modelCache.has(fileOf(m)?.url ?? '').catch(() => false)),
  )
  const models = needed.reduce((sum, m, i) => sum + (cached[i] ? 0 : (fileOf(m)?.bytes ?? 0)), 0)
  return models + (cached.some(Boolean) ? 0 : MEDIAPIPE_RUNTIME_BYTES)
}

/** Bytes finding people still has to download, once; 0 when cached or not `needed`. */
export function usePersonDownload(needed: boolean): number {
  const [bytes, setBytes] = useState(0)
  useEffect(() => {
    if (!needed) return
    let live = true
    void personDownloadBytes().then((b) => {
      if (live) setBytes(b)
    })
    return () => {
      live = false
    }
  }, [needed])
  return needed ? bytes : 0
}

/** The Subject track above everything, and the command that adds it when the project has none. */
export function subjectTrack(project: Project): { track: Track; commands: EditCommand[] } {
  const found = project.tracks.find((t) => t.kind === 'visual' && t.name === SUBJECT_TRACK_NAME && !t.locked)
  if (found) return { track: found, commands: [] }
  const track: Track = {
    id: crypto.randomUUID(),
    kind: 'visual',
    name: SUBJECT_TRACK_NAME,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
  }
  return { track, commands: [{ type: 'track.add', track, index: 0 }] }
}

/**
 * Commands that cut the subject out of each clip onto the Subject track (added when missing), using the sample
 * scene masks, the person masks in the project, or `newMasks` (stored but not in the project yet).
 */
export function cutoutCommands(
  project: Project,
  clipIds: readonly string[],
  newMasks: ReadonlyMap<Id, Asset> = new Map(),
): { commands: EditCommand[]; count: number } {
  const commands: EditCommand[] = []
  const { track, commands: trackCommands } = subjectTrack(project)
  const added = new Set<Id>()
  let count = 0
  for (const id of new Set(clipIds)) {
    const footage = footageOf(project, project.clips[id])
    if (!footage || hasCutout(project, id)) continue
    const { clip, asset } = footage
    let maskId: Id | undefined
    if (isSampleAsset(asset)) {
      const scene = sceneOf(asset)
      if (!scene || mediaById[asset.id]?.subject !== 'large') continue
      maskId = `mask-${asset.id}`
      if (!project.assets[maskId] && !added.has(maskId)) {
        added.add(maskId)
        commands.push({
          type: 'asset.add',
          asset: {
            id: maskId,
            kind: 'image',
            name: `${asset.name} (subject mask)`,
            mimeType: 'image/png',
            byteSize: 0,
            storageKey: maskStorageKey(scene),
            width: asset.width,
            height: asset.height,
            origin: { type: 'derived', parentAssetId: asset.id },
            createdAt: new Date().toISOString(),
          },
        })
      }
    } else {
      const mask = findPersonMask(project, asset.id) ?? newMasks.get(asset.id)
      if (!mask) continue
      maskId = mask.id
      if (!project.assets[mask.id] && !added.has(mask.id)) {
        added.add(mask.id)
        commands.push({ type: 'asset.add', asset: mask })
      }
    }
    commands.push({
      type: 'clip.add',
      clip: {
        ...structuredClone(clip),
        id: crypto.randomUUID(),
        trackId: track.id,
        name: `${clip.name ?? asset.name} · subject`,
        matte: { maskAssetId: maskId, sourceAssetId: asset.id, mode: 'inside', feather: 0.15 },
        meta: { behindSubjectOf: id },
      },
    })
    count++
  }
  return { commands: count ? [...trackCommands, ...commands] : [], count }
}

/**
 * Looks for a person in each imported clip's footage, in the background of the panel or inspector that asked. A
 * clip checked before is not checked again.
 */
export function checkFootage(assetIds: readonly Id[]): JobHandle<void> | undefined {
  const { checks } = useBehind.getState()
  const project = editor.getProject()
  const pending = [...new Set(assetIds)].filter((id) => {
    const asset = project.assets[id]
    const check = checks[id]
    return asset?.kind === 'video' && !isSampleAsset(asset) && (!check || check.status === 'unchecked')
  })
  if (!pending.length || isRunning(JOB_KINDS.suitability)) return undefined
  for (const id of pending) setCheck(id, { status: 'checking' })
  const n = pending.length
  const handle = jobs.run({
    kind: JOB_KINDS.suitability,
    title: n === 1 ? 'Looking for a person in the clip' : `Looking for people in ${n} clips`,
    run: async (ctx) => {
      const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
      for (const [i, id] of pending.entries()) {
        const asset = editor.getProject().assets[id]
        if (!asset) continue
        const message = `Looking for people · ${asset.name}`
        ctx.progress({ fraction: i / n, message })
        const source = v.createAssetFrameSource(asset, appMedia)
        try {
          const report = await vision.checkSuitability(source, {
            signal: ctx.signal,
            onProgress: (p) => ctx.progress({ fraction: (i + (p.fraction ?? 0)) / n, message }),
          })
          setCheck(id, fromReport(report))
        } catch (err) {
          if (ctx.signal.aborted) throw err
          setCheck(id, { status: 'failed', message: JobError.from(err).message })
        } finally {
          source.dispose()
        }
      }
    },
  })
  handle.promise.catch(() => {
    for (const id of pending)
      if (useBehind.getState().checks[id]?.status === 'checking') setCheck(id, { status: 'unchecked' })
  })
  return handle
}

/**
 * Cuts the subject out of each clip as one job and one undo step. Imported footage gets a person mask first
 * (cached per clip media); footage where the check finds no one to cut out is left as it is.
 */
export function putBehind(clipIds: readonly string[]): JobHandle<CutoutResult> | undefined {
  if (isRunning(JOB_KINDS.cutout)) return undefined
  let jobId = ''
  const handle = jobs.run({
    kind: JOB_KINDS.cutout,
    title: 'Cutting out the subject',
    run: async (ctx) => {
      const start = editor.getProject()
      const wanted = [...new Set(clipIds)].filter(
        (id) => footageOf(start, start.clips[id]) && !hasCutout(start, id),
      )
      const needMask = new Map<Id, Asset>()
      for (const id of wanted) {
        const { asset } = footageOf(start, start.clips[id])!
        if (isSampleAsset(asset) || findPersonMask(start, asset.id)) continue
        const check = useBehind.getState().checks[asset.id]
        if (check?.status === 'checked' && check.verdict === 'unsuitable') continue
        needMask.set(asset.id, asset)
      }
      const newMasks = new Map<Id, Asset>()
      const refused: NonNullable<CutoutResult['refused']> = []
      const flickers: NonNullable<CutoutResult['flickers']> = []
      if (needMask.size) {
        const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
        const assets = [...needMask.values()]
        for (const [i, asset] of assets.entries()) {
          const message = `Cutting out the person · ${asset.name}`
          const step = (f: number) => ctx.progress({ fraction: (i + f) / assets.length, message })
          step(0)
          const source = v.createAssetFrameSource(asset, appMedia)
          try {
            const person = await vision.personTrack(source, {
              signal: ctx.signal,
              onProgress: (p) => step(0.9 * (p.fraction ?? 0)),
            })
            const check = fromReport(person.suitability)
            setCheck(asset.id, check)
            const { status, why } = suitabilityText(check)
            const name = asset.name.replace(/\.[^.]+$/, '')
            if (person.suitability.verdict === 'unsuitable') {
              refused.push({ assetId: asset.id, name, why: why ?? status })
              continue
            }
            if (person.suitability.reasons[0] === 'unstable-mask' && why)
              flickers.push({ assetId: asset.id, name, why })
            const blob = await v.encodeMaskVideo(person.track, {
              duration: asset.duration ?? source.duration,
              signal: ctx.signal,
            })
            step(0.95)
            const info = v.maskAssetInfo(asset, blob)
            const mask = await mediaStore.storeBlob(blob, {
              ...info,
              origin: { type: 'derived', parentAssetId: asset.id, provider: PERSON_MASK },
            })
            newMasks.set(asset.id, mask)
          } finally {
            source.dispose()
          }
        }
      }
      ctx.throwIfCancelled()
      const { commands, count } = cutoutCommands(editor.getProject(), wanted, newMasks)
      const result: CutoutResult = {
        count,
        skipped: clipIds.length - count,
        ...(refused.length ? { refused } : {}),
        ...(flickers.length ? { flickers } : {}),
        label: CUTOUT_LABEL,
      }
      if (count && !dispatch(commands, { label: CUTOUT_LABEL }))
        throw new JobError(
          'invalid-input',
          'The cutout could not be added. Unlock the Subject track and try again.',
        )
      useBehind.setState((s) => ({ results: { ...s.results, [jobId]: result } }))
      return result
    },
  })
  jobId = handle.id
  useBehind.setState((s) => ({ requests: { ...s.requests, [jobId]: { clips: clipIds, object: false } } }))
  return handle
}

export function bringToFront(clipIds: string[]): boolean {
  const project = editor.getProject()
  const ids = clipIds.flatMap((id) => cutoutsOf(project, id).map((c) => c.id))
  if (!ids.length) return false
  return dispatch({ type: 'clip.remove', clipIds: ids }, { label: 'Bring lyrics to the front' })
}
