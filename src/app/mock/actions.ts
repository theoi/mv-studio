import { DEMUCS_MODEL, MODEL_TITLES } from '../../analysis/models.ts'
import type { Asset, StemName } from '../../model/index.ts'
import { downloadingModel, modelBytes } from '../../shared/models.ts'
import { showExport } from '../state/exports.ts'
import { JOB_KINDS, isRunning, runMockJob } from '../state/jobs.ts'
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
      { at: 0, stage: 'download', message: downloadingModel(MODEL_TITLES.stems, modelBytes(DEMUCS_MODEL)) },
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

/** The design preview's export in progress: the full video and a vertical version, rendered in one job. */
export function startMockExport(startAt = 0) {
  if (isRunning(JOB_KINDS.export)) return
  const handle = runMockJob({
    kind: JOB_KINDS.export,
    title: 'Exporting 2 videos',
    seconds: 40,
    startAt,
    stages: [
      { at: 0, stage: 'render', message: '1 of 2: Rendering' },
      { at: 0.5, stage: 'render', message: '2 of 2: Rendering' },
    ],
    onDone: () => toast('Saved 2 files to Downloads'),
  })
  showExport(handle.id, [
    { id: 'mock-full', title: 'Full video', aspect: '16:9', frames: 6120 },
    { id: 'mock-vertical', title: 'Vertical', aspect: '9:16', frames: 6120 },
  ])
}
