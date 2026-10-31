import { JobError } from '../../shared/jobs.ts'
import { createWorkerClient, type WorkerClient } from '../../shared/worker.ts'
import type { CameraPrediction, PredictionRequest } from '../cameraPrediction.ts'
import type { CameraWorkerApi } from './camera.worker.ts'

let client: WorkerClient<CameraWorkerApi> | null = null
let started: Promise<boolean> | null = null

const camera = () =>
  (client ??= createWorkerClient<CameraWorkerApi>(
    () =>
      new Worker(new URL('./camera.worker.ts', import.meta.url), { type: 'module', name: 'vision-camera' }),
  ))

/**
 * Starts the camera worker, which then stays; false where there are no workers or its script did not load. The
 * browser fetches a worker's script only when the worker starts, so one started early is there for a move made after
 * the network drops.
 */
export function startCameraWorker(): Promise<boolean> {
  if (typeof Worker === 'undefined') return Promise.resolve(false)
  started ??= camera()
    .call('ready', undefined)
    .then(
      () => true,
      () => {
        started = null
        return false
      },
    )
  return started
}

/** `predictCameraMove` in the camera worker; null when the worker cannot start. */
export async function predictInWorker(
  request: PredictionRequest,
  signal?: AbortSignal,
): Promise<CameraPrediction | null> {
  if (!(await startCameraWorker())) return null
  try {
    return await camera().call('predict', request, signal ? { signal } : {})
  } catch (error) {
    // The next call starts a fresh worker, whose script has to load again.
    if (error instanceof JobError && error.code === 'worker-crashed') started = null
    throw error
  }
}
