import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Clip, Id, ImageClip, Project } from '../../model/index.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { jobs, type JobHandle } from '../../shared/jobs.ts'
import { modelCache } from '../../shared/models.ts'
import type { CameraMovesResult, CameraPreset } from '../../vision/index.ts'
import { CAMERA_EFFECT_ID } from '../../vision/render/cameraEffect.ts'
import { VISION_MODELS } from '../../vision/runtime/models.ts'
import { visionService } from './footage.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { appMedia } from './media.ts'
import { editor } from './project.ts'
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

export const useCamera = create<{
  motion: CameraMotion
  /** 0..100, the move's intensity in percent. */
  strength: number
  results: Record<string, CameraMovesResult>
}>(() => ({ motion: 'push', strength: 40, results: {} }))

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

/** Adds the camera move to the stills as one job and one undo step. */
export function startCameraMoves(
  clipIds: readonly Id[],
  preset: CameraPreset,
  intensity: number,
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
        intensity,
        signal: ctx.signal,
        onProgress: (p) => ctx.progress({ ...p, message: message(p.fraction ?? 0) }),
      })
      useCamera.setState((s) => ({ results: { ...s.results, [id]: result } }))
      return result
    },
  })
  id = handle.id
  return handle
}

/** Undoes the camera moves while they are still the latest edit. Returns whether it did. */
export function undoCameraMoves(result: CameraMovesResult | undefined): boolean {
  if (!result || editor.undoLabel() !== result.label) return false
  return editor.undo()
}
