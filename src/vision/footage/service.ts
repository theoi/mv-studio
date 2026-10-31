/**
 * Footage matching for the app: search the library by description, suggestions for a lyric line or a song section,
 * and background analysis of every clip and still as it is imported (one cancellable job, cached per clip).
 * Results are written to the project's visual analysis without an undo step, so the director and auto-cut read
 * them too, and Ctrl+Z never undoes an analysis the user did not ask for.
 */
import { songInfoFromProject } from '../../director/inputs.ts'
import type { MediaFileSource } from '../../engine/types.ts'
import type { ProjectEditor } from '../../model/editor.ts'
import type { Asset, Id, Project } from '../../model/types.ts'
import {
  jobs as sharedJobs,
  JobError,
  type JobErrorCode,
  type JobHandle,
  type JobRunner,
} from '../../shared/jobs.ts'
import { buildVisualAnalysis, readClipIndex } from '../analysisData.ts'
import { visionError } from '../errors.ts'
import { createAssetFrameSource } from '../runtime/assetSource.ts'
import type { FrameSource } from '../runtime/frames.ts'
import { createImageFrameSource } from '../runtime/imageSource.ts'
import type { VisionService } from '../service.ts'
import type { ClipVisionIndex, MatchQuery, TimeRange } from '../types.ts'
import { lineSpan, songEnergyScale } from './song.ts'

export const FOOTAGE_INDEX_JOB = 'vision.index'
/** Score from which a result counts as a match worth suggesting ("3 clips match"). */
export const STRONG_MATCH = 0.7
const DEFAULT_LIMIT = 12
/** Failures that would hit every clip the same way, so the run stops instead of failing clip by clip. */
const RUN_LEVEL: readonly JobErrorCode[] = [
  'model-load',
  'network',
  'out-of-memory',
  'unsupported',
  'storage-quota',
]

export interface FootageResult {
  assetId: Id
  name: string
  kind: 'video' | 'image'
  /** 0..1, comparable within one call; `STRONG_MATCH` and above is a good match. */
  score: number
  /** Best-matching part of the clip (source seconds). */
  range: TimeRange
}

export interface FootageQueryOptions {
  /** Only these clips (default: the whole library). */
  assetIds?: Id[]
  limit?: number
  signal?: AbortSignal
}

export type AssetIndexStatus = 'indexed' | 'queued' | 'indexing' | 'paused' | 'failed' | 'unsupported'

export interface IndexingState {
  /** `paused` after Cancel; `error` when the run stopped (model download failed, ...). */
  status: 'idle' | 'indexing' | 'paused' | 'error'
  /** Clips in the current run (done plus still to do) and how many are done. */
  total: number
  done: number
  current?: { assetId: Id; name: string; fraction: number }
  failed: { assetId: Id; name: string; message: string }[]
  error?: { code: JobErrorCode; message: string }
}

export interface FootageIndexer {
  /** Watches the project and analyzes new clips and stills in the background. Returns stop. */
  start(): () => void
  getState(): IndexingState
  subscribe(listener: (state: IndexingState) => void): () => void
  statusOf(assetId: Id): AssetIndexStatus
  /** Stops the run; nothing more is analyzed until `resume()` or the next import. */
  cancel(): void
  resume(options?: { retryFailed?: boolean }): void
}

export interface FootageService {
  search(text: string, options?: FootageQueryOptions): Promise<FootageResult[]>
  suggestForLine(lineId: Id, options?: FootageQueryOptions): Promise<FootageResult[]>
  suggestForSection(sectionId: Id, options?: FootageQueryOptions): Promise<FootageResult[]>
  readonly indexing: FootageIndexer
}

