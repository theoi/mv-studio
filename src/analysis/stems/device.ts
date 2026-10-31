import type { RuntimeCapabilities } from '../../shared/capabilities.ts'
import { preferredDevice, type ModelDevice } from '../../shared/models.ts'

/** WebGPU on a hardware adapter, else WASM threads: a software adapter (SwiftShader) is about 50 times slower. */
export function stemDevice(caps: RuntimeCapabilities): ModelDevice {
  return /swiftshader/i.test(caps.webgpu.adapter ?? '') ? 'wasm' : preferredDevice(caps)
}

/*
 * Stem separation time on a device that has not separated anything yet, rounded up from the slower of the 4-core
 * machines without a GPU it was measured on: 1.50-1.55 s per second of song for the separation stage with 3 WASM
 * threads, through the app, on 3, 4 and 5 minute songs. Another 4-core machine took 1.09, so speeds differ by half
 * between machines that look alike; after its first separation a device uses its own pace (`MeasuredPace`). The split
 * between the fixed and per-thread parts is from runs with 1 to 4 threads. The GPU figure is a guess until measured
 * on real GPUs.
 */
const WASM_FIXED = 0.4
const WASM_PER_THREAD = 3.5
const WEBGPU_SECONDS_PER_SECOND = 0.6
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

function defaultPace(device: ModelDevice, threads: number): number {
  return device === 'webgpu' ? WEBGPU_SECONDS_PER_SECOND : WASM_FIXED + WASM_PER_THREAD / Math.max(1, threads)
}

/**
 * How many times longer than the defaults work takes on this device: from its measured pace (on the same device
 * kind), else 1. Clamped, so one odd run cannot make an estimate absurd.
 */
export function deviceSlowdown(device: ModelDevice, measured?: MeasuredPace): number {
  if (!measured || measured.device !== device || !(measured.secondsPerSecond > 0)) return 1
  return Math.min(4, Math.max(0.25, measured.secondsPerSecond / defaultPace(device, measured.threads)))
}

/** Seconds the separation stage takes per second of song. */
export function separateSecondsPerSecond(
  device: ModelDevice,
  threads: number,
  measured?: MeasuredPace,
): number {
  return defaultPace(device, threads) * deviceSlowdown(device, measured)
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
