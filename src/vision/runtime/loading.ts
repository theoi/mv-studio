/**
 * Model loading inside the vision workers, for both runtimes (MediaPipe and Transformers.js). Kept out of
 * `downloads.ts`, which the main thread imports, and `loaders.ts`, which brings in MediaPipe.
 */
import type { JobProgress } from '../../shared/jobs.ts'
import { withModelProgress } from '../../shared/transformers.ts'
import { modelDownloads } from './downloads.ts'
import type { VisionModel } from './models.ts'

/**
 * Loads `model` inside a worker call: first-time downloads of its weights go to `report` as its download line, with
 * a last report once `load` ends. The loaders name the model in their errors (`downloadFailed`, `startFailed`).
 */
export async function loadingModel<T>(
  model: VisionModel,
  report: ((p: JobProgress) => void) | undefined,
  load: () => Promise<T>,
): Promise<T> {
  const downloads = modelDownloads(model, report)
  try {
    return await withModelProgress(downloads.file, load)
  } finally {
    downloads.end()
  }
}
