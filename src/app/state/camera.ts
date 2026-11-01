import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Clip, EditCommand, Id, ImageClip, Project } from '../../model/index.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { jobs, type JobHandle } from '../../shared/jobs.ts'
import type { CameraMoveResult, CameraMovesResult, CameraPreset, SafeAmounts } from '../../vision/index.ts'
import { CAMERA_EFFECT_ID, DEFAULT_CAMERA_PRESET } from '../../vision/render/cameraEffect.ts'
import { showingDownloads, visionService } from './footage.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { appMedia } from './media.ts'
import { visionDownloadBytes } from './models.ts'
import { dispatch, editor } from './project.ts'
import type { Selection } from './ui.ts'

/*
 * 3D camera moves on stills (Assist › 3D camera and the image inspector's suggestion) on src/vision's
 * addCameraMoves: depth is estimated on this device and every move lands in one undo step.
 */

export type CameraMotion = 'push' | 'orbit' | 'drift'

/** The camera preset behind each motion the panel offers. */
export const MOTION_PRESETS: Record<CameraMotion, CameraPreset> = {
  push: 'dolly-in',
  orbit: 'orbit-right',
  drift: 'pan-right',
}

export const MOTION_LABELS: Record<CameraMotion, string> = { push: 'Push in', orbit: 'Orbit', drift: 'Drift' }

/** The move's intensity when nothing set it (the effect's own default), and the panels' starting strength. */
const DEFAULT_CAMERA_INTENSITY = 0.5

export const useCamera = create<{
  motion: CameraMotion
  /** 0..100, the move's intensity in percent. */
  strength: number
  /** The user moved Strength. Until then each still gets vision's automatic amount: 0.5, or less where it smears or bends. */
  strengthSet: boolean
  results: Record<string, CameraMovesResult>
  /** The clips each job was asked for, so the inspector shows progress and failures next to them. */
  requests: Record<string, readonly Id[]>
  /** The preset each job adds, so the inspector shows the chosen motion while depth is estimated. */
  presets: Record<string, CameraPreset>
}>(() => ({
  motion: 'push',
  strength: DEFAULT_CAMERA_INTENSITY * 100,
  strengthSet: false,
  results: {},
  requests: {},
  presets: {},
}))

export function hasCameraMove(clip: Clip): boolean {
  return 'effects' in clip && clip.effects.some((e) => e.effectId === CAMERA_EFFECT_ID)
}

/** Image clips on the timeline, in time order. */
export function stillClips(project: Project): ImageClip[] {
  return Object.values(project.clips)
    .filter((c): c is ImageClip => c.type === 'image' && !c.meta?.behindSubjectOf)
    .sort((a, b) => a.start - b.start)
}

/** The stills the panel applies to: the selected image clip, else every still without a camera move yet. */
export function cameraTargets(project: Project, selection: Selection): ImageClip[] {
  const selected = selection.type === 'clip' ? project.clips[selection.id] : undefined
  if (selected?.type === 'image') return [selected]
  return stillClips(project).filter((c) => !hasCameraMove(c))
}

/** Bytes the depth estimator still has to download on this device (once), 0 when it is cached. */
export function depthDownloadBytes(): Promise<number> {
  return visionDownloadBytes('depth')
}

/** Bytes the depth model still has to download, once; 0 when it is cached or not `needed`. */
export function useDepthDownload(needed: boolean): number {
  const [bytes, setBytes] = useState(0)
  useEffect(() => {
    if (!needed) return
    let live = true
    void depthDownloadBytes().then((b) => {
      if (live) setBytes(b)
    })
    return () => {
      live = false
    }
  }, [needed])
  return needed ? bytes : 0
}

const depthMedia = { getFile: appMedia.getFile, storeBlob: mediaStore.storeBlob.bind(mediaStore) }

/** Back to the automatic amount, with the slider at 50%, the most it gives. */
export function resetStrength(): void {
  useCamera.setState({ strength: DEFAULT_CAMERA_INTENSITY * 100, strengthSet: false })
}

/** The intensity new moves get: the Strength the user set, else undefined for vision's automatic amount. */
export function chosenIntensity(): number | undefined {
  const { strength, strengthSet } = useCamera.getState()
  return strengthSet ? strength / 100 : undefined
}

