import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Id, Project } from '../../model/index.ts'
import { webgl2Available } from '../../shared/capabilities.ts'
import { JobError, jobs, type JobContext, type JobSnapshot } from '../../shared/jobs.ts'
import type {
  AssetIndexStatus,
  DirectorFootageMatcher,
  FootageIndexer,
  FootageMatcher,
  FootageResult,
  FootageService,
  IndexingState,
  VisionModel,
  VisionService,
  VisionServiceOptions,
} from '../../vision/index.ts'
import { hasUncheckedMedia, readClipTags } from '../../vision/analysisData.ts'
import { mediaById } from '../mock/media.ts'
import { stillPending, subscribeStill } from '../screens/editor/stage.ts'
import { isSampleAsset } from '../mock/sampleMedia.ts'
import { JOB_KINDS } from './jobs.ts'
import { appMedia } from './media.ts'
import { editor } from './project.ts'

/*
 * Background footage analysis (matching and subject tracking for framing) and search, from src/vision. The vision
 * code loads on first use, so it and its models stay out of the main bundle. The service reads media through
 * appMedia, which also serves the sample project's generated clips.
 */

const SETTING_KEY = 'mv-studio.background-analysis'

interface FootageState {
  service: FootageService | null
  indexing: IndexingState | null
  /** Score from which a result counts as a match worth suggesting. */
  strongMatch: number
  /** Library › Media should scroll its suggestion row into view when it next shows. */
  revealSuggestions: boolean
}

export const useFootage = create<FootageState>(() => ({
  service: null,
  indexing: null,
  strongMatch: 1,
  revealSuggestions: false,
}))

let loading: Promise<FootageService> | null = null
let visionLoading: Promise<VisionService> | null = null
let testBackends: VisionServiceOptions['backends'] | undefined

/** For end-to-end tests: analyze with model-free backends instead of downloading models. */
export function setVisionBackendsForTests(backends: VisionServiceOptions['backends']): void {
  testBackends = backends
}

let directorDeps: { ranker: FootageMatcher; matcher: DirectorFootageMatcher } | undefined

/** Clip matching for the director (src/director), once the vision service has loaded; undefined before. */
export function directorFootage() {
  return directorDeps
}

/** The app's vision service, shared by footage analysis and the vision tools (auto-cut, 3D camera, cutouts). */
export function visionService(): Promise<VisionService> {
  visionLoading ??= import('../../vision/index.ts').then((v) => {
    const backends = testBackends ?? v.createWorkerBackends()
    const vision = v.createVisionService({
      backends,
      cache: testBackends ? v.createMemoryCache() : v.createOpfsCache(),
    })
    releaseWhenIdle(backends)
    // A paused frame the stage waits for decodes the same files: a ruler click, a draft's first frame. Held here, not
    // with footage analysis, because the person check also waits for it where background analysis is off.
    holdAnalysisWhile(stillPending, subscribeStill)
    directorDeps = {
      ranker: vision.matcher,
      matcher: v.createDirectorFootageMatcher({
        matcher: vision.matcher,
        getProject: () => editor.getProject(),
      }),
    }
    return vision
  })
  return visionLoading
}

/** How long the vision workers keep their models once nothing uses them: a model loads again in a few seconds. */
const VISION_IDLE_MS = 60_000

let releaseVisionSoon: () => void = () => undefined

/**
 * Frees the vision workers' memory (0.4–0.5 GB after an auto-cut) once no vision job runs: at once when stem
 * separation or lyric timing starts (it separates stems first when the song has none), which need much memory, or
 * when another project opens, and otherwise after `VISION_IDLE_MS`. Some vision jobs keep state in the workers between
 * calls (a segmenter configured for a clip, a mask track being built), so nothing is released while one is running or
 * queued. The check and the release run in one task, so a job queued after it gets fresh workers. A release for
 * another project opening waits for the last project's vision jobs to stop; once the next project starts one of its
 * own, the idle timer decides instead, so it doesn't load its models again as soon as that job ends.
 */
