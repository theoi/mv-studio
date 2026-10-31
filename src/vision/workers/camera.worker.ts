/// <reference lib="webworker" />
import { exposeWorker, transfer } from '../../shared/worker.ts'
import { predictCameraMove, type PredictionRequest } from '../cameraPrediction.ts'

/** The camera-move prediction (`cameraPrediction.ts`), off the page's thread. */

const api = {
  ready: () => true,
  async predict(request: PredictionRequest) {
    const result = await predictCameraMove(request)
    return transfer(result, result.prepared ? [result.prepared.data.buffer] : [])
  },
}

export type CameraWorkerApi = typeof api

exposeWorker(api)