/** Adds the camera move to the stills as one job and one undo step. Without `intensity`, each still gets a safe amount. */
export function startCameraMoves(
  clipIds: readonly Id[],
  preset: CameraPreset,
  intensity: number | undefined,
): JobHandle<CameraMovesResult> | undefined {
  if (isRunning(JOB_KINDS.camera) || !clipIds.length) return undefined
  const project = editor.getProject()
  const names = clipIds.map((id) => {
    const clip = project.clips[id]
    const asset = clip && 'assetId' in clip ? project.assets[clip.assetId] : undefined
    return clip?.name ?? asset?.name ?? 'Image'
  })
  const n = clipIds.length
  let id = ''
  const handle = jobs.run({
    kind: JOB_KINDS.camera,
    title: n === 1 ? 'Adding a 3D camera move' : `Adding 3D camera moves to ${n} images`,
    run: showingDownloads(['depth'], async (ctx) => {
      const message = (fraction: number) => {
        const i = Math.min(n - 1, Math.floor(fraction * n))
        return n === 1
          ? `Estimating depth · ${names[0]}`
          : `Estimating depth · ${names[i]} (${i + 1} of ${n})`
      }
      ctx.progress({ fraction: 0, stage: 'loading', message: message(0) })
      const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
      const result = await v.addCameraMoves({ editor, media: depthMedia, depth: vision.depth }, clipIds, {
        preset,
        ...(intensity === undefined ? {} : { intensity }),
        alternatives: Object.values(MOTION_PRESETS),
        signal: ctx.signal,
        onProgress: (p) => ctx.progress({ ...p, message: message(p.fraction ?? 0) }),
      })
      useCamera.setState((s) => ({ results: { ...s.results, [id]: result } }))
      return result
    }),
  })
  id = handle.id
  useCamera.setState((s) => ({
    requests: { ...s.requests, [id]: clipIds },
    presets: { ...s.presets, [id]: preset },
  }))
  return handle
}

/** What a 3D camera move may do to its still when it is too strong. */
export type CameraRisk = 'smear' | 'bend'

export interface CameraRiskAt {
  risk: CameraRisk
  /** The strength (percent) above which it may. */
  above: number
}

/** What a move at `strength` (percent) may do to its still, from vision's safe amounts, the lowest strength first. */
export function cameraRisks(safe: SafeAmounts, strength: number): CameraRiskAt[] {
  return (['smear', 'bend'] as const)
    .map((risk) => ({ risk, above: Math.round(safe[risk] * 100) }))
    .filter((r) => strength > r.above)
    .sort((a, b) => a.above - b.above)
}

const RISK_WORDS = {
  long: { smear: 'smear behind foreground objects', bend: 'bend straight lines' },
  short: { smear: 'smear', bend: 'bend lines' },
} satisfies Record<string, Record<CameraRisk, string>>

/** The risks as facts ("bend lines above 15%", "smear above 40%"), one fact when both start at the same strength. */
export function riskFacts(risks: readonly CameraRiskAt[], words: keyof typeof RISK_WORDS): string[] {
  const w = RISK_WORDS[words]
  const from = (above: number) => (above > 0 ? `above ${above}%` : 'at any\u00a0strength')
  const [first, second] = risks
  if (first && second && first.above === second.above) return [`${w.smear} or ${w.bend} ${from(first.above)}`]
  return risks.map((r) => `${w[r.risk]} ${from(r.above)}`)
}

/**
 * The moves of a result that may still smear or bend: vision predicted it when they were added, and the clip still
 * has the move with `preset` at a strength above the still's safe amount. A move changed to another preset is left
 * out, since its safe amounts are for the preset it was added with.
 */
export function riskyMoves(
  project: Pick<Project, 'clips'>,
  result: Pick<CameraMovesResult, 'moves'>,
  preset: CameraPreset | undefined,
): { move: CameraMoveResult; strength: number; risks: CameraRiskAt[] }[] {
  return result.moves.flatMap((m) => {
    const clip = project.clips[m.clipId]
    const move = clip && cameraMoveOf(clip)
    if (!(m.smearRisk || m.bendRisk) || !move || move.preset !== preset) return []
    const strength = Math.round(move.intensity * 100)
    const risks = cameraRisks(m.safe, strength)
    return risks.length ? [{ move: m, strength, risks }] : []
  })
}

