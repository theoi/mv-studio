import { get, set } from './ui.ts'

/** Timeline zoom limits in pixels per second. */
export const MIN_PPS = 3
export const MAX_PPS = 80

let zoomer: ((pxPerSec: number) => void) | null = null

/** The timeline registers how it zooms in place; returns the unregister function. */
export function registerZoom(zoom: (pxPerSec: number) => void): () => void {
  zoomer = zoom
  return () => {
    if (zoomer === zoom) zoomer = null
  }
}

export function zoomTo(pxPerSec: number): void {
  const next = Math.min(MAX_PPS, Math.max(MIN_PPS, pxPerSec))
  if (zoomer) zoomer(next)
  else set({ pxPerSec: next })
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