function releaseWhenIdle(backends: VisionServiceOptions['backends']): void {
  const release = backends.release?.bind(backends)
  if (!release) return
  // Besides the vision.* jobs, these rank clips on the ONNX worker.
  const matching: ReadonlySet<string> = new Set([JOB_KINDS.autocut, JOB_KINDS.director, JOB_KINDS.ask])
  const needRoom: ReadonlySet<string> = new Set([JOB_KINDS.stems, JOB_KINDS.lyrics, JOB_KINDS.realign])
  const active = (j: JobSnapshot) => j.status === 'running' || j.status === 'queued'
  const visionJobs = (list = jobs.list()) =>
    list.filter((j) => (j.kind.startsWith('vision.') || matching.has(j.kind)) && active(j))
  let wanted = false
  /** The vision jobs running when another project opened, while its release waits for them. */
  let leaving: ReadonlySet<string> | null = null
  let roomFor = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Any vision job clears the timer. A search uses a worker without a job, so a worker it used lately is kept for
  // another while.
  const idle = () => {
    if (!release({ idleMs: VISION_IDLE_MS })) {
      timer = setTimeout(idle, VISION_IDLE_MS)
      return
    }
    timer = undefined
    // A release a search held off is done now, so it can't end a worker a later search starts.
    wanted = false
    leaving = null
  }
  const update = () => {
    const list = jobs.list()
    const now = new Set(list.filter((j) => needRoom.has(j.kind) && active(j)).map((j) => j.id))
    if ([...now].some((id) => !roomFor.has(id))) wanted = true
    roomFor = now
    const running = visionJobs(list)
    const left = leaving
    if (left && running.some((j) => !left.has(j.id))) leaving = null
    if (running.length) {
      clearTimeout(timer)
      timer = undefined
      return
    }
    // A search may have a call pending: the release is then tried again on the next change.
    if ((wanted || leaving) && release()) {
      wanted = false
      leaving = null
    }
    timer ??= setTimeout(idle, VISION_IDLE_MS)
  }
  releaseVisionSoon = () => {
    leaving = new Set(visionJobs().map((j) => j.id))
    update()
  }
  jobs.subscribe(update)
  update()
}

/** Frees the vision workers' memory once the open project's vision jobs have stopped, for another project opening. */
export function releaseVisionWorkers(): void {
  releaseVisionSoon()
}

/**
 * A vision job's `run` that shows the first-time downloads of `models` as its progress line ("Downloading the depth
 * estimator (27 MB, once)") while they last.
 */
export function showingDownloads<T>(
  models: readonly VisionModel[],
  run: (ctx: JobContext) => Promise<T>,
): (ctx: JobContext) => Promise<T> {
  return async (ctx) => {
    const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
    return v.withDownloadLines(vision, models, run)(ctx)
  }
}

/** The longest one hold keeps footage analysis waiting by default. */
const ANALYSIS_HOLD_MS = 5000
const analysisHolds = new Set<Promise<void>>()

/**
 * Makes background footage analysis and the person check (`checkFootage`) wait between frames until `done` settles
 * (resolved or rejected), `maxMs` at most. They decode the same files as the preview and run their models on every
 * core, so a frame the preview is waiting for, such as a draft's first, comes seconds later while they run. Browsers
 * give workers no priorities, so they yield.
 * Analysis waits while any hold lasts, so every hold must end on its own: callers must not hold again and again for
 * a wait that never ends.
 */
export function holdAnalysisUntil(done: Promise<unknown>, maxMs = ANALYSIS_HOLD_MS): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const hold: Promise<void> = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxMs)
    void done.then(
      () => resolve(),
      () => resolve(),
    )
  }).then(() => {
    clearTimeout(timer)
    analysisHolds.delete(hold)
  })
  analysisHolds.add(hold)
}

/**
 * Holds footage analysis while `pending()` is true, `maxMs` at most each time it turns true. After that it holds again
 * only once `pending()` has been false: a seek that never ends (and is sent again) must not stop analysis. Returns stop.
 * The cap also bounds a drag, whose pending stays true while its steps overlap, only because pending never turns false
 * and true again within one task: analysis takes its next frame in a later microtask, so such a flip would start a new
 * hold with no frame in between.
 */
export function holdAnalysisWhile(
  pending: () => boolean,
  subscribe: (listener: () => void) => () => void,
  maxMs = ANALYSIS_HOLD_MS,
): () => void {
  // Set from the moment pending() turns true until it turns false, also once the hold's time is up.
  let release: (() => void) | undefined
  const end = () => {
    release?.()
    release = undefined
  }
  const update = () => {
    if (!pending()) end()
    else if (!release) holdAnalysisUntil(new Promise<void>((resolve) => (release = resolve)), maxMs)
  }
  const unsubscribe = subscribe(update)
  update()
  return () => {
    unsubscribe()
    end()
  }
}

/**
 * Resolves once no hold is left, holds made while it waits included, so one hold can hand over to the next (a draft's
 * planning to its first frame) without a frame decoded in between.
 */
export async function analysisReady(): Promise<void> {
  while (analysisHolds.size) await Promise.all(analysisHolds)
}

