import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Id, Project } from '../../model/index.ts'
import type {
  FootageResult,
  FootageService,
  IndexingState,
  VisionServiceOptions,
} from '../../vision/index.ts'
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
}

export const useFootage = create<FootageState>(() => ({ service: null, indexing: null, strongMatch: 1 }))

let loading: Promise<FootageService> | null = null
let testBackends: VisionServiceOptions['backends'] | undefined

/** For end-to-end tests: analyze with model-free backends instead of downloading models. */
export function setVisionBackendsForTests(backends: VisionServiceOptions['backends']): void {
  testBackends = backends
}

export function footageService(): Promise<FootageService> {
  loading ??= import('../../vision/index.ts').then((v) => {
    const vision = v.createVisionService({
      backends: testBackends ?? v.createWorkerBackends(),
      cache: testBackends ? v.createMemoryCache() : v.createOpfsCache(),
    })
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
