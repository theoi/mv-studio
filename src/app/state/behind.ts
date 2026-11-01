import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type {
  Asset,
  Clip,
  EditChange,
  EditCommand,
  Id,
  JsonObject,
  Project,
  Track,
} from '../../model/index.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { JobError, jobs, type JobHandle } from '../../shared/jobs.ts'
import { modelCache } from '../../shared/models.ts'
import type {
  PackedMaskTrack,
  SelectionClick,
  SuitabilityEvidence,
  SuitabilityReason,
  SuitabilityReport,
  SuitabilityVerdict,
  TimeRange,
} from '../../vision/index.ts'
import type * as Vision from '../../vision/index.ts'
import { suitabilityInRange } from '../../vision/mask/suitability.ts'
import { PERSON_TRACK_VERSION } from '../../vision/segmentation/personTrack.ts'
import { VISION_MODEL_PARTS, VISION_MODELS } from '../../vision/runtime/models.ts'
import { mediaById } from '../mock/media.ts'
import { maskStorageKey, sceneOf } from '../mock/demoProject.ts'
import { isSampleAsset } from '../mock/sampleMedia.ts'
import { showingDownloads, visionService } from './footage.ts'
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
  | {
      status: 'checked'
      verdict: SuitabilityVerdict
      reasons: SuitabilityReason[]
      /** Judged without the person detector, which could not be downloaded. */
      peopleSkipped?: boolean
      /** What a footage check judged, so each clip is judged on the part of the footage it shows. */
      evidence?: SuitabilityEvidence
      /**
       * From the quick check, not the cutout's person track, which judges again from its own masks: a shot that works
       * only in parts can still be turned down then.
       */
      quick?: boolean
    }
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
   * Clips cut out with a warning, with why: the person track found that their cutout flickers (only the track can
   * measure flicker, so the check could not warn before the cutout), or no one was looked for because the person
   * detector could not be downloaded.
   */
  warnings?: Array<{ assetId: Id; name: string; why: string }>
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
  /** The person masks made offline that the running re-make makes again (`remakeOfflineMasks`). */
  remaking: Id[]
}>(() => ({ checks: {}, results: {}, requests: {}, remaking: [] }))

function setCheck(assetId: Id, check: Suitability) {
  useBehind.setState((s) => ({ checks: { ...s.checks, [assetId]: check } }))
}

/**
 * Forgets the checks made without the person detector, so the panel or inspector that shows them checks again, now
 * with the detector. Runs when the browser comes back online.
 */
export function retryPeopleSkipped(): void {
  useBehind.setState((s) => {
    const stale = Object.keys(s.checks).filter((id) => {
      const check = s.checks[id]!
      return check.status === 'checked' && check.peopleSkipped
    })
    if (!stale.length) return s
    const checks = { ...s.checks }
    for (const id of stale) checks[id] = { status: 'unchecked' }
    return { checks }
  })
}

const fromReport = (r: SuitabilityReport): Extract<Suitability, { status: 'checked' }> => ({
  status: 'checked',
  verdict: r.verdict,
  reasons: r.reasons,
  ...(r.peopleSkipped ? { peopleSkipped: true } : {}),
  ...(r.evidence ? { evidence: r.evidence } : {}),
})

const QUICK_PARTS = 'The cutout takes a closer look and may still turn it down.'
const QUICK_PARTS_BRIEF = 'Works in parts of this shot, may change on a closer look'

const NOT_CHECKED_FOR_PEOPLE = 'Couldn’t check for people, so the cutout may include animals or objects.'
const PEOPLE_SKIPPED = `${NOT_CHECKED_FOR_PEOPLE} It checks again when you’re back online.`

const REASONS: Record<SuitabilityReason, string> = {
  // The person segmenter finds nobody both in empty shots and in wide shots of small people, so this must not claim
  // the shot is empty.
  'no-subject': 'No one in this shot is large enough to cut out',
  'no-person-found': 'Couldn’t find a person to cut out in this shot',
  'subject-too-small': 'People are too small in this wide shot',
  'subject-fills-frame': 'The person fills the frame, so text behind them would barely show',
  'many-small-subjects': 'Too many small people to cut out cleanly',
  'unstable-mask': 'The cutout flickers in this shot',
}

/** A marginal shot has a person in some parts, so a reason about the whole shot would contradict "Person found". */
const MARGINAL_REASONS: Partial<Record<SuitabilityReason, string>> = {
  'no-subject': 'In the other parts, no one is large enough to cut out',
  'no-person-found': 'Couldn’t find a person in the other parts',
}

