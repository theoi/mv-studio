import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Clip, EditCommand, Id, ImageClip, Project } from '../../model/index.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { jobs, type JobHandle } from '../../shared/jobs.ts'
import { modelCache } from '../../shared/models.ts'
import type { CameraMoveResult, CameraMovesResult, CameraPreset } from '../../vision/index.ts'
import { CAMERA_EFFECT_ID, DEFAULT_CAMERA_PRESET } from '../../vision/render/cameraEffect.ts'
import { VISION_MODELS } from '../../vision/runtime/models.ts'
import { visionService } from './footage.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { appMedia } from './media.ts'
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

/** The move's intensity when nothing set it (the effect's own default), and the panels' starting strength. */
const DEFAULT_CAMERA_INTENSITY = 0.5

export const useCamera = create<{
  motion: CameraMotion
  /** 0..100, the move's intensity in percent. */
  strength: number
  /** The user moved Strength. Until then each still gets vision's automatic amount: 0.5, or less where it smears. */
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

/** Bytes the depth model still has to download (once), 0 when it is cached. */
export async function depthDownloadBytes(): Promise<number> {
  const files = Object.values(VISION_MODELS.depthAnythingSmall.files)
  const cached = await Promise.all(files.map((f) => modelCache.has(f.url).catch(() => false)))
  return files.reduce((sum, f, i) => sum + (cached[i] ? 0 : (f.bytes ?? 0)), 0)
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
    run: async (ctx) => {
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
        signal: ctx.signal,
        onProgress: (p) => ctx.progress({ ...p, message: message(p.fraction ?? 0) }),
      })
      useCamera.setState((s) => ({ results: { ...s.results, [id]: result } }))
      return result
    },
  })
  id = handle.id
  useCamera.setState((s) => ({
    requests: { ...s.requests, [id]: clipIds },
    presets: { ...s.presets, [id]: preset },
  }))
  return handle
}

/**
 * The moves of a result that may still smear: vision predicted it (`smearRisk`) and the clip still has the move
 * with `preset` at a strength above the still's safe amount. A move changed to another preset is left out, since its
 * safe amount is for the preset it was added with.
 */
export function smearingMoves(
  project: Pick<Project, 'clips'>,
  result: Pick<CameraMovesResult, 'moves'>,
  preset: CameraPreset | undefined,
): CameraMoveResult[] {
  return result.moves.filter((m) => {
    const clip = project.clips[m.clipId]
    const move = clip && cameraMoveOf(clip)
    return m.smearRisk && !!move && move.preset === preset && move.intensity > m.safeIntensity
  })
}

/** What to tell the user when `smearing` of the `total` stills just given a move may smear; null when none may. */
export function smearNote(total: number, smearing: number): string | null {
  if (!smearing) return null
  const rest = 'may smear behind foreground objects at this strength. Try a lower Strength.'
  if (total === 1) return `This image ${rest}`
  return `${smearing === total ? `All ${total}` : `${smearing} of ${total}`} images ${rest}`
}

/** Undoes the camera moves while they are still the latest edit. Returns whether it did. */
export function undoCameraMoves(result: CameraMovesResult | undefined): boolean {
  if (!result || editor.undoLabel() !== result.label) return false
  return editor.undo()
}

/** The 3D camera move on a clip: where it is in the effects list and its preset and strength. */
export function cameraMoveOf(
  clip: Clip,
): { index: number; preset: CameraPreset; intensity: number } | undefined {
  if (!('effects' in clip)) return undefined
  const index = clip.effects.findIndex((e) => e.effectId === CAMERA_EFFECT_ID)
  const fx = clip.effects[index]
  if (!fx) return undefined
  const preset = fx.params.preset?.value
  const intensity = fx.params.intensity?.value
  return {
    index,
    preset: typeof preset === 'string' ? (preset as CameraPreset) : DEFAULT_CAMERA_PRESET,
    intensity: typeof intensity === 'number' ? intensity : DEFAULT_CAMERA_INTENSITY,
  }
}

const safeAmounts = new Map<string, Promise<number | null>>()

/**
 * The largest strength (0..1) predicted not to smear the background of the clip's still with its current move, from
 * its stored depth image (vision's safeCameraIntensity); null without a move and until it is known.
 */
export function useSafeIntensity(clip: Clip): number | null {
  const move = cameraMoveOf(clip)
  const depth = move && 'effects' in clip ? clip.effects[move.index]?.params.depth?.value : undefined
  const key = move && typeof depth === 'string' ? `${depth}:${move.preset}` : null
  const preset = move?.preset
  const [known, setKnown] = useState<{ key: string; value: number | null } | null>(null)
  useEffect(() => {
    if (!key || !preset) return
    let live = true
    let amount = safeAmounts.get(key)
    if (!amount) {
      amount = import('../../vision/index.ts')
        .then((v) => v.safeCameraIntensity(appMedia, editor.getProject(), clip.id, preset))
        .catch(() => null)
      safeAmounts.set(key, amount)
    }
    void amount.then((value) => {
      if (live) setKnown({ key, value })
    })
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