/**
 * What to tell the user when some of the `total` stills just given a move may smear or bend (`risks` lists what
 * each move may do, `alwaysBends` that every Motion bends its straight lines even at the lowest automatic strength,
 * `cleanAlternatives` the Motions predicted to keep them straight at that strength where this one bends them below
 * it, and how much each can take, `strength` the move's strength in percent); null when none may.
 */
export function riskNote(
  total: number,
  moves: readonly {
    risks: readonly CameraRiskAt[]
    alwaysBends: boolean
    cleanAlternatives?: CameraMoveResult['cleanAlternatives']
    strength: number
  }[],
): string | null {
  const risky = moves.filter((m) => m.risks.length)
  if (!risky.length) return null
  const count = risky.length < total ? `${risky.length} of ${total}` : total === 2 ? 'both' : `all ${total}`
  // Neither another motion nor a strength that still shows keeps such lines straight.
  if (risky.every((m) => m.alwaysBends && m.risks.every((r) => r.risk === 'bend')))
    return `Straight lines in ${total === 1 ? 'this image' : `${count} images`} may bend with any Motion. A lower Strength bends them less.`
  const has = (risk: CameraRisk) => risky.some((m) => m.risks.some((x) => x.risk === risk))
  const { smear, bend } = RISK_WORDS.long
  const what = has('smear') && has('bend') ? `${smear} or ${bend}` : has('smear') ? smear : bend
  // Lines that bend below the lowest automatic strength: a lower Strength leaves little motion to see and may not
  // straighten them, so a Motion predicted to keep them straight is the better advice. Changing Motion keeps the
  // move's strength, so the Motion must take that strength: an automatic move that bends is at the lowest automatic
  // strength, which every clean alternative takes; one set by hand may be beyond some or all of them.
  const clean = risky.map((m) =>
    (m.cleanAlternatives ?? [])
      .filter((a) => Math.round(a.safeIntensity * 100) >= m.strength)
      .map((a) => a.preset),
  )
  const bendsBelow = risky.every((m, i) => m.risks.some((r) => r.risk === 'bend') && clean[i]!.length)
  const named = bendsBelow
    ? clean[0]!
        .map(motionOf)
        .find((motion) => motion && clean.every((c) => c.includes(MOTION_PRESETS[motion])))
    : undefined
  // Only another motion helps a still that may do it at any strength, unless every motion bends its lines.
  const other = bendsBelow || risky.every((m) => m.risks[0]!.above === 0 && !m.alwaysBends)
  const advice = named
    ? `Set Motion to ${MOTION_LABELS[named]}.`
    : other
      ? 'Try another Motion.'
      : 'Try a lower Strength.'
  const rest = `may ${what} at this strength. ${advice}`
  if (total === 1) return `This image ${rest}`
  return `${count[0]!.toUpperCase()}${count.slice(1)} images ${rest}`
}

/** `riskNote` for a result as it was added. */
export function addedRiskNote(result: Pick<CameraMovesResult, 'moves'>): string | null {
  return riskNote(
    result.moves.length,
    result.moves.map((m) => {
      const strength = Math.round(m.intensity * 100)
      return {
        risks: cameraRisks(m.safe, strength),
        alwaysBends: m.alwaysBends,
        cleanAlternatives: m.cleanAlternatives,
        strength,
      }
    }),
  )
}

/** Undoes the camera moves while they are still the latest edit. Returns whether it did. */
export function undoCameraMoves(result: CameraMovesResult | undefined): boolean {
  if (!result || editor.undoLabel() !== result.label) return false
  return editor.undo()
}

/**
 * The 3D camera move on a clip: where it is in the effects list, its preset and strength, and whether it is flat (it has
 * no depth image, as after Replace with… gave the clip another image).
 */
