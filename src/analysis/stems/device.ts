import type { RuntimeCapabilities } from '../../shared/capabilities.ts'
import { preferredDevice, type ModelDevice } from '../../shared/models.ts'

/** WebGPU on a hardware adapter, else WASM threads: a software adapter (SwiftShader) is about 50 times slower. */
export function stemDevice(caps: RuntimeCapabilities): ModelDevice {
  return /swiftshader/i.test(caps.webgpu.adapter ?? '') ? 'wasm' : preferredDevice(caps)
}

/*
 * Stem separation time on a device that has not separated anything yet, rounded up from the slower of the 4-core
 * machines without a GPU it was measured on: 1.48-1.56 s per second of song for the separation stage with 3 WASM
 * threads, through the app, on 3, 4 and 5 minute songs. Another 4-core machine took 1.09, so speeds differ by half
 * between machines that look alike; after its first separation a device uses its own pace (`MeasuredPace`). The split
 * between the fixed and per-thread parts is from runs with 1 to 4 threads. WebGPU uses the same figure until the
 * device has separated a song on it: no GPU has been measured, and a GPU session can run parts of the model on WASM.
 */
const WASM_FIXED = 0.4
const WASM_PER_THREAD = 3.5
/**
 * On top of every pace, measured or default: a run can be busier than the ones measured. Separating right after
 * import, while song analysis is still finishing, took 1.67-1.70 times the song's length against 1.55-1.64 alone.
 */
const MARGIN = 1.1
/** Reading the song and starting the cached model. */
const SETUP_SECONDS = 5
/** Measuring, encoding and saving the four stems after the separation, per second of song (11-19 s per song). */
export const STEM_FINISH_SECONDS_PER_SECOND = 0.065

/** The separation stage's pace on this device, measured by its last separation. */
export interface MeasuredPace {
  secondsPerSecond: number
  device: ModelDevice
  threads: number
}

function wasmPace(threads: number): number {
  return WASM_FIXED + WASM_PER_THREAD / Math.max(1, threads)
}

function measuredOn(device: ModelDevice, measured?: MeasuredPace): measured is MeasuredPace {
  return measured?.device === device && measured.secondsPerSecond > 0
}

/**
 * How many times longer than the WASM defaults work takes on this device: from the pace of its last separation on
 * WASM, with a margin, else 1. Clamped, so one odd run cannot make an estimate absurd. A WebGPU pace says nothing
 * about the WASM threads the lyrics models share with stems, so it gives 1.
 */
export function deviceSlowdown(device: ModelDevice, measured?: MeasuredPace): number {
  if (device !== 'wasm' || !measuredOn('wasm', measured)) return 1
  const ratio = (MARGIN * measured.secondsPerSecond) / wasmPace(measured.threads)
  return Math.min(4, Math.max(0.25, ratio))
}

/**
 * Seconds the separation stage takes per second of song: the WASM default until the device has measured its own pace
 * on `device`, then that pace, both with a margin.
 */
export function separateSecondsPerSecond(
  device: ModelDevice,
  threads: number,
  measured?: MeasuredPace,
): number {
  if (!measuredOn(device, measured)) return MARGIN * wasmPace(threads)
  if (device === 'wasm') return wasmPace(threads) * deviceSlowdown(device, measured)
  return Math.min(4 * wasmPace(threads), MARGIN * measured.secondsPerSecond)
}

/** Seconds a whole separation job takes for a song of `duration` seconds, once the model is downloaded. */
export function stemJobSeconds(
  duration: number,
  device: ModelDevice,
  threads: number,
  measured?: MeasuredPace,
): number {
  return Math.ceil(
    SETUP_SECONDS +
      duration * (separateSecondsPerSecond(device, threads, measured) + STEM_FINISH_SECONDS_PER_SECOND),
  )
}
