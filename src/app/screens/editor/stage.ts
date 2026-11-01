import { applyMat, fitSize, layerMatrix } from '../../../engine/layout.ts'
import { PreviewController } from '../../../engine/preview.ts'
import { cssFont, fontPxFor, layoutText } from '../../../engine/text.ts'
import type { Clip, Project, VisualClip } from '../../../model/index.ts'
import { prepareSampleVideos } from '../../mock/sampleMedia.ts'
import { appMedia } from '../../state/media.ts'
import { prefs, usePrefs } from '../../state/prefs.ts'
import { loopRange } from '../../state/previewControls.ts'
import { editor } from '../../state/project.ts'
import { audioErrorText, forgetStemPlaybackErrors, noteStemPlaybackError } from '../../state/stems.ts'
import { decodeThumbnailsAfter } from '../../state/thumbs.ts'
import { get, set, toast, useUi, type Selection } from '../../state/ui.ts'

/** Assets whose audio failure was already shown, so a preview that fails again on them stays quiet. */
const reportedAudio = new Set<string>()

/** The longest thumbnails wait for the preview's first frame before they decode anyway. */
const THUMBNAIL_HOLD_MS = 3000

let current: PreviewController | null = null
// The project the preview was last given, so the same one is not drawn twice.
let shown: Project | null = null

/** The preview drawing the editor's stage, while one is showing (for tests that read its frames). */
export function stagePreview(): PreviewController | null {
  return current
}

/** Shows a project the editor does not have yet, such as a drag in progress; null goes back to the editor's. */
export function showDraft(project: Project | null) {
  const next = project ?? editor.getProject()
  if (!current || next === shown) return
  shown = next
  current.setProject(next)
}

/**
 * Runs the engine preview on a canvas: the project comes from the editor, and the UI playhead and play state follow
 * the Web Audio clock (while playing) or drive it (seeks, play and pause from buttons and shortcuts).
 */
export function connectPreview(
  canvas: HTMLCanvasElement,
  viewport: { width: number; height: number },
): { preview: PreviewController; dispose(): void } {
  const preview = new PreviewController({ canvas, media: appMedia })
  current = preview
  // The playhead last written from the clock, so it is not sent back as a seek.
  let fromClock = Number.NaN
  let wasPlaying = false
  let loopKey = ''
  // Only when the range changes: setting a loop while playing reschedules the audio.
  const applyLoop = (t: number) => {
    const range = get().loop ? loopRange(editor.getProject(), t) : null
    const key = range ? `${range.start}:${range.end}` : ''
    if (key === loopKey) return
    loopKey = key
    preview.setLoop(range && { start: range.start, end: range.end })
  }
  // Size and time first, so the first frame drawn is the one the user sees.
  preview.setViewport(viewport.width, viewport.height)
  preview.seek(get().playhead)
  // Before the first project, so stems this preview cannot play are reported by it, even ones that failed before.
  const offAudioError = preview.clock.onAudioError((error) => {
    noteStemPlaybackError(editor.getProject(), error)
    const details = error.details as { assetId?: string } | undefined
    const key = details?.assetId ?? error.message
    if (reportedAudio.has(key)) return
    reportedAudio.add(key)
    toast(audioErrorText(editor.getProject(), error))
  })
  // Thumbnails decode once this preview shows a project's first frame, so they don't hold it up, but no longer than
  // THUMBNAIL_HOLD_MS or past an error: a preview that never draws must not leave every thumbnail empty.
  let shownId: string | null = null
  let releaseThumbnails = () => {}
  const holdThumbnails = () => {
    releaseThumbnails()
    let resolve = () => {}
    decodeThumbnailsAfter(new Promise<void>((done) => (resolve = done)))
    const offFrame = preview.onFrame(() => releaseThumbnails())
    const offError = preview.subscribe(() => {
      if (preview.getSnapshot().error) releaseThumbnails()
    })
    const timer = setTimeout(() => releaseThumbnails(), THUMBNAIL_HOLD_MS)
    releaseThumbnails = () => {
      offFrame()
      offError()
      clearTimeout(timer)
      resolve()
    }
  }
  const showProject = (project: Project) => {
    if (project.id !== shownId) holdThumbnails()
    shownId = project.id
    shown = project
    preview.setProject(project)
    forgetStemPlaybackErrors(project, preview.clock.scheduledClips)
    prepareSampleVideos(project.assets)
  }
  showProject(editor.getProject())
  preview.setVolume(prefs().previewVolume)
  applyLoop(get().playhead)
  if (get().playing) set({ playing: false })
  const unsubscribe = [
    offAudioError,
    editor.subscribe((project) => {
      showProject(project)
      applyLoop(get().playhead)
    }),
    usePrefs.subscribe((p, prev) => {
      if (p.previewVolume !== prev.previewVolume) preview.setVolume(p.previewVolume)
    }),
    useUi.subscribe((s, prev) => {
      const seeked = s.playhead !== prev.playhead && s.playhead !== fromClock
      // A seek into another section moves the loop there.
      if (seeked || s.loop !== prev.loop) applyLoop(s.playhead)
      if (seeked) preview.seek(s.playhead)
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
      // Play reschedules, and plays stems an export decoded meanwhile.
      forgetStemPlaybackErrors(editor.getProject(), preview.clock.scheduledClips)
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
      releaseThumbnails()
      prepareSampleVideos(null)
      if (current === preview) {
        current = null
        shown = null
      }
      preview.dispose()
      if (get().playing) set({ playing: false, starting: false })
    },
  }
}

/** The largest frame of the given aspect ratio that fits the stage with `pad` around it, in CSS pixels. */
export function fitStage(stage: HTMLElement, ratio: number, pad = 12): { width: number; height: number } {
  const r = stage.getBoundingClientRect()
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

/** The clip the selection shows on the preview at time t, if any (a lyric line selects its text clip there). */
export function selectedClip(project: Project, selection: Selection, t: number): VisualClip | undefined {
  const live = (c: Clip) => c.enabled && t >= c.start && t < c.start + c.duration
  let clip: Clip | undefined
  if (selection.type === 'clip') clip = project.clips[selection.id]
  else if (selection.type === 'lyric')
    clip = Object.values(project.clips).find(
      (c) => c.type === 'text' && c.lyricLineId === selection.id && live(c),
    )
  if (!clip || clip.type === 'audio' || !live(clip)) return undefined
  if (project.tracks.find((tr) => tr.id === clip.trackId)?.hidden) return undefined
  return clip
}

/** The selected clip's outline on the preview at time t, as four corners in CSS pixels, or null when off screen. */
export function selectionOutline(
  project: Project,
  selection: Selection,
  t: number,
  width: number,
  height: number,
): [number, number][] | null {
  const clip = selectedClip(project, selection, t)
  if (!clip) return null
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
