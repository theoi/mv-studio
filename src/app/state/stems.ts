import type { StemsEstimate, StemSeparationService, StemStore } from '../../analysis/stems/client.ts'
import type { AudioFeatures } from '../../model/index.ts'
import { JobError } from '../../shared/jobs.ts'
import { isRunning, JOB_KINDS } from './jobs.ts'
import { editor } from './project.ts'
import { openAssist, toast } from './ui.ts'

/*
 * Assist › Stems: the song separated into vocals, drums, bass and other by src/analysis, as one job. The stems are
 * stored with the project and attached to the song's analysis without an undo step, like other analysis results.
 */

type StemsBackend = Pick<StemSeparationService, 'estimate' | 'separateSong'>

let service: Promise<StemsBackend> | null = null

function stemsService(): Promise<StemsBackend> {
  service ??= import('../../analysis/stems/client.ts').then((m) => new m.StemSeparationService())
  return service
}

/** For end-to-end tests: a stand-in for stem separation, whose model is a 181 MB download. */
export function setStemsServiceForTests(fake: StemsBackend): void {
  service = Promise.resolve(fake)
}

/**
 * Where separation reads the song and stores the stems: the app's media, so the generated sample song works too, and
 * browser storage. Timing lyrics separates stems through the same store.
 */
export async function stemStore(): Promise<StemStore> {
  const [{ appMedia }, { mediaStore }] = await Promise.all([
    import('./media.ts'),
    import('../../media/mediaStore.ts'),
  ])
  return {
    getFile: (asset) => appMedia.getFile(asset),
    storeBlob: (blob, info) => mediaStore.storeBlob(blob, info),
  }
}

/** What separating the song will download and how long it takes on this device, or null without a song. */
export async function estimateStems(): Promise<StemsEstimate | null> {
  const project = editor.getProject()
  if (!project.songAssetId) return null
  return (await stemsService()).estimate(project, project.songAssetId)
}

export async function startStems(): Promise<void> {
  const songId = editor.getProject().songAssetId
  if (!songId || isRunning(JOB_KINDS.stems)) return
  const [stems, store] = await Promise.all([stemsService(), stemStore()])
  try {
    await stems.separateSong(songId, { editor, store }).promise
    toast('Stems are ready: vocals, drums, bass and other', {
      label: 'Show',
      run: () => openAssist('stems'),
    })
  } catch (error) {
    // Failures and their messages show in Assist › Stems, from the job.
    if (!(error instanceof JobError)) throw error
  }
}

/** A stem's loudness as `bars` heights (0..1), the loudest moment of each stretch, for a small waveform. */
export function stemBars(features: AudioFeatures | undefined, bars: number): number[] {
  const values = features?.loudness ?? []
  return Array.from({ length: bars }, (_, k) => {
    const a = Math.floor((k * values.length) / bars)
    const z = Math.max(a + 1, Math.floor(((k + 1) * values.length) / bars))
    let peak = 0
    for (let i = a; i < z && i < values.length; i++) peak = Math.max(peak, values[i] ?? 0)
    return peak
  })
}
