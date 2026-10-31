import { RealFFT, hannWindow } from './fft.ts'

export interface FrameGrid {
  sampleRate: number
  /** Frames per second; frame i is centered on sample round(i * sampleRate / fps). */
  fps: number
  frames: number
}

export function frameGrid(sampleCount: number, sampleRate: number, fps: number): FrameGrid {
  return { sampleRate, fps, frames: Math.floor((sampleCount / sampleRate) * fps) + 1 }
}

export function frameCenter(grid: FrameGrid, index: number): number {
  return Math.round((index * grid.sampleRate) / grid.fps)
}

/**
 * Iterates windowed FFT frames centered on the frame grid (zero padding outside the signal).
 * The callback receives the power spectrum (|X|^2) of each frame; buffers are reused.
 */
export function forEachPowerFrame(
  signal: Float32Array,
  grid: FrameGrid,
  nFft: number,
  fn: (index: number, power: Float64Array) => void,
  window: Float64Array = hannWindow(nFft),
): void {
  const fft = new RealFFT(nFft)
  const buf = new Float64Array(nFft)
  const re = new Float64Array(fft.bins)
  const im = new Float64Array(fft.bins)
  const power = new Float64Array(fft.bins)
  const n = signal.length
  const halfN = nFft >> 1
  for (let f = 0; f < grid.frames; f++) {
    const start = frameCenter(grid, f) - halfN
    if (start >= 0 && start + nFft <= n) {
      for (let i = 0; i < nFft; i++) buf[i] = signal[start + i] * window[i]
    } else {
      for (let i = 0; i < nFft; i++) {
        const k = start + i
        buf[i] = k >= 0 && k < n ? signal[k] * window[i] : 0
      }
    }
    fft.forward(buf, re, im)
    for (let k = 0; k < fft.bins; k++) power[k] = re[k] * re[k] + im[k] * im[k]
    fn(f, power)
  }
}

export interface SparseFilter {
  start: number
  weights: Float64Array
}

function hzToMelSlaney(hz: number): number {
  const fMin = 0
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = (minLogHz - fMin) / fSp
  const logStep = Math.log(6.4) / 27
  return hz >= minLogHz ? minLogMel + Math.log(hz / minLogHz) / logStep : (hz - fMin) / fSp
}

function melToHzSlaney(mel: number): number {
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = minLogHz / fSp
  const logStep = Math.log(6.4) / 27
  return mel >= minLogMel ? minLogHz * Math.exp(logStep * (mel - minLogMel)) : fSp * mel
}

/** Triangular mel filterbank (Slaney scale, area-normalized like librosa's default). */
export function melFilterbank(
  sampleRate: number,
  nFft: number,
  nMels: number,
  fMin: number,
  fMax: number,
  normalize = true,
): SparseFilter[] {
  const bins = nFft / 2 + 1
  const melMin = hzToMelSlaney(fMin)
  const melMax = hzToMelSlaney(fMax)
  const pts: number[] = []
  for (let i = 0; i < nMels + 2; i++) pts.push(melToHzSlaney(melMin + ((melMax - melMin) * i) / (nMels + 1)))
  const filters: SparseFilter[] = []
  for (let m = 0; m < nMels; m++) {
    const lo = pts[m]
    const mid = pts[m + 1]
    const hi = pts[m + 2]
    const norm = normalize ? 2 / (hi - lo) : 1
    const weights: number[] = []
    let start = -1
    for (let k = 0; k < bins; k++) {
      const f = (k * sampleRate) / nFft
      const w = Math.max(0, Math.min((f - lo) / (mid - lo), (hi - f) / (hi - mid)))
      if (w > 0) {
        if (start < 0) start = k
        while (weights.length < k - start) weights.push(0)
        weights.push(w * norm)
      }
    }
    filters.push({ start: Math.max(0, start), weights: Float64Array.from(weights) })
  }
  return filters
}

export function applyFilter(filter: SparseFilter, spectrum: Float64Array): number {
  let s = 0
  const w = filter.weights
  for (let i = 0; i < w.length; i++) s += w[i] * spectrum[filter.start + i]
  return s
}
