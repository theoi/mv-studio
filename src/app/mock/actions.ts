import type { Asset, StemName } from '../../model/index.ts'
import { jobs } from '../../shared/jobs.ts'
import { JOB_KINDS, isRunning, runMockJob, runningJobs } from '../state/jobs.ts'
import { dispatch, editor, songAnalysis } from '../state/project.ts'
import { toast, openAssist } from '../state/ui.ts'
import { SONG_ASSET_ID } from './demoProject.ts'

/*
 * Mock feature actions for the design preview. Each runs as a job on the shared JobRunner and, where the real
 * feature would change the project, applies the result through edit commands.
 */

const STEMS: StemName[] = ['vocals', 'drums', 'bass', 'other']

export function applyMockStems() {
  const project = editor.getProject()
  const analysis = songAnalysis(project)
  if (!analysis || analysis.stems) return
  const assets: Asset[] = STEMS.map((s) => ({
    id: `a-stem-${s}`,
    kind: 'audio',
    name: `${s[0]?.toUpperCase()}${s.slice(1)}`,
    mimeType: 'audio/wav',
    byteSize: 30_000_000,
    storageKey: `mock:stem-${s}`,
    duration: 204,
    origin: { type: 'stem', parentAssetId: SONG_ASSET_ID },
    createdAt: new Date().toISOString(),
  }))
  dispatch(
    [
      ...assets.map((asset) => ({ type: 'asset.add' as const, asset })),
      {
        type: 'analysis.setAudio',
        analysis: { ...analysis, stems: Object.fromEntries(STEMS.map((s) => [s, `a-stem-${s}`])) },
      },
    ],
    { label: 'Separate stems' },
  )
}

export function startStems(startAt = 0, fail = false) {
  if (isRunning(JOB_KINDS.stems)) return
  runMockJob({
    kind: JOB_KINDS.stems,
    title: 'Separating stems',
    seconds: 240,
    startAt,
    stages: [
      { at: 0, stage: 'download', message: 'Downloading the model (180 MB, once)' },
      { at: 0.08, stage: 'separate', message: 'Separating the song' },
      { at: 0.96, stage: 'save', message: 'Saving stems with the project' },
    ],
    fail: fail
      ? {
          at: startAt + 0.002,
          code: 'out-of-memory',
          message: 'This computer ran out of memory while separating stems.',
        }
      : undefined,
    onDone: () => {
      applyMockStems()
      toast('Stems are ready: vocals, drums, bass and other', {
        label: 'Show',
        run: () => openAssist('stems'),
      })
    },
  })
}

export function startDirector(startAt = 0) {
  if (isRunning(JOB_KINDS.director)) return
  runMockJob({
    kind: JOB_KINDS.director,
    title: 'Drafting your video',
    seconds: 8,
    startAt,
    stages: [
      { at: 0, stage: 'structure', message: 'Reading the song’s structure' },
      { at: 0.2, stage: 'match', message: 'Matching your clips to sections' },
      { at: 0.4, stage: 'plan', message: 'Writing the creative plan' },
      { at: 0.7, stage: 'place', message: 'Placing shots and lyrics' },
      { at: 0.9, stage: 'looks', message: 'Applying looks and effects' },
    ],
  })
}

export function startAutocut(startAt = 0) {
  if (isRunning(JOB_KINDS.autocut)) return
  runMockJob({ kind: JOB_KINDS.autocut, title: 'Cutting to the beat', seconds: 2, startAt })
}

export type ExportKind = 'full' | 'format' | 'teaser' | 'loop'

export function exportSeconds(kind: ExportKind): number {
  return kind === 'full' ? 16 : kind === 'format' ? 22 : 4
}

/** Starts one export job per output, skipping outputs that are already exporting. */
export function startExport(outputs: { name: string; seconds: number; startAt?: number }[]) {
  const busy = new Set(runningJobs(jobs.list()).map((j) => j.title))
  for (const o of outputs) {
    const title = `Exporting ${o.name}`
    if (busy.has(title)) continue
    runMockJob({
      kind: JOB_KINDS.export,
      title,
      seconds: o.seconds,
      startAt: o.startAt,
      onDone: () => toast(`Saved ${o.name} to Downloads`),
    })
  }
}
