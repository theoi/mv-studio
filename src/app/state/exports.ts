import { exportProject, exportSize, type ExportResolution } from '../../engine/export.ts'
import { ASPECT_PRESETS, projectDuration, type AspectPreset, type Project } from '../../model/index.ts'
import { JobError, jobs, type JobContext } from '../../shared/jobs.ts'
import { JOB_KINDS } from './jobs.ts'
import { appMedia } from './media.ts'
import { editor, sectionKind, sectionsOf } from './project.ts'
import { toast } from './ui.ts'

export type ExportKind = 'full' | 'format' | 'teaser' | 'loop'

export interface ExportRequest {
  /** Output name shown in the dialog; jobs are titled "Exporting <name>". */
  name: string
  fileName: string
  kind: ExportKind
  aspect: AspectPreset
  resolution: ExportResolution
  fps: number
}

/** Seconds each short output covers, starting at the first chorus. */
export const SHORT_LENGTH: Partial<Record<ExportKind, number>> = { teaser: 15, loop: 8 }

export function exportTitle(name: string): string {
  return `Exporting ${name}`
}

function outputProject(base: Project, request: ExportRequest): Project {
  const { width, height } = ASPECT_PRESETS[request.aspect]
  return { ...base, settings: { ...base.settings, aspect: request.aspect, width, height, fps: request.fps } }
}

function outputRange(project: Project, kind: ExportKind): { start: number; end: number } | undefined {
  const length = SHORT_LENGTH[kind]
  if (!length) return undefined
  const duration = projectDuration(project)
  const chorus = sectionsOf(project).find((s) => sectionKind(s) === 'chorus')
  const start = Math.max(0, Math.min(chorus?.start ?? 0, duration - length))
  return { start, end: Math.min(duration, start + length) }
}

const files = new Map<string, File>()

export function downloadFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  // The download holds its own reference once it starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Downloads a finished export again (its file stays in browser storage until the next exports replace it). */
export function downloadAgain(name: string): void {
  const file = files.get(name)
  if (file) downloadFile(file, file.name)
  else toast('That file is no longer available. Export it again.')
}

function waitTurn(previous: Promise<unknown>, ctx: JobContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new JobError('cancelled', 'Export cancelled'))
    if (ctx.signal.aborted) return abort()
    ctx.signal.addEventListener('abort', abort, { once: true })
    void previous.then(() => {
      ctx.signal.removeEventListener('abort', abort)
      resolve()
    })
  })
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Starts one export job per output. Jobs run one at a time in order (each waits for the previous one), render with
 * the real engine from the current project, and download the MP4 when done.
 */
export function startExports(requests: ExportRequest[]): void {
  const busy = new Set(
    jobs
      .list()
      .filter((j) => j.kind === JOB_KINDS.export && (j.status === 'running' || j.status === 'queued'))
      .map((j) => j.title),
  )
  const project = editor.getProject()
  for (const request of requests) {
    const title = exportTitle(request.name)
    if (busy.has(title)) continue
    const previous = queue
    const handle = jobs.run({
      kind: JOB_KINDS.export,
      title,
      run: async (ctx) => {
        ctx.progress({ fraction: 0, stage: 'waiting', message: 'Waiting for the previous file' })
        await waitTurn(previous, ctx)
        const output = outputProject(project, request)
        const result = await exportProject(
          output,
          {
            ...exportSize(request.aspect, request.resolution),
            fps: request.fps,
            aspect: request.aspect,
            range: outputRange(output, request.kind),
          },
          ctx,
          { media: appMedia },
        )
        const file = new File([result.file], request.fileName, { type: 'video/mp4' })
        files.set(request.name, file)
        downloadFile(file, request.fileName)
        return result
      },
    })
    queue = handle.promise.catch(() => undefined)
    handle.promise.then(
      () => toast(`Saved ${request.name} to Downloads`),
      () => undefined,
    )
  }
}