/**
 * What the inspector and Assist say about a shot: a short status and, when it matters, why (`brief`: a shorter why
 * for a row in a list). `checkingPeople`: its cutout's mask is being made again with the person detector right now,
 * so the note does not promise a check later.
 */
export function suitabilityText(
  s: Suitability,
  checkingPeople = false,
): {
  status: string
  why?: string
  brief?: string
  ok: boolean
} {
  switch (s.status) {
    case 'checked': {
      const text = checkedText(s)
      // Without the detector an animal can pass for the person, so an offered shot says the check was partial.
      if (!s.peopleSkipped || !text.ok) return text
      const skipped = checkingPeople ? NOT_CHECKED_FOR_PEOPLE : PEOPLE_SKIPPED
      return {
        ...text,
        why: text.why ? `${text.why} ${skipped}` : skipped,
        brief: 'Not checked for people',
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

function checkedText(s: Extract<Suitability, { status: 'checked' }>): {
  status: string
  why?: string
  brief?: string
  ok: boolean
} {
  const first = s.reasons[0]
  const reason = first ? REASONS[first] : undefined
  if (s.verdict === 'good') return { status: 'Person found', ok: true }
  if (s.verdict === 'marginal') {
    // Flicker alone makes a shot marginal with a person in all of it, so "works in parts" would be wrong.
    if (first === 'unstable-mask')
      return {
        status: 'Person found',
        why: 'The cutout flickers in places, so the lyrics can blink around the person for a moment.',
        ok: true,
      }
    const partly = first ? (MARGINAL_REASONS[first] ?? reason) : undefined
    const why = partly ? `Works in parts of this shot. ${partly}.` : undefined
    // The person track sees other masks at other times, so a part just long enough by the check may be too short by it.
    if (s.quick)
      return {
        status: 'Person found',
        why: why ? `${why} ${QUICK_PARTS}` : QUICK_PARTS,
        brief: QUICK_PARTS_BRIEF,
        ok: true,
      }
    return { status: 'Person found', why, ok: true }
  }
  return {
    status: 'Not suitable',
    why: `${reason ?? 'This shot has no clear person to cut out'}.`,
    ok: false,
  }
}

/**
 * Why the cutout turned down a clip: each refusal follows an offer (the quick check found a person), so it says the
 * cutout's closer look disagrees instead of repeating a plain verdict that contradicts the offer.
 */
export function refusalText(s: Suitability): string {
  const first = s.status === 'checked' ? s.reasons[0] : undefined
  if (!first || first === 'no-subject') return 'On a closer look, no one is large enough to cut out.'
  if (first === 'no-person-found') return 'On a closer look, the cutout couldn’t find a person in this shot.'
  const reason = REASONS[first]
  return `On a closer look, ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`
}

export function footageOf(
  project: Project,
  clip: Clip | undefined,
): { clip: VideoClip; asset: Asset } | undefined {
  if (!clip || clip.type !== 'video' || clip.meta?.behindSubjectOf) return undefined
  const asset = project.assets[clip.assetId]
  return asset?.kind === 'video' ? { clip, asset } : undefined
}

/** Whether the person in a clip's footage can be cut out, as far as is known, in the part of it the clip shows. */
export function suitabilityOf(
  project: Project,
  clip: Clip | undefined,
  checks: Record<Id, Suitability> = useBehind.getState().checks,
): Suitability {
  const footage = footageOf(project, clip)
  if (!footage) return { status: 'unsupported' }
  const s = clipSuitability(assetSuitability(footage.asset, checks), footage.clip, footage.asset)
  // A check made with the person detector does not make a cutout made without it any less whole: its note stays
  // until the mask is made again.
  return s.status === 'checked' && !s.peopleSkipped && cutOutWithoutPeople(project, footage.clip.id)
    ? { ...s, peopleSkipped: true }
    : s
}

/** The part of its footage a clip shows, in media seconds. */
export function usedRange(clip: VideoClip, asset: Asset): TimeRange {
  const rate = clip.playbackRate > 0 ? clip.playbackRate : 1
  const end = clip.sourceStart + clip.duration * rate
  return { start: Math.max(0, clip.sourceStart), end: asset.duration ? Math.min(asset.duration, end) : end }
}

/** A footage check judged again on the part a clip shows, when the check kept what it judged. */
function clipSuitability(s: Suitability, clip: VideoClip, asset: Asset): Suitability {
  if (s.status !== 'checked' || !s.evidence) return s
  const { evidence: _, ...part } = fromReport(suitabilityInRange(s.evidence, usedRange(clip, asset)))
  return { ...part, ...(s.peopleSkipped ? { peopleSkipped: true } : {}), ...(s.quick ? { quick: true } : {}) }
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

type ClipMove = Extract<EditCommand, { type: 'clip.move' }>['moves'][number]

/**
 * `moves` with each moved clip's cutouts moving as far in time, so a cutout keeps showing the moment it was cut from
 * when its clip moves: a drag, a swap, a ripple delete, Close gap. `project` has the clips where they were before the
 * moves. A cutout that moves itself, or is on a locked track, stays as given.
 */
export function withCutouts(project: Project, moves: readonly ClipMove[]): ClipMove[] {
  const moved = new Set(moves.map((m) => m.clipId))
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const follow = moves.flatMap((m) => {
    const host = project.clips[m.clipId]
    if (!host) return []
    return cutoutsOf(project, host.id)
      .filter((c) => !moved.has(c.id) && !locked.has(c.trackId))
      .map((c) => ({ clipId: c.id, start: Math.max(0, c.start + m.start - host.start) }))
  })
  return [...moves, ...follow]
}

type ClipTrim = Extract<EditCommand, { type: 'clip.trim' }>

/**
 * `trims`, made after `moves` (as withCutouts gives them), with each trimmed clip's cutouts trimmed to match, so a
 * cutout still covers its clip when a swap or a gap fill trims it. A cutout edge that met its clip's edge follows it;
 * one inside the clip is cut back to the clip's new edge when it would stick out. `project` has the clips where they
 * were before the moves. A cutout trimmed itself, or on a locked track, stays as given.
 */
export function withCutoutTrims(
  project: Project,
  moves: readonly ClipMove[],
  trims: readonly ClipTrim[],
): ClipTrim[] {
  const EPS = 1e-3
  const movedTo = new Map(moves.map((m) => [m.clipId, Math.max(0, m.start)]))
  const startOf = (c: Clip) => movedTo.get(c.id) ?? c.start
  const trimmed = new Set(trims.map((t) => t.clipId))
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const follow = trims.flatMap((t) => {
    const host = project.clips[t.clipId]
    if (!host) return []
    const from = startOf(host)
    const to = from + host.duration
    const start = Math.max(0, t.start)
    const end = start + t.duration
    return cutoutsOf(project, host.id)
      .filter((c) => !trimmed.has(c.id) && !locked.has(c.trackId))
      .flatMap((c): ClipTrim[] => {
        const was = { start: startOf(c), end: startOf(c) + c.duration }
        const s = Math.abs(was.start - from) < EPS ? start : Math.max(was.start, start)
        const e = Math.abs(was.end - to) < EPS ? end : Math.min(was.end, end)
        const same = Math.abs(s - was.start) < EPS && Math.abs(e - was.end) < EPS
        return same || e - s < 0.01 ? [] : [{ type: 'clip.trim', clipId: c.id, start: s, duration: e - s }]
      })
  })
  return [...trims, ...follow]
}

/**
 * `clipIds` with the cutouts of those clips, which show only with their clip, so deleting a clip deletes its cutouts.
 * A cutout on a locked track stays.
 */
export function idsWithCutouts(project: Project, clipIds: Iterable<string>): string[] {
  const ids = new Set(clipIds)
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  for (const id of [...ids]) for (const c of cutoutsOf(project, id)) if (!locked.has(c.trackId)) ids.add(c.id)
  return [...ids]
}

/** A cutout whose clip is in the project: it moves only with that clip (withCutouts), never on its own. */
export function followsClip(project: Project, clip: Clip): boolean {
  const host = clip.meta?.behindSubjectOf
  return typeof host === 'string' && !!project.clips[host]
}

export function hasCutout(project: Project, clipId: string): boolean {
  return cutoutsOf(project, clipId).length > 0
}

/**
 * What a person mask video was made with, kept in the project for each mask (`project.extensions`, under
 * `MASK_RECORDS`, by mask id): the person track version, and whether no one was looked for because the person
 * detector could not be downloaded, which leaves the mask whole, animals and objects included. Masks made before the
 * record existed have none and count as made by an older version.
 */
export interface PersonMaskRecord {
  trackVersion: number
  peopleSkipped?: true
}

const MASK_RECORDS = 'vision.person-masks'

function maskRecords(project: Pick<Project, 'extensions'>): JsonObject {
  const records = project.extensions?.[MASK_RECORDS]
  return records && typeof records === 'object' && !Array.isArray(records) ? records : {}
}

export function personMaskRecord(
  project: Pick<Project, 'extensions'>,
  maskId: Id,
): PersonMaskRecord | undefined {
  const r = maskRecords(project)[maskId]
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.trackVersion !== 'number') return undefined
  return { trackVersion: r.trackVersion, ...(r.peopleSkipped === true ? { peopleSkipped: true } : {}) }
}

/** The records of `project` with those of some masks set (null removes one). */
function withRecords(
  project: Pick<Project, 'extensions'>,
  changes: ReadonlyMap<Id, PersonMaskRecord | null>,
): JsonObject {
  const records = { ...maskRecords(project) }
  for (const [id, r] of changes)
    if (r) records[id] = { trackVersion: r.trackVersion, ...(r.peopleSkipped ? { peopleSkipped: true } : {}) }
    else delete records[id]
  return records
}

/** The command that sets the records of some masks (null removes one), keeping the others in `project`. */
function recordsCommand(
  project: Pick<Project, 'extensions'>,
  changes: ReadonlyMap<Id, PersonMaskRecord | null>,
) {
  const records = withRecords(project, changes)
  const value = Object.keys(records).length ? records : null
  return { type: 'project.setExtension', key: MASK_RECORDS, value } satisfies EditCommand
}

/** The person mask videos made for an imported asset (all of them when `assetId` is undefined) that the project has. */
function personMasks(project: Pick<Project, 'assets'>, assetId?: Id): Asset[] {
  return Object.values(project.assets).filter(
    (a) =>
      a.kind === 'video' &&
      a.origin.type === 'derived' &&
      a.origin.provider === PERSON_MASK &&
      (assetId === undefined || a.origin.parentAssetId === assetId),
  )
}

/**
 * The person mask video a new cutout of an imported asset can use as it is: made by the current person track, with
 * the people looked for. A cutout applied to footage whose mask was made offline or by an older version gets a new
 * mask; the cutouts already using the old one keep it, except a mask made offline (`replacementOf`).
 */
export function findPersonMask(
  project: Pick<Project, 'assets' | 'extensions'>,
  assetId: Id,
): Asset | undefined {
  return personMasks(project, assetId).find((m) => {
    const record = personMaskRecord(project, m.id)
    return record?.trackVersion === PERSON_TRACK_VERSION && !record.peopleSkipped
  })
}

const matteMask = (clip: Clip): Id | undefined => ('matte' in clip ? clip.matte?.maskAssetId : undefined)

/** Background writes leave clips on locked tracks as they are, since the editor refuses to change them. */
const editable = (project: Project, clip: Clip) => !project.tracks.find((t) => t.id === clip.trackId)?.locked

/**
 * The mask a cutout on the person mask `id` uses instead, when `id` was made without the person detector: a mask of
 * the same footage made with it, once there is one (`findPersonMask`).
 */
function replacementOf(project: Pick<Project, 'assets' | 'extensions'>, id: Id): Asset | undefined {
  if (!personMaskRecord(project, id)?.peopleSkipped) return undefined
  const footage = project.assets[id]?.origin.parentAssetId
  return footage ? findPersonMask(project, footage) : undefined
}

/** Person masks made without the person detector that cutouts on the timeline use, with nothing to replace them. */
function offlineMasksInUse(project: Project): Asset[] {
  const used = new Set(Object.values(project.clips).map(matteMask))
  return personMasks(project).filter(
    (m) =>
      used.has(m.id) && !!personMaskRecord(project, m.id)?.peopleSkipped && !replacementOf(project, m.id),
  )
}

/** Whether a footage clip has a cutout whose person mask was made without the person detector. */
function cutOutWithoutPeople(project: Project, clipId: Id): boolean {
  return cutoutsOf(project, clipId).some((c) => {
    const mask = matteMask(c)
    return !!mask && !!personMaskRecord(project, mask)?.peopleSkipped
  })
}

/**
 * The note for a clip whose cutout uses a person mask made without the person detector, whatever the check says
 * meanwhile: the cutout may include animals or objects until its mask is made again. `checkingPeople`: as in
 * `suitabilityText`.
 */
export function cutoutNote(project: Project, clipId: Id, checkingPeople = false): string | undefined {
  if (!cutOutWithoutPeople(project, clipId)) return undefined
  return checkingPeople ? NOT_CHECKED_FOR_PEOPLE : PEOPLE_SKIPPED
}

/** Whether a footage clip has a cutout whose mask is one of `remaking` (`useBehind`), being made again now. */
export function cutoutRemaking(project: Project, clipId: Id, remaking: readonly Id[]): boolean {
  return cutoutsOf(project, clipId).some((c) => remaking.includes(matteMask(c) ?? ''))
}

const repointCommands = (project: Project, oldId: Id, newId: Id): EditCommand[] =>
  Object.values(project.clips)
    .filter((c) => matteMask(c) === oldId && editable(project, c))
    .map((c) => ({ type: 'clip.set', clipId: c.id, path: ['matte', 'maskAssetId'], value: newId }))

/**
 * Commands that put `mask` in place of the person mask `oldId` in every clip whose matte uses the old mask (in
 * `project`, the current state). `record` is the new mask's, when the project does not have the new mask yet. The
 * old mask stays, since an undo can bring back a cutout that used it: that cutout then gets the new mask too
 * (`settleCommands`), and the old mask goes when the project is next opened.
 */
export function replaceMaskCommands(
  project: Project,
  oldId: Id,
  mask: Asset,
  record?: PersonMaskRecord,
): EditCommand[] {
  const commands: EditCommand[] = []
  if (!project.assets[mask.id]) commands.push({ type: 'asset.add', asset: mask })
  commands.push(...repointCommands(project, oldId, mask.id))
  if (record) commands.push(recordsCommand(project, new Map([[mask.id, record]])))
  return commands
}

/**
 * Records of the person masks in this session's project, by mask id. The records are one extension value, so an undo
 * or redo puts all of them back as they were at that step, dropping those of masks made since in the background.
 * History lasts a session, so these give back the records of masks still in the project.
 */
const knownRecords = new Map<Id, PersonMaskRecord>()

/**
 * Background repairs after a change: records an undo or redo dropped come back for masks still in the project, and
 * a cutout on a mask made without the person detector (brought back by an undo, say) gets a mask of the same footage
 * made with it. `tidy`, when no undo or redo step can bring anything back (a project just opened): masks made
 * offline that are replaced and unused go, as do the records of masks no longer in the project.
 */
function settleCommands(
  project: Project,
  known: ReadonlyMap<Id, PersonMaskRecord>,
  tidy: boolean,
): EditCommand[] {
  const masks = personMasks(project)
  const changes = new Map<Id, PersonMaskRecord | null>()
  for (const m of masks) {
    const record = known.get(m.id)
    if (record && !personMaskRecord(project, m.id)) changes.set(m.id, record)
  }
  const view = { assets: project.assets, extensions: { [MASK_RECORDS]: withRecords(project, changes) } }
  const commands: EditCommand[] = []
  const used = new Set<Id>()
  for (const c of Object.values(project.clips)) {
    const id = matteMask(c)
    if (!id) continue
    const mask = editable(project, c) ? replacementOf(view, id) : undefined
    if (mask)
      commands.push({ type: 'clip.set', clipId: c.id, path: ['matte', 'maskAssetId'], value: mask.id })
    else used.add(id)
  }
  if (tidy) {
    for (const m of masks)
      if (!used.has(m.id) && replacementOf(view, m.id)) {
        commands.push({ type: 'asset.remove', assetId: m.id })
        changes.set(m.id, null)
      }
    for (const id of Object.keys(maskRecords(project))) if (!project.assets[id]) changes.set(id, null)
  }
  if (changes.size) commands.push(recordsCommand(project, changes))
  return commands
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
  /** Unique per row: a video whose clips show parts with different verdicts has a row for each verdict. */
  key: string
  asset: Asset
  suitability: Suitability
  /** Footage clips on the timeline showing this asset with this verdict. */
  clips: number
}

const rowRank = (s: Suitability) =>
  s.status === 'checked' ? (s.verdict === 'unsuitable' ? 2 : 0) : s.status === 'unsupported' ? 3 : 1

/**
 * One row per video on the timeline for Assist › Behind the subject (one per verdict when its clips show parts that
 * differ): shots with a person first, then shots still being checked, then the ones that are not suitable; in order
 * of first use within each group.
 */
export function footageRows(
  project: Project,
  checks: Record<Id, Suitability> = useBehind.getState().checks,
): FootageRow[] {
  const seen = new Map<string, FootageRow & { start: number }>()
  for (const c of Object.values(project.clips)) {
    const f = footageOf(project, c)
    if (!f) continue
    const suitability = suitabilityOf(project, c, checks)
    const verdict =
      suitability.status === 'checked'
        ? `${suitability.verdict}:${suitability.reasons.join(',')}`
        : suitability.status
    const key = `${f.asset.id}:${verdict}`
    const prev = seen.get(key)
    if (prev) {
      prev.clips++
      prev.start = Math.min(prev.start, c.start)
    } else seen.set(key, { key, asset: f.asset, suitability, start: c.start, clips: 1 })
  }
  return [...seen.values()]
    .sort((a, b) => a.start - b.start)
    .map(({ start: _, ...row }) => row)
    .sort((a, b) => rowRank(a.suitability) - rowRank(b.suitability))
}

/** Uncompressed size of the MediaPipe vision runtime (JS and WebAssembly), loaded once with the first model. */
const MEDIAPIPE_RUNTIME_BYTES = 14_800_000

/** Bytes finding and cutting out people still has to download (models and runtime, once), 0 when cached. */
export async function personDownloadBytes(): Promise<number> {
  const needed = VISION_MODEL_PARTS.cutout
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
 * scene masks, `newMasks` (by footage asset id, stored but maybe not in the project yet, with their `records` by mask
 * id), or the person masks in the project that are current (`findPersonMask`).
 */
export function cutoutCommands(
  project: Project,
  clipIds: readonly string[],
  newMasks: ReadonlyMap<Id, Asset> = new Map(),
  records: ReadonlyMap<Id, PersonMaskRecord> = new Map(),
): { commands: EditCommand[]; count: number } {
  const commands: EditCommand[] = []
  const { track, commands: trackCommands } = subjectTrack(project)
  const added = new Set<Id>()
  const recorded = new Map<Id, PersonMaskRecord>()
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
      const mask = newMasks.get(asset.id) ?? findPersonMask(project, asset.id)
      if (!mask) continue
      maskId = mask.id
      if (!project.assets[mask.id] && !added.has(mask.id)) {
        added.add(mask.id)
        commands.push({ type: 'asset.add', asset: mask })
        const record = records.get(mask.id)
        if (record) recorded.set(mask.id, record)
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
  if (recorded.size) commands.push(recordsCommand(project, recorded))
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
    run: showingDownloads(['cutout'], async (ctx) => {
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
          setCheck(id, { ...fromReport(report), quick: true })
        } catch (err) {
          if (ctx.signal.aborted) throw err
          setCheck(id, { status: 'failed', message: JobError.from(err).message })
        } finally {
          source.dispose()
        }
      }
    }),
  })
  handle.promise.catch(() => {
    for (const id of pending)
      if (useBehind.getState().checks[id]?.status === 'checking') setCheck(id, { status: 'unchecked' })
  })
  return handle
}

/**
 * Cuts the subject out of each clip as one job and one undo step. Imported footage gets a person mask first
 * (cached per clip media); a clip whose part of the footage has no one to cut out is left as it is.
 */
export function putBehind(clipIds: readonly string[]): JobHandle<CutoutResult> | undefined {
  if (isRunning(JOB_KINDS.cutout)) return undefined
  // Two person tracks of the same footage at once could each make a mask. The re-make runs again after the cutout.
  const stopped = remake
  stopped?.cancel()
  /** Set when the cutout found the person detector missing, so a re-make now would only find that again. */
  let detectorMissing = false
  let jobId = ''
  const handle = jobs.run({
    kind: JOB_KINDS.cutout,
    title: 'Cutting out the subject',
    run: showingDownloads(['cutout', 'matte'], async (ctx) => {
      const start = editor.getProject()
      const unsuitable = (s: Suitability) => s.status === 'checked' && s.verdict === 'unsuitable'
      const wanted = [...new Set(clipIds)].filter(
        (id) =>
          footageOf(start, start.clips[id]) &&
          !hasCutout(start, id) &&
          !unsuitable(suitabilityOf(start, start.clips[id])),
      )
      const needMask = new Map<Id, Asset>()
      for (const id of wanted) {
        const { asset } = footageOf(start, start.clips[id])!
        if (isSampleAsset(asset) || findPersonMask(start, asset.id)) continue
        needMask.set(asset.id, asset)
      }
      const newMasks = new Map<Id, Asset>()
      const records = new Map<Id, PersonMaskRecord>()
      const refused: NonNullable<CutoutResult['refused']> = []
      const warnings: NonNullable<CutoutResult['warnings']> = []
      /** Clips the person track turned down for the part of the footage they show. */
      const turnedDown = new Set<string>()
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
            if (person.suitability.peopleSkipped) detectorMissing = true
            const check = fromReport(person.suitability)
            setCheck(asset.id, check)
            const name = asset.name.replace(/\.[^.]+$/, '')
            let kept = 0
            for (const id of wanted) {
              const footage = footageOf(start, start.clips[id])!
              if (footage.asset.id !== asset.id) continue
              const s = clipSuitability(check, footage.clip, asset)
              const { status, why } = suitabilityText(s)
              const note = { assetId: asset.id, name, why: why ?? status }
              if (unsuitable(s)) {
                turnedDown.add(id)
                if (!refused.some((r) => r.assetId === asset.id))
                  refused.push({ ...note, why: refusalText(s) })
                continue
              }
              kept++
              const warns = s.status === 'checked' && (s.reasons[0] === 'unstable-mask' || s.peopleSkipped)
              if (warns && why && !warnings.some((w) => w.assetId === asset.id)) warnings.push(note)
            }
            if (!kept) continue
            const peopleSkipped = !!person.suitability.peopleSkipped
            // Still without the detector, a mask made offline by this version is as good as a new one.
            const offline = peopleSkipped
              ? personMasks(start, asset.id).find(
                  (m) => personMaskRecord(start, m.id)?.trackVersion === PERSON_TRACK_VERSION,
                )
              : undefined
            if (offline) {
              newMasks.set(asset.id, offline)
              continue
            }
            const mask = await storePersonMask(v, asset, person.track, source, ctx.signal)
            step(0.95)
            newMasks.set(asset.id, mask)
            records.set(mask.id, {
              trackVersion: PERSON_TRACK_VERSION,
              ...(peopleSkipped ? { peopleSkipped: true } : {}),
            })
          } finally {
            source.dispose()
          }
        }
      }
      ctx.throwIfCancelled()
      const { commands, count } = cutoutCommands(
        editor.getProject(),
        wanted.filter((id) => !turnedDown.has(id)),
        newMasks,
        records,
      )
      const result: CutoutResult = {
        count,
        skipped: clipIds.length - count,
        ...(refused.length ? { refused } : {}),
        ...(warnings.length ? { warnings } : {}),
        label: CUTOUT_LABEL,
      }
      if (count && !dispatch(commands, { label: CUTOUT_LABEL }))
        throw new JobError(
          'invalid-input',
          'The cutout couldn’t be added. Unlock the Subject track and try again.',
        )
      useBehind.setState((s) => ({ results: { ...s.results, [jobId]: result } }))
      return result
    }),
  })
  jobId = handle.id
  useBehind.setState((s) => ({ requests: { ...s.requests, [jobId]: { clips: clipIds, object: false } } }))
  // The person detector may be available by now, for the masks made without it.
  void Promise.allSettled([handle.promise, stopped?.promise]).then(() => {
    if (!detectorMissing) remakeOfflineMasks()
  })
  return handle
}

