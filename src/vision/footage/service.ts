/**
 * Footage matching for the app: search the library by description, suggestions for a lyric line or a song section,
 * and background analysis of every clip and still as it is imported (one cancellable job, cached per clip): the
 * matching index, then where the people are for auto-reframe. Results are written to the project's visual analysis
 * without an undo step, so the director, auto-cut and export read them too, and Ctrl+Z never undoes an analysis the
 * user did not ask for.
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
import {
  buildVisualAnalysis,
  readClipIndex,
  readClipTags,
  readSubjectTrack,
  withClipTags,
  type VisualAnalysisParts,
} from '../analysisData.ts'
import { visionError } from '../errors.ts'
import { withDownloadLines } from '../runtime/downloads.ts'
import { createAssetFrameSource } from '../runtime/assetSource.ts'
import type { FrameSource } from '../runtime/frames.ts'
import { describeClips, tagWords } from '../matching/tags.ts'
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
/** Where a clip stands for subject-aware framing. `no-subject`: analyzed, and no face or person was found. */
export type SubjectStatus =
  'analyzed' | 'no-subject' | 'analyzing' | 'queued' | 'paused' | 'failed' | 'unsupported'
/** The analyses of a clip, in the order they run. `tags` describes the clip from its matching index. */
export type IndexStep = 'matching' | 'tags' | 'subjects'

export interface IndexingState {
  /** `paused` after Cancel; `error` when the run stopped (model download failed, ...). */
  status: 'idle' | 'indexing' | 'paused' | 'error'
  /** Clips in the current run (done plus still to do) and how many are done. */
  total: number
  done: number
  /** The clip being analyzed; `fraction` covers all of its steps. */
  current?: { assetId: Id; name: string; fraction: number; step: IndexStep }
  failed: { assetId: Id; name: string; message: string }[]
  error?: { code: JobErrorCode; message: string }
}

export interface FootageIndexer {
  /** Watches the project and analyzes new clips and stills in the background. Returns stop. */
  start(): () => void
  getState(): IndexingState
  subscribe(listener: (state: IndexingState) => void): () => void
  /** Matching (search, suggestions, auto-cut). */
  statusOf(assetId: Id): AssetIndexStatus
  /** Subject tracking (auto-reframe in multi-format export). */
  subjectStatusOf(assetId: Id): SubjectStatus
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
  vision: Pick<VisionService, 'indexClip' | 'matcher' | 'subjects'> &
    Partial<Pick<VisionService, 'watchDownloads'>>
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

  const failedMatching = new Map<Id, string>()
  const failedSubjects = new Map<Id, string>()
  const failedTags = new Set<Id>()
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

  const stepsFor = (project: Project, asset: Asset): IndexStep[] => {
    if (!analyzable(asset)) return []
    const steps: IndexStep[] = []
    const indexed = !!indexOf(project, asset.id)
    if (!failedMatching.has(asset.id) && !indexed) steps.push('matching')
    if (
      (indexed || steps.includes('matching')) &&
      !failedTags.has(asset.id) &&
      !readClipTags(project.analysis.visual[asset.id])
    )
      steps.push('tags')
    if (!failedSubjects.has(asset.id) && !readSubjectTrack(project.analysis.visual[asset.id]))
      steps.push('subjects')
    return steps
  }