export function footageService(): Promise<FootageService> {
  loading ??= Promise.all([import('../../vision/index.ts'), visionService()]).then(([v, vision]) => {
    // The sample's clips are drawn, never blank: checking them would only hold up the first draft people try.
    const service = v.createFootageService({
      editor,
      vision,
      media: appMedia,
      showsSomething: isSampleAsset,
      ready: analysisReady,
      canTrackSubjects: webgl2Available,
    })
    service.indexing.subscribe((indexing) => useFootage.setState({ indexing }))
    useFootage.setState({ service, indexing: service.indexing.getState(), strongMatch: v.STRONG_MATCH })
    return service
  })
  return loading
}

/**
 * What footage analysis says while it downloads a model, in place of how many clips are done: "Downloading the
 * footage tagger (154 MB, once)… 40%. Your clips are analyzed next."
 */
export function footageDownloadNote(indexing: IndexingState | null): string | undefined {
  const download = indexing?.status === 'indexing' ? indexing.download : undefined
  if (!download) return undefined
  const next = indexing?.done ? 'The rest of your clips are analyzed next.' : 'Your clips are analyzed next.'
  return `${download.message}… ${Math.round(download.fraction * 100)}%. ${next}`
}

/**
 * Whether analysis that downloads models may run without being asked for (footage indexing, beat refinement). Off in
 * automated browsers (end-to-end tests, the live smoke test) unless a test opts in.
 */
export function backgroundAnalysisOn(): boolean {
  try {
    const setting = localStorage.getItem(SETTING_KEY)
    if (setting === 'on') return true
    if (setting === 'off') return false
  } catch {
    // Storage blocked: fall through to the default.
  }
  return !navigator.webdriver
}

let started = false

/**
 * Whether footage analysis reaches the project's clips without another click: background analysis is on (it may not
 * have started yet), or the user started it once (it then watches for new clips too).
 */
export function footageAnalysisRuns(): boolean {
  return started || backgroundAnalysisOn()
}

/** Analyzes the project's clips and stills in the background, and every clip imported later. */
export function startFootageAnalysis(): void {
  if (started || !backgroundAnalysisOn()) return
  started = true
  void footageService().then((service) => service.indexing.start())
}

/**
 * Analyzes footage now because the user asked for something that needs it (auto-cut's matching), also where
 * background analysis is off. Picks up a run the user cancelled or one that failed.
 */
export function analyzeFootageNow(): void {
  started = true
  void footageService().then((service) => {
    service.indexing.start()
    service.indexing.resume()
  })
}

/**
 * Waits for the fast blank check of these clips and stills (default: all) that footage analysis hasn't looked at yet,
 * so a draft or a cut can leave out the ones that show nothing before analysis reaches them. It downloads no model,
 * so it also runs where background analysis is off. Resolves with the ones it didn't check in time
 * (`FootageService.checkBlank`). Undefined when every one of them has been looked at.
 */
export function checkClipsForBlank(
  options: { assetIds?: readonly Id[]; signal?: AbortSignal; progress?: (fraction: number) => void } = {},
): Promise<Id[]> | undefined {
  const { assetIds, ...rest } = options
  if (!hasUncheckedMedia(editor.getProject(), assetIds, isSampleAsset)) return undefined
  return footageService().then((service) => service.checkBlank(assetIds, rest))
}

const hasOwnFootage = (project: Project) =>
  Object.values(project.assets).some(
    (a) => a.origin.type === 'import' && (a.kind === 'video' || a.kind === 'image') && !isSampleAsset(a),
  )

/**
 * Starts background analysis as soon as the project has clips the user imported. Other projects (the sample,
 * generated clips only) start it on first use instead: search, suggestions or export framing. So looking around the
 * sample downloads no models. Returns stop watching.
 */
export function analyzeImportsInBackground(): () => void {
  const check = () => {
    if (!started && hasOwnFootage(editor.getProject())) startFootageAnalysis()
  }
  check()
  return editor.subscribe(check)
}

/**
 * Whether footage analysis is running and has not made this clip searchable yet, so search and suggestions leave it
 * out for now: 'analyzing' for the clip being analyzed, 'waiting' for the ones after it, else null.
 */
export function useClipAnalyzing(assetId: Id): 'analyzing' | 'waiting' | null {
  return useFootage((s) => {
    if (s.indexing?.status !== 'indexing' || !s.service) return null
    const status = s.service.indexing.statusOf(assetId)
    return status === 'indexing' ? 'analyzing' : status === 'queued' ? 'waiting' : null
  })
}

export type FootageQuery = 'search' | 'line' | 'section'

/**
 * Footage results for a search, a lyric line or a song section (null while loading or without the service). Asking
 * starts background analysis; the query runs again as more clips finish.
 */