export function cameraMoveOf(
  clip: Clip,
): { index: number; preset: CameraPreset; intensity: number; flat: boolean } | undefined {
  if (!('effects' in clip)) return undefined
  const index = clip.effects.findIndex((e) => e.effectId === CAMERA_EFFECT_ID)
  const fx = clip.effects[index]
  if (!fx) return undefined
  const preset = fx.params.preset?.value
  const intensity = fx.params.intensity?.value
  const depth = fx.params.depth?.value
  return {
    index,
    preset: typeof preset === 'string' ? (preset as CameraPreset) : DEFAULT_CAMERA_PRESET,
    intensity: typeof intensity === 'number' ? intensity : DEFAULT_CAMERA_INTENSITY,
    flat: typeof depth !== 'string' || !depth,
  }
}

const safeAmounts = new Map<string, Promise<SafeAmounts | null>>()

/**
 * vision's safeCameraAmounts for a clip's still with `preset`, kept for the session per depth image and preset
 * (`key`). A failure (the camera worker crashed, say) is not kept, so the next time they are needed they are computed
 * again.
 */
export function safeAmountsOf(key: string, clipId: Id, preset: CameraPreset): Promise<SafeAmounts | null> {
  const known = safeAmounts.get(key)
  if (known) return known
  const amount = import('../../vision/index.ts').then((v) =>
    v.safeCameraAmounts(appMedia, editor.getProject(), clipId, preset),
  )
  safeAmounts.set(key, amount)
  amount.catch(() => {
    if (safeAmounts.get(key) === amount) safeAmounts.delete(key)
  })
  return amount
}

/**
 * The largest strengths (0..1) predicted not to smear and not to bend the clip's still with its current move, from
 * its stored depth image (vision's safeCameraAmounts); null without a move and until they are known.
 */
export function useSafeAmounts(clip: Clip): SafeAmounts | null {
  const move = cameraMoveOf(clip)
  const depth = move && 'effects' in clip ? clip.effects[move.index]?.params.depth?.value : undefined
  // A flat move has no depth image to predict from.
  const key = move && !move.flat && typeof depth === 'string' ? `${depth}:${move.preset}` : null
  const preset = move?.preset
  const [known, setKnown] = useState<{ key: string; value: SafeAmounts | null } | null>(null)
  useEffect(() => {
    if (!key || !preset) return
    let live = true
    const show = (value: SafeAmounts | null) => {
      if (live) setKnown({ key, value })
    }
    safeAmountsOf(key, clip.id, preset).then(show, () => show(null))
    return () => {
      live = false
    }
  }, [key, preset, clip.id])
  return known && known.key === key ? known.value : null
}

/** The panel's motion for a preset, when it is one of the three it offers. */
export function motionOf(preset: CameraPreset): CameraMotion | undefined {
  return (Object.keys(MOTION_PRESETS) as CameraMotion[]).find((m) => MOTION_PRESETS[m] === preset)
}

/**
 * Changes the move's preset or strength in place; the depth map stays. Strength drags pass `gesture` so they coalesce
 * into one undo step (close it with editor.endGesture()).
 */
export function setCameraMove(
  clipId: Id,
  patch: { preset?: CameraPreset; intensity?: number },
  gesture = false,
): boolean {
  const clip = editor.getProject().clips[clipId]
  const move = clip && cameraMoveOf(clip)
  if (!move) return false
  const at = ['effects', move.index, 'params']
  const commands: EditCommand[] = []
  if (patch.preset !== undefined)
    commands.push({ type: 'clip.set', clipId, path: [...at, 'preset', 'value'], value: patch.preset })
  if (patch.intensity !== undefined)
    commands.push({
      type: 'clip.set',
      clipId,
      path: [...at, 'intensity', 'value'],
      value: Math.round(Math.min(1, Math.max(0, patch.intensity)) * 100) / 100,
    })
  if (!commands.length) return false
  return dispatch(commands, {
    label: patch.preset !== undefined ? 'Change 3D camera move' : 'Change 3D camera strength',
    ...(gesture ? { coalesceKey: `camera:${clipId}:strength` } : {}),
  })
}

export function removeCameraMove(clipId: Id): boolean {
  const clip = editor.getProject().clips[clipId]
  const fx = clip && 'effects' in clip ? clip.effects.find((e) => e.effectId === CAMERA_EFFECT_ID) : undefined
  if (!fx) return false
  return dispatch(
    { type: 'effect.remove', clipId, effectInstanceId: fx.id },
    { label: 'Remove 3D camera move' },
  )
}
