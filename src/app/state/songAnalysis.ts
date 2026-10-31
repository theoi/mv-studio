import { nearestBeatIndex } from '../../analysis/beats/grid.ts'
import type { SongAnalysisService } from '../../analysis/client.ts'
import { fitTappedTempo, moveDownbeat } from '../../analysis/edits.ts'
import type { EditCommand } from '../../model/index.ts'
import { JobError } from '../../shared/jobs.ts'
import { formatBpm, formatTime, plural } from '../format.ts'
import { isRunning, JOB_KINDS } from './jobs.ts'
import { dispatch, editor, songAnalysis } from './project.ts'
import { toast } from './ui.ts'

/*
 * Assist › Song analysis: corrections to the beat grid (tap tempo, set first beat) as undoable edits, and analyzing
 * the song again on request as one job whose result is one undo step, so undo brings back the user's corrections.
 */

type AnalysisBackend = Pick<SongAnalysisService, 'analyzeAgain' | 'trackAtTempo'>

let service: Promise<AnalysisBackend> | null = null

function analysisService(): Promise<AnalysisBackend> {
  service ??= import('../../analysis/client.ts').then((m) => new m.SongAnalysisService())
  return service
}

/** For end-to-end tests: a stand-in for song analysis. */
export function setSongAnalysisServiceForTests(fake: AnalysisBackend): void {
  service = Promise.resolve(fake)
}

async function songFile(songId: string): Promise<Blob> {
  const { appMedia } = await import('./media.ts')
  const asset = editor.getProject().assets[songId]
  if (!asset) throw new JobError('invalid-input', 'The song is no longer in the project')
  return appMedia.getFile(asset)
}

function undoable(label: string, message: string, commands: EditCommand | EditCommand[]): void {
  if (!dispatch(commands, { label })) return
  toast(message, {
    label: 'Undo',
    run: () => {
      if (editor.undoLabel() === label) editor.undo()
    },
  })
}

/**
 * Uses a tapped tempo: at once when the beats found follow it at some level (the same, twice or half as many),
 * otherwise by tracking the beats again around it (job analysis.tempo). One undo step, "Set tempo".
 */
export async function applyTappedTempo(bpm: number): Promise<void> {
  const project = editor.getProject()
  const analysis = songAnalysis(project)
  const songId = project.songAssetId
  if (!analysis || !songId || isRunning(JOB_KINDS.tempo)) return
  const fit = fitTappedTempo(analysis, bpm)
  if (fit.kind === 'same') {
    toast(`The beats already follow ${formatBpm(bpm)}`)
    return
  }
  if (fit.kind === 'rescale') {
    undoable('Set tempo', `Tempo set to ${formatBpm(fit.edit.grid.tempo?.bpm ?? bpm)}`, fit.edit)
    return
  }
  try {
    const grid = await (await analysisService()).trackAtTempo(songId, bpm, () => songFile(songId)).promise
    if (editor.getProject().songAssetId !== songId) return
    undoable('Set tempo', `Tempo set to ${formatBpm(grid.tempo?.bpm ?? bpm)}`, {
      type: 'analysis.setGrid',
      assetId: songId,
      grid,
    })
  } catch (error) {
    if (!(error instanceof JobError)) throw error
    if (error.code !== 'cancelled') toast(`Could not follow that tempo. ${error.message}`)
  }
}

/** Makes the beat nearest `time` the first beat of a bar and renumbers the bars from it. */
export function setFirstBeat(time: number): void {
  const analysis = songAnalysis(editor.getProject())
  const beats = analysis?.beats ?? []
  if (!analysis || !beats.length) return
  const index = nearestBeatIndex({ beats }, time)
  undoable(
    'Set first beat',
    `Bars now start on the beat at ${formatTime(beats[index] ?? time, true)}`,
    moveDownbeat(analysis, index),
  )
}

/** Analyzes the song again (beats, bars, sections, energy) as one undo step; the lyrics' chorus is kept. */
export async function analyzeAgain(): Promise<void> {
  const songId = editor.getProject().songAssetId
  if (!songId || isRunning(JOB_KINDS.analysis)) return
  try {
    const analysis = await (await analysisService()).analyzeAgain(songId, () => songFile(songId)).promise
    const project = editor.getProject()
    if (project.songAssetId !== songId) return
    const { lyricChorusCommand, setAnalysisCommand } = await import('../../analysis/client.ts')
    const chorus = project.lyrics ? lyricChorusCommand(analysis, project.lyrics) : null
    const sections = analysis.sections?.length ?? 0
    const bpm = analysis.tempo ? formatBpm(analysis.tempo.bpm) : 'the beat'
    undoable('Analyze again', `Found ${bpm} and ${plural(sections, 'section')}`, [
      setAnalysisCommand(analysis),
      ...(chorus ? [chorus] : []),
    ])
  } catch (error) {
    // Failures and their messages show in Assist › Song analysis, from the job.
    if (!(error instanceof JobError)) throw error
  }
}