export function useFootageResults(type: FootageQuery, value: string | Id | null): FootageResult[] | null {
  const service = useFootage((s) => s.service)
  const progress = useFootage((s) => `${s.indexing?.status}:${s.indexing?.done}:${s.indexing?.total}`)
  const key = value ? `${type}:${value}` : null
  const [state, setState] = useState<{ key: string; results: FootageResult[] } | null>(null)
  useEffect(() => {
    if (value) startFootageAnalysis()
  }, [value])
  useEffect(() => {
    if (!service || !value || !key) return
    const controller = new AbortController()
    const signal = controller.signal
    const timer = setTimeout(() => {
      const run =
        type === 'search'
          ? service.search(value, { signal })
          : type === 'line'
            ? service.suggestForLine(value, { signal })
            : service.suggestForSection(value, { signal })
      run.then(
        (results) => {
          if (!signal.aborted) setState({ key, results })
        },
        () => undefined,
      )
    }, 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [service, type, value, key, progress])
  return state && state.key === key ? state.results : null
}

const MAX_TAGS = 5

/**
 * Up to five words describing a clip ("crowd", "lights", "energetic"), from footage analysis (stored as `VisualAnalysis.data.tags`, see `readClipTags`). The
 * sample project's clips use their own descriptions until they are analyzed; other clips have none before.
 */
export function clipTags(project: Project, assetId: Id): string[] {
  const analyzed = readClipTags(project.analysis.visual[assetId])
  const asset = project.assets[assetId]
  const tags = analyzed ?? (asset && isSampleAsset(asset) ? (mediaById[assetId]?.tags ?? []) : [])
  return tags.slice(0, MAX_TAGS)
}

/** Stops footage analysis; the clips left wait until it is asked for again or a clip is imported. */
export function cancelFootageAnalysis(): void {
  useFootage.getState().service?.indexing.cancel()
}

/** Analyzes footage again after a failed run, including the clips that failed. */
export function retryFootageAnalysis(): void {
  started = true
  void footageService().then((service) => {
    service.indexing.start()
    service.indexing.resume({ retryFailed: true })
  })
}

/**
 * Analyzes clips now (as `analyzeFootageNow`) and resolves once each of `assetIds` is matched or failed, or analysis
 * stops (a Cancel elsewhere, an error). Aborting `signal` rejects with a cancelled JobError and also cancels the
 * analysis when this call started it.
 */
export async function analyzeFootageAndWait(
  assetIds: readonly Id[],
  options: { signal?: AbortSignal; onProgress?: (state: IndexingState) => void } = {},
): Promise<void> {
  const service = await footageService()
  if (options.signal?.aborted) throw new JobError('cancelled', 'Cancelled')
  const startedHere = service.indexing.getState().status !== 'indexing'
  started = true
  service.indexing.start()
  service.indexing.resume()
  return waitForMatching(service.indexing, assetIds, { ...options, cancelOnAbort: startedHere })
}

const SETTLED: readonly AssetIndexStatus[] = ['indexed', 'failed', 'unsupported']

/**
 * Resolves on the indexer's next update that finds every one of `assetIds` matched or failed, or nothing running. Call
 * it right after asking the indexer to run (`start`, `resume`): it ignores the state from before that request.
 */
export function waitForMatching(
  indexing: Pick<FootageIndexer, 'subscribe' | 'statusOf' | 'cancel'>,
  assetIds: readonly Id[],
  options: {
    signal?: AbortSignal
    onProgress?: (state: IndexingState) => void
    cancelOnAbort?: boolean
  } = {},
): Promise<void> {
  const { signal, onProgress, cancelOnAbort = false } = options
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      stop()
      if (cancelOnAbort) indexing.cancel()
      reject(new JobError('cancelled', 'Cancelled'))
    }
    const unsubscribe = indexing.subscribe((state) => {
      onProgress?.(state)
      if (state.status !== 'indexing' || assetIds.every((id) => SETTLED.includes(indexing.statusOf(id)))) {
        stop()
        resolve()
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
/**
 * Asks Library › Media to bring its "Suggested for …" row into view the next time it shows (from the "N clips
 * match" chips, whose matches load again in the library).
 */
export function revealSuggestions(): void {
  useFootage.setState({ revealSuggestions: true })
}

/** Ref for the suggestion row: scrolls it into view once after `revealSuggestions()`. */
export function suggestionRowRef(el: HTMLElement | null): void {
  if (!el || !useFootage.getState().revealSuggestions) return
  useFootage.setState({ revealSuggestions: false })
  el.scrollIntoView({ block: 'nearest' })
}