  const pending = (project: Project) =>
    Object.values(project.assets)
      .filter((a) => stepsFor(project, a).length > 0)
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
      failed: [...new Set([...failedMatching.keys(), ...failedSubjects.keys()])].flatMap((assetId) =>
        assets[assetId]
          ? [
              {
                assetId,
                name: assets[assetId].name,
                message: (failedMatching.get(assetId) ?? failedSubjects.get(assetId)) as string,
              },
            ]
          : [],
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
      run: withDownloadLines(vision, ['tagger', 'cutout'], async (ctx) => {
        const report = () => {
          const fraction = total ? (done + (current?.fraction ?? 0)) / total : 0
          ctx.progress({
            fraction: clamp(fraction, 0, 1),
            stage: current?.step === 'subjects' ? 'subjects' : 'indexing',
            ...(current ? { message: `Clip ${done + 1} of ${total} · ${current.name}` } : {}),
          })
        }
        /** Records a clip's failed steps; errors that would hit every clip stop the run instead. */
        const fail = (asset: Asset, err: unknown, steps: readonly IndexStep[]) => {
          const e = visionError(err)
          if (e.code === 'cancelled' || ctx.signal.aborted || RUN_LEVEL.includes(e.code)) throw e
          for (const step of steps) {
            if (step === 'tags') failedTags.add(asset.id)
            else (step === 'matching' ? failedMatching : failedSubjects).set(asset.id, e.message)
          }
        }
        const write = (
          asset: Asset,
          src: FrameSource,
          parts: Omit<VisualAnalysisParts, 'assetId' | 'sourceSize'>,
        ) => {
          const project = editor.getProject()
          if (!project.assets[asset.id]) return
          const analysis = buildVisualAnalysis(
            { assetId: asset.id, sourceSize: { width: src.width, height: src.height }, ...parts },
            project.analysis.visual[asset.id],
          )
          editor.dispatch({ type: 'analysis.setVisual', analysis }, { history: 'skip' })
        }
        const runStep = async (
          asset: Asset,
          src: FrameSource | undefined,
          step: IndexStep,
          k: number,
          of: number,
        ) => {
          if (current) Object.assign(current, { step, fraction: k / of })
          const task = {
            signal: ctx.signal,
            onProgress: (p: { fraction?: number }) => {
              if (current) current.fraction = (k + clamp(p.fraction ?? 0, 0, 1)) / of
              report()
              emit()
            },
          }
          try {
            if (step === 'tags') {
              const project = editor.getProject()
              const index = indexOf(project, asset.id)
              const analysis = project.analysis.visual[asset.id]
              if (!index || !analysis || asset.kind === 'audio' || asset.kind === 'font') return
              const [description] = await describeClips([index], vision.matcher, ctx.signal)
              ctx.throwIfCancelled()
              const tags = tagWords(description!, asset.kind === 'image' ? 'image' : 'video')
              const latest = editor.getProject().analysis.visual[asset.id]
              if (latest && editor.getProject().assets[asset.id])
                editor.dispatch(
                  { type: 'analysis.setVisual', analysis: withClipTags(latest, tags) },
                  { history: 'skip' },
                )
            } else if (!src) {
              return
            } else if (step === 'matching') {
              const index = await vision.indexClip(src, task)
              write(asset, src, { duration: index.duration, index })
            } else {
              // A still is the same picture at every time, so one sample is enough.
              const subjects = await vision.subjects(src, asset.kind === 'image' ? { ...task, fps: 1 } : task)
              write(asset, src, { duration: src.duration, subjects })
            }
          } catch (err) {
            fail(asset, err, [step])
          }
        }
        for (;;) {
          ctx.throwIfCancelled()
          const todo = pending(editor.getProject())
          const asset = todo[0]
          if (!asset) break
          total = done + todo.length
          const steps = stepsFor(editor.getProject(), asset)
          current = { assetId: asset.id, name: asset.name, fraction: 0, step: steps[0] as IndexStep }
          report()
          emit()
          let src: (FrameSource & { dispose?(): void }) | undefined
          let opened = true
          // Tags come from the stored index, so a clip that only needs them is not decoded.
          if (steps.some((s) => s !== 'tags')) {
            try {
              src = await frameSource(asset)
            } catch (err) {
              opened = false
              fail(asset, err, steps)
            }
          }
          try {
            for (const [k, step] of opened ? steps.entries() : [])
              await runStep(asset, src, step, k, steps.length)
          } finally {
            src?.dispose?.()
          }
          done++
          current = undefined
          report()
        }
      }),
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
          failedMatching.clear()
          failedSubjects.clear()
          failedTags.clear()
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
      if (indexOf(project, assetId)) return 'indexed'
      if (current?.assetId === assetId && running) return 'indexing'
      if (failedMatching.has(assetId)) return 'failed'
      return paused || error ? 'paused' : 'queued'
    },
    subjectStatusOf(assetId) {
      const project = editor.getProject()
      const asset = project.assets[assetId]
      if (!asset || !analyzable(asset)) return 'unsupported'
      const track = readSubjectTrack(project.analysis.visual[assetId])
      if (track) return track.samples.some((s) => s.source !== 'none') ? 'analyzed' : 'no-subject'
      if (current?.assetId === assetId && running) return 'analyzing'
      if (failedSubjects.has(assetId)) return 'failed'
      return paused || error ? 'paused' : 'queued'
    },
    cancel() {
      running?.handle.cancel()
    },
    resume(options = {}) {
      paused = false
      error = undefined
      if (options.retryFailed) {
        failedMatching.clear()
        failedSubjects.clear()
        failedTags.clear()
      }
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