/** Encodes a person track as the mask video of an imported asset and stores it. */
async function storePersonMask(
  v: typeof Vision,
  asset: Asset,
  track: PackedMaskTrack,
  source: { duration: number },
  signal: AbortSignal,
): Promise<Asset> {
  const blob = await v.encodeMaskVideo(track, { duration: asset.duration ?? source.duration, signal })
  return mediaStore.storeBlob(blob, {
    ...v.maskAssetInfo(asset, blob),
    origin: { type: 'derived', parentAssetId: asset.id, provider: PERSON_MASK },
  })
}

/** The running re-make of the masks made offline, which a cutout stops. */
let remake: JobHandle<void> | undefined

/**
 * Makes the person masks that were made without the person detector and that cutouts use again, now with it, and
 * points their cutouts at the new masks, so a cutout made offline ends up as one made online. A mask is left as it is
 * while the detector still cannot be downloaded. Runs when the browser comes back online, when a project opens, after
 * a cutout, and after an undo or redo brings back a cutout on such a mask. Not an undo step, like other results of
 * background work: the cutout itself was the user's edit.
 */
export function remakeOfflineMasks(): JobHandle<void> | undefined {
  // Runs even with background analysis off (`backgroundAnalysisOn`): that setting is about analysis nobody asked for,
  // and this finishes a cutout the user asked for.
  if (typeof navigator === 'undefined' || !navigator.onLine) return undefined
  if (isRunning(JOB_KINDS.cutout) || isRunning(JOB_KINDS.cutoutRemake)) return undefined
  const project = editor.getProject()
  const offline = offlineMasksInUse(project)
  if (!offline.length) return undefined
  const ids = offline.map((m) => m.id)
  const n = Object.values(project.clips).filter((c) => ids.includes(matteMask(c) ?? '')).length
  const handle = jobs.run({
    kind: JOB_KINDS.cutoutRemake,
    title: n === 1 ? 'Checking the cutout for people' : `Checking ${n} cutouts for people`,
    run: showingDownloads(['cutout'], async (ctx) => {
      const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
      for (const [i, old] of offline.entries()) {
        const now = editor.getProject()
        const asset = now.assets[old.origin.parentAssetId ?? '']
        if (!now.assets[old.id] || asset?.kind !== 'video') continue
        let mask = findPersonMask(now, asset.id)
        let record: PersonMaskRecord | undefined
        if (!mask) {
          const message = `Checking for people · ${asset.name}`
          const step = (f: number) => ctx.progress({ fraction: (i + f) / offline.length, message })
          step(0)
          const source = v.createAssetFrameSource(asset, appMedia)
          try {
            const person = await vision.personTrack(source, {
              signal: ctx.signal,
              onProgress: (p) => step(0.9 * (p.fraction ?? 0)),
            })
            if (person.suitability.peopleSkipped) continue
            setCheck(asset.id, fromReport(person.suitability))
            mask = await storePersonMask(v, asset, person.track, source, ctx.signal)
            record = { trackVersion: PERSON_TRACK_VERSION }
          } finally {
            source.dispose()
          }
        }
        ctx.throwIfCancelled()
        // Also when the cutout went meanwhile: an undo or redo can bring it back on the old mask.
        dispatch(replaceMaskCommands(editor.getProject(), old.id, mask, record), { history: 'skip' })
      }
    }),
  })
  remake = handle
  useBehind.setState({ remaking: ids })
  const end = () => {
    if (remake !== handle) return
    remake = undefined
    useBehind.setState({ remaking: [] })
  }
  handle.promise.then(end, end)
  return handle
}

