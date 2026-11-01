import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportSummary } from '../../../src/app/screens/export/outputs.ts'
import { showExport, toastExportEnd, useExports, type ExportRow } from '../../../src/app/state/exports.ts'
import { shortTimeLeft, timeLeft } from '../../../src/app/format.ts'
import { JOB_KINDS, jobChipLabel, jobSecondsLeft } from '../../../src/app/state/jobs.ts'
import { editor } from '../../../src/app/state/project.ts'
import { get, set } from '../../../src/app/state/ui.ts'
import { JobError, jobs, type JobSnapshot } from '../../../src/shared/jobs.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

beforeEach(() => {
  vi.useFakeTimers()
  set({ toasts: [], dialog: null, exportPhase: 'setup', screen: 'editor' })
})

afterEach(() => {
  vi.useRealTimers()
})

const rows: ExportRow[] = [{ id: 'canvas', title: 'Loop for Canvas', aspect: '9:16', frames: 240 }]

const exportJob = (end: 'succeeded' | 'failed' | 'cancelled') =>
  jobs.run({
    kind: JOB_KINDS.export,
    title: 'Exporting video',
    run: async () => {
      if (end === 'failed') throw new JobError('decode', 'A clip couldn’t be decoded')
      if (end === 'cancelled') throw new JobError('cancelled', 'Cancelled')
      return []
    },
  })

describe('the exporting view', () => {
  it.each([
    ['succeeded', '1 file saved', 'Find it in your Downloads folder.'],
    ['failed', 'Export failed', 'Nothing was saved.'],
    ['cancelled', 'Export cancelled', 'Nothing was saved.'],
  ] as const)(
    'still says an export %s once newer jobs push it out of the job list',
    async (end, title, note) => {
      const handle = exportJob(end)
      showExport(handle.id, rows)
      if (end === 'succeeded')
        useExports.setState({ files: { canvas: new File(['x'], 'Song - Canvas.mp4') } })
      await handle.promise.catch(() => undefined)
      for (let i = 0; i < 21; i++)
        await jobs.run({ kind: 'other', title: 'Other', run: async () => undefined }).promise
      expect(jobs.list().some((j) => j.id === handle.id)).toBe(false)
      const { job, files } = useExports.getState()
      expect(exportSummary(job, rows, files)).toMatchObject({ title, note, running: false })
    },
  )
})

describe('the toast when an export ends', () => {
  it('stays with Show and Download while the export dialog is closed, and Show opens the export', () => {
    toastExportEnd('Saved “Song - Canvas.mp4” to Downloads', { rowId: 'canvas' })
    vi.advanceTimersByTime(60_000)
    const [toast] = get().toasts
    expect(toast).toMatchObject({
      message: 'Saved “Song - Canvas.mp4” to Downloads',
      action: { label: 'Download' },
    })
    toast?.show?.()
    expect(get()).toMatchObject({ dialog: 'export', exportPhase: 'exporting', toasts: [] })
  })

  it('offers Show alone for several files', () => {
    toastExportEnd('Saved 2 files to Downloads')
    const [toast] = get().toasts
    expect(toast?.action).toBeUndefined()
    toast?.show?.()
    expect(get().exportPhase).toBe('exporting')
  })

  it('can go after the usual time, for an export the user cancelled', () => {
    toastExportEnd('Export cancelled. 1 of 2 files was saved to Downloads.', { sticky: false })
    vi.advanceTimersByTime(21_000)
    expect(get().toasts).toEqual([])
  })

  it.each(['exporting', 'setup'] as const)(
    'is a plain note while the export dialog is open (%s), which shows how it ended or lists the file',
    (exportPhase) => {
      set({ dialog: 'export', exportPhase })
      toastExportEnd('Saved “Song - Canvas.mp4” to Downloads', { rowId: 'canvas' })
      const [toast] = get().toasts
      expect(toast?.action).toBeUndefined()
      expect(toast?.show).toBeUndefined()
      vi.advanceTimersByTime(6_000)
      expect(get().toasts).toEqual([])
    },
  )

  it('goes when the Export dialog opens, however it is opened', () => {
    toastExportEnd('Saved “Song - Canvas.mp4” to Downloads', { rowId: 'canvas' })
    set({ dialog: 'export', exportPhase: 'setup' })
    expect(get().toasts).toEqual([])
  })

  it('keeps Download but offers no Show on the setup screen, and offers it again back in the editor', () => {
    set({ screen: 'setup' })
    toastExportEnd('Saved “Song - Canvas.mp4” to Downloads', { rowId: 'canvas' })
    expect(get().toasts[0]).toMatchObject({ action: { label: 'Download' }, show: undefined })
    set({ screen: 'editor' })
    get().toasts[0]?.show?.()
    expect(get()).toMatchObject({ dialog: 'export', exportPhase: 'exporting', toasts: [] })
  })

  it('opens the exported project’s editor from the start screen, and offers no Show once another project is open', async () => {
    const handle = exportJob('succeeded')
    showExport(handle.id, rows, editor.getProject().id)
    await handle.promise
    set({ screen: 'start' })
    toastExportEnd('Saved “Song - Canvas.mp4” to Downloads', { rowId: 'canvas' })
    get().toasts[0]?.show?.()
    expect(get()).toMatchObject({ screen: 'editor', dialog: 'export', exportPhase: 'exporting', toasts: [] })

    set({ dialog: null })
    const other = exportJob('succeeded')
    showExport(other.id, rows, 'another-project')
    await other.promise
    set({ screen: 'start' })
    toastExportEnd('Saved “Song - Canvas.mp4” to Downloads', { rowId: 'canvas' })
    expect(get().toasts[0]).toMatchObject({ action: { label: 'Download' }, show: undefined })
  })

  it('goes when the next export starts', async () => {
    toastExportEnd('Saved 2 files to Downloads')
    const handle = exportJob('succeeded')
    showExport(handle.id, rows)
    expect(get().toasts).toEqual([])
    await handle.promise
  })
})

describe('a job’s time left in the activity chip', () => {
  const job = (progress: JobSnapshot['progress'], stopping?: boolean): JobSnapshot => ({
    id: 'job',
    kind: JOB_KINDS.export,
    title: 'Exporting video',
    status: 'running',
    progress,
    stopping,
  })

  it('calls an export “Exporting”, whatever it makes, so its percentage and time left fit beside it', () => {
    expect(jobChipLabel(job({ fraction: 0.5 }))).toBe('Exporting')
    expect(jobChipLabel(job({ fraction: 0.5 }, true))).toBe('Stopping…')
  })

  it('is the time its own view counts, while it can tell and isn’t stopping', () => {
    expect(jobSecondsLeft(job({ fraction: 0.5, etaSeconds: 290 }))).toBe(290)
    expect(jobSecondsLeft(job({ fraction: 0.5 }))).toBeUndefined()
    expect(jobSecondsLeft(job({ fraction: 0.5, etaSeconds: 290 }, true))).toBeUndefined()
  })

  it.each([
    [290, 'About 5 min left', '5 min left'],
    [20, 'Less than a minute left', 'almost done'],
  ])('of %i s reads “%s” in the dialog and “%s” in the chip', (seconds, long, short) => {
    expect(timeLeft(seconds)).toBe(long)
    expect(shortTimeLeft(seconds)).toBe(short)
  })
})
