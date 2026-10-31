import { get, set } from './ui.ts'

/** Timeline zoom limits in pixels per second. */
export const MIN_PPS = 3
export const MAX_PPS = 80

export function zoomTo(pxPerSec: number): void {
  set({ pxPerSec: Math.min(MAX_PPS, Math.max(MIN_PPS, pxPerSec)) })
}

export function zoomBy(factor: number): void {
  zoomTo(get().pxPerSec * factor)
}

let fitter: (() => void) | null = null

/** The timeline registers how it fits the whole song in its width; returns the unregister function. */
export function registerFit(fit: () => void): () => void {
  fitter = fit
  return () => {
    if (fitter === fit) fitter = null
  }
}

/** Zooms the timeline so the whole song fits, when the timeline is showing. */
export function fitTimeline(): void {
  fitter?.()
}