if (typeof window !== 'undefined')
  window.addEventListener('online', () => {
    retryPeopleSkipped()
    remakeOfflineMasks()
  })

/** Masks made offline that cutouts used after the last change, to tell when an undo or redo brings one back. */
let offlineInUse = new Set<Id>()
let changes: Set<EditChange['source']> | undefined

editor.subscribe((project, change) => {
  if (change.source === 'load') knownRecords.clear()
  for (const id of Object.keys(maskRecords(project))) {
    const record = personMaskRecord(project, id)
    if (record) knownRecords.set(id, record)
  }
  if (!changes) {
    changes = new Set()
    // Once the change has reached every listener, so none of them gets the repair before the change.
    queueMicrotask(afterChanges)
  }
  changes.add(change.source)
})

function afterChanges() {
  const sources = changes ?? new Set()
  changes = undefined
  let project = editor.getProject()
  if (!personMasks(project).length && !project.extensions?.[MASK_RECORDS]) {
    offlineInUse = new Set()
    return
  }
  const history = editor.history()
  const commands = settleCommands(project, knownRecords, !history.undo.length && !history.redo.length)
  if (commands.length && dispatch(commands, { history: 'skip' })) project = editor.getProject()
  const inUse = new Set(offlineMasksInUse(project).map((m) => m.id))
  const back = [...inUse].some((id) => !offlineInUse.has(id))
  offlineInUse = inUse
  if (sources.has('load') || (back && (sources.has('undo') || sources.has('redo')))) remakeOfflineMasks()
}

export function bringToFront(clipIds: string[]): boolean {
  const project = editor.getProject()
  const ids = clipIds.flatMap((id) => cutoutsOf(project, id).map((c) => c.id))
  if (!ids.length) return false
  return dispatch({ type: 'clip.remove', clipIds: ids }, { label: 'Bring lyrics to the front' })
}