export interface FootageServiceDeps {
  editor: Pick<ProjectEditor, 'getProject' | 'dispatch' | 'subscribe'>
  vision: Pick<VisionService, 'indexClip' | 'matcher'>
  media: MediaFileSource
  jobs?: Pick<JobRunner, 'run'>
  /** Frames to analyze for an asset (default: the export decoder for clips, the image itself for stills). */
  frameSource?: (asset: Asset) => Promise<FrameSource & { dispose?(): void }>
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Imported or generated clips and stills that are ready to analyze. */
function analyzable(asset: Asset): asset is Asset & { kind: 'video' | 'image' } {
  if (asset.origin.type !== 'import' && asset.origin.type !== 'generated') return false
  if (asset.kind === 'video') return !!(asset.duration && asset.width && asset.height)
  return asset.kind === 'image'
}

export function createFootageService(deps: FootageServiceDeps): FootageService {
  const { editor, vision } = deps
  const runner = deps.jobs ?? sharedJobs
  const frameSource =
    deps.frameSource ??
    (async (asset: Asset) =>
      asset.kind === 'image'
        ? createImageFrameSource(asset, deps.media)
        : createAssetFrameSource(asset, deps.media))

  const indexOf = (project: Project, id: Id): ClipVisionIndex | null => {
    const index = readClipIndex(project.analysis.visual[id])
    return index && index.model === vision.matcher.model ? index : null
  }

  // ---------------------------------------------------------------------------------------------------------
  // Background analysis

  const failed = new Map<Id, string>()
  const listeners = new Set<(state: IndexingState) => void>()
  let watching = false
  let paused = false
  let error: IndexingState['error']
  let running: { handle: JobHandle<void>; token: object } | null = null
  let current: IndexingState['current']
  let total = 0
  let done = 0
  let scheduled = false
  let state: IndexingState = { status: 'idle', total: 0, done: 0, failed: [] }

  const pending = (project: Project) =>
    Object.values(project.assets)
      .filter((a) => analyzable(a) && !failed.has(a.id) && !indexOf(project, a.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  const emit = () => {
    const assets = editor.getProject().assets
    state = {
      status: running
        ? 'indexing'
        : error
          ? 'error'
          : paused && pending(editor.getProject()).length
            ? 'paused'
            : 'idle',
      total: running ? total : 0,
      done: running ? done : 0,
      ...(running && current ? { current: { ...current } } : {}),
      failed: [...failed].flatMap(([assetId, message]) =>
        assets[assetId] ? [{ assetId, name: assets[assetId].name, message }] : [],
      ),
      ...(error ? { error } : {}),
    }
    for (const l of listeners) l(state)
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      pump()
    })
  }

  const pump = () => {
    if (!watching || running || paused) return emit()
    if (!pending(editor.getProject()).length) return emit()
    const token = {}
    total = 0
    done = 0
    const handle = runner.run<void>({
      kind: FOOTAGE_INDEX_JOB,
      title: 'Analyzing footage',
      run: async (ctx) => {
        const report = () => {
          const fraction = total ? (done + (current?.fraction ?? 0)) / total : 0
          ctx.progress({
            fraction: clamp(fraction, 0, 1),
            stage: 'indexing',
            ...(current ? { message: `Clip ${done + 1} of ${total} · ${current.name}` } : {}),
          })
        }
        for (;;) {
          ctx.throwIfCancelled()
          const todo = pending(editor.getProject())
          const asset = todo[0]
          if (!asset) break
          total = done + todo.length
          current = { assetId: asset.id, name: asset.name, fraction: 0 }
          report()
          emit()
          let source: (FrameSource & { dispose?(): void }) | undefined
          try {
            source = await frameSource(asset)
            const index = await vision.indexClip(source, {
              signal: ctx.signal,
              onProgress: (p) => {
                if (current) current.fraction = clamp(p.fraction ?? 0, 0, 1)
                report()
                emit()
              },
            })
            const project = editor.getProject()
            if (project.assets[asset.id]) {
              editor.dispatch(
                {
                  type: 'analysis.setVisual',
                  analysis: buildVisualAnalysis(
                    {
                      assetId: asset.id,
                      duration: index.duration,
                      sourceSize: { width: source.width, height: source.height },
                      index,
                    },
                    project.analysis.visual[asset.id],
                  ),
                },
                { history: 'skip' },
              )
            }
          } catch (err) {
            const e = visionError(err)
            if (e.code === 'cancelled' || ctx.signal.aborted || RUN_LEVEL.includes(e.code)) throw e
            failed.set(asset.id, e.message)
          } finally {
            source?.dispose?.()
          }
          done++
          current = undefined
          report()
        }
      },
    })
    running = { handle, token }
    emit()
    const finish = (outcome: 'done' | JobError) => {
      if (running?.token !== token) return
      running = null
      current = undefined
      if (outcome !== 'done') {
        paused = true
        if (outcome.code !== 'cancelled') error = { code: outcome.code, message: outcome.message }
      }
      if (outcome === 'done') schedule()
      emit()
    }
    handle.promise.then(
      () => finish('done'),
      (err: unknown) => finish(err instanceof JobError ? err : JobError.from(err)),
    )
  }

  const indexing: FootageIndexer = {
    start() {
      if (watching) return () => undefined
      watching = true
      const unsubscribe = editor.subscribe((_project, change) => {
        if (change.source === 'derived') return
        if (change.source === 'load') {
          if (running) {
            const old = running
            running = null
            current = undefined
            old.handle.cancel()
          }
          failed.clear()
          paused = false
          error = undefined
        } else if (change.commands.some((c) => c.type === 'asset.add')) {
          // A new import is a fresh request to analyze, even after a Cancel or a failed run.
          paused = false
          error = undefined
        }
        schedule()
      })
      schedule()
      return () => {
        watching = false
        unsubscribe()
        running?.handle.cancel()
      }
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    statusOf(assetId) {
      const project = editor.getProject()
      const asset = project.assets[assetId]
      if (!asset || !analyzable(asset)) return 'unsupported'
      if (current?.assetId === assetId && running) return 'indexing'
      if (indexOf(project, assetId)) return 'indexed'
      if (failed.has(assetId)) return 'failed'
      return paused || error ? 'paused' : 'queued'
    },
    cancel() {
      running?.handle.cancel()
    },
    resume(options = {}) {
      paused = false
      error = undefined
      if (options.retryFailed) failed.clear()
      schedule()
    },
  }

  // ---------------------------------------------------------------------------------------------------------
  // Search and suggestions

  const rank = async (query: MatchQuery, options: FootageQueryOptions): Promise<FootageResult[]> => {
    const project = editor.getProject()
    const wanted = options.assetIds ? new Set(options.assetIds) : undefined
    const library = Object.values(project.assets).flatMap((a) => {
      if (!analyzable(a) || (wanted && !wanted.has(a.id))) return []
      const index = indexOf(project, a.id)
      return index ? [index] : []
    })
    if (!library.length) return []
    const matches = await vision.matcher.rank(library, query, {
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return matches.slice(0, Math.max(0, options.limit ?? DEFAULT_LIMIT)).flatMap((m) => {
      const asset = project.assets[m.mediaId]
      if (!asset || (asset.kind !== 'video' && asset.kind !== 'image')) return []
      return [
        {
          assetId: asset.id,
          name: asset.name,
          kind: asset.kind,
          score: Math.round(sigmoid(m.score) * 1000) / 1000,
          range: m.bestRange,
        },
      ]
    })
  }

  return {
    indexing,
    async search(text, options = {}) {
      const q = text.trim()
      return q ? rank({ text: q }, options) : []
    },
    async suggestForLine(lineId, options = {}) {
      const project = editor.getProject()
      const line = project.lyrics?.lines.find((l) => l.id === lineId)
      if (!line?.text.trim()) return []
      const span = lineSpan(line)
      const energy = span ? songEnergyScale(project)?.(span.start, span.end) : undefined
      return rank(
        {
          text: line.text.trim(),
          ...(energy !== undefined ? { energy } : {}),
          ...(span ? { duration: clamp(span.end - span.start, 1, 8) } : {}),
        },
        options,
      )
    },
    async suggestForSection(sectionId, options = {}) {
      const project = editor.getProject()
      const section = songInfoFromProject(project).sections.find((s) => s.id === sectionId)
      if (!section) return []
      const text = (project.lyrics?.lines ?? [])
        .filter((l) => {
          const span = lineSpan(l)
          return span && span.start >= section.start - 0.05 && span.start < section.end
        })
        .slice(0, 2)
        .map((l) => l.text.trim())
        .filter(Boolean)
        .join('. ')
      const mood = section.energy >= 0.7 ? 'energetic' : section.energy < 0.35 ? 'calm' : undefined
      return rank(
        {
          ...(text ? { text } : {}),
          ...(mood ? { mood } : {}),
          energy: section.energy,
          duration: clamp(section.end - section.start, 1, 8),
        },
        options,
      )
    },
  }
}
