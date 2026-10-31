import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Id, Project } from '../../model/index.ts'
import type {
  DirectorFootageMatcher,
  FootageMatcher,
  FootageResult,
  FootageService,
  IndexingState,
  VisionService,
  VisionServiceOptions,
} from '../../vision/index.ts'
import { readClipTags } from '../../vision/analysisData.ts'
import { mediaById } from '../mock/media.ts'
import { isSampleAsset } from '../mock/sampleMedia.ts'
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
    const vision = v.createVisionService({
      backends: testBackends ?? v.createWorkerBackends(),
      cache: testBackends ? v.createMemoryCache() : v.createOpfsCache(),
    })
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

export function footageService(): Promise<FootageService> {
  loading ??= Promise.all([import('../../vision/index.ts'), visionService()]).then(([v, vision]) => {
    const service = v.createFootageService({ editor, vision, media: appMedia })
    service.indexing.subscribe((indexing) => useFootage.setState({ indexing }))
    useFootage.setState({ service, indexing: service.indexing.getState(), strongMatch: v.STRONG_MATCH })
    return service
  })
  return loading
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
 * out for now.
 */
export function useClipAnalyzing(assetId: Id): boolean {
  return useFootage((s) => {
    if (s.indexing?.status !== 'indexing' || !s.service) return false
    const status = s.service.indexing.statusOf(assetId)
    return status === 'queued' || status === 'indexing'
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

/** Analyzes footage again after a failed run, including the clips that failed. */
export function retryFootageAnalysis(): void {
  started = true
  void footageService().then((service) => {
    service.indexing.start()
    service.indexing.resume({ retryFailed: true })
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
