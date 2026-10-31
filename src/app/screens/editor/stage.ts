import { applyMat, fitSize, layerMatrix } from '../../../engine/layout.ts'
import { PreviewController } from '../../../engine/preview.ts'
import { cssFont, fontPxFor, layoutText } from '../../../engine/text.ts'
import type { Clip, Project } from '../../../model/index.ts'
import { appMedia } from '../../state/media.ts'
import { editor } from '../../state/project.ts'
import { get, set, useUi, type Selection } from '../../state/ui.ts'

/**
 * Runs the engine preview on a canvas: the project comes from the editor, and the UI playhead and play state follow
 * the Web Audio clock (while playing) or drive it (seeks, play and pause from buttons and shortcuts).
 */
export function connectPreview(
  canvas: HTMLCanvasElement,
  viewport: { width: number; height: number },
): { preview: PreviewController; dispose(): void } {
  const preview = new PreviewController({ canvas, media: appMedia })
  // The playhead last written from the clock, so it is not sent back as a seek.
  let fromClock = Number.NaN
  let wasPlaying = false
  // Size and time first, so the first frame drawn is the one the user sees.
  preview.setViewport(viewport.width, viewport.height)
  preview.seek(get().playhead)
  preview.setProject(editor.getProject())
  if (get().playing) set({ playing: false })
  const unsubscribe = [
    editor.subscribe((project) => preview.setProject(project)),
    useUi.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead && s.playhead !== fromClock) preview.seek(s.playhead)
      if (s.playing === prev.playing) return
      if (s.playing) {
        if (preview.clock.state !== 'playing') set({ starting: true })
        // Called synchronously from the click or key press, so the browser lets audio start.
        void preview.play()
      } else {
        if (s.starting) set({ starting: false })
        preview.pause()
      }
    }),
    preview.subscribe(() => {
      const { state, time } = preview.getSnapshot()
      const playing = state === 'playing'
      if (playing && get().starting) set({ starting: false })
      if (wasPlaying && !playing) {
        fromClock = time
        set({ playing: false, starting: false, playhead: time })
      }
      wasPlaying = playing
    }),
    preview.onFrame((time) => {
      if (preview.clock.state !== 'playing') return
      fromClock = time
      set({ playhead: time })
    }),
  ]
  return {
    preview,
    dispose() {
      for (const u of unsubscribe) u()
      preview.dispose()
      if (get().playing) set({ playing: false, starting: false })
    },
  }
}

/** The largest frame of the given aspect ratio that fits the stage, in CSS pixels. */
export function fitStage(stage: HTMLElement, ratio: number): { width: number; height: number } {
  const r = stage.getBoundingClientRect()
  const pad = 12
  const width = Math.max(1, Math.floor(Math.min(r.width - pad * 2, (r.height - pad * 2) * ratio)))
  return { width, height: Math.max(1, Math.floor(width / ratio)) }
}

let measureCtx: CanvasRenderingContext2D | null = null

function textBox(clip: Extract<Clip, { type: 'text' }>, width: number, height: number): [number, number] {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  const ctx = measureCtx
  if (!ctx) return [width, height]
  const fontPx = fontPxFor(clip.style, height)
  const font = cssFont(clip.style, fontPx)
  ctx.font = font
  ctx.letterSpacing = `${clip.style.letterSpacing * fontPx}px`
  const layout = layoutText({
    text: clip.text,
    style: clip.style,
    canvasWidth: width,
    canvasHeight: height,
    font,
    padding: fontPx * 0.2,
    measure: (s) => ctx.measureText(s).width,
  })
  return [layout.width, layout.height]
}

/** The selected clip's outline on the preview at time t, as four corners in CSS pixels, or null when off screen. */
export function selectionOutline(
  project: Project,
  selection: Selection,
  t: number,
  width: number,
  height: number,
): [number, number][] | null {
  const live = (c: Clip) => c.enabled && t >= c.start && t < c.start + c.duration
  let clip: Clip | undefined
  if (selection.type === 'clip') clip = project.clips[selection.id]
  else if (selection.type === 'lyric')
    clip = Object.values(project.clips).find(
      (c) => c.type === 'text' && c.lyricLineId === selection.id && live(c),
    )
  if (!clip || clip.type === 'audio' || !live(clip)) return null
  if (project.tracks.find((tr) => tr.id === clip.trackId)?.hidden) return null
  let base: [number, number] = [width, height]
  if (clip.type === 'video' || clip.type === 'image') {
    const asset = project.assets[clip.assetId]
    base = fitSize(clip.fit, asset?.width ?? width, asset?.height ?? height, width, height)
  } else if (clip.type === 'text') base = textBox(clip, width, height)
  const m = layerMatrix(clip, t - clip.start, t, base[0], base[1], width, height)
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => applyMat(m, u as number, v as number))
}
