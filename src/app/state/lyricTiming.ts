import type { LyricsEstimate } from '../../analysis/lyrics/client.ts'
import type { LyricLine } from '../../model/index.ts'
import { JobError } from '../../shared/jobs.ts'
import { isRunning, JOB_KINDS } from './jobs.ts'
import { estimateLyrics, lyricsCommands, lyricsDeps, lyricsService } from './lyrics.ts'
import { dispatch, editor } from './project.ts'
import { toast } from './ui.ts'

/*
 * Inspector › Lyric line › Re-time line: the line's words fitted to the vocals again, for example after its text was
 * corrected. It reuses the aligner output the shared lyrics service kept from timing; after a reload it listens to
 * the vocals first (job analysis.realign, separating stems when the song has none).
 */

export type LineTiming = 'timed' | 'untimed' | 'edited'

/** Whether a line has word timings, and whether its text still matches the timed words. */
export function lineTiming(line: LyricLine): LineTiming {
  if (line.start === undefined || line.words.length === 0) return 'untimed'
  const words = line.text.split(/\s+/).filter(Boolean)
  const same = words.length === line.words.length && words.every((w, i) => w === line.words[i]?.text)
  return same ? 'timed' : 'edited'
}

/**
 * What re-timing costs before it can start, or null when it runs at once (the vocals were listened to in this
 * session) or there is no song. Listening needs the same models as timing lyrics and nearly the same time.
 */
export async function retimeCost(): Promise<LyricsEstimate | null> {
  const songId = editor.getProject().songAssetId
  if (!songId || (await lyricsService()).canRealign(songId)) return null
  return estimateLyrics('time')
}

export async function retimeLine(lineId: string): Promise<void> {
  const songId = editor.getProject().songAssetId
  if (!songId || isRunning(JOB_KINDS.realign) || isRunning(JOB_KINDS.lyrics)) return
  const lyrics = await lyricsService()
  if (!lyrics.canRealign(songId)) {
    try {
      await lyrics.prepareRealign(songId, await lyricsDeps()).promise
    } catch (error) {
      // Failures and their messages show in the inspector, from the job.
      if (!(error instanceof JobError)) throw error
      return
    }
  }
  const project = editor.getProject()
  const doc = project.lyrics
  const index = doc?.lines.findIndex((l) => l.id === lineId) ?? -1
  if (!doc || index < 0 || project.songAssetId !== songId) return
  const next = lyrics.realignLine({ ...doc, audioAssetId: songId }, index)
  if (!next) return
  const label = 'Re-time line'
  if (!dispatch(lyricsCommands(project, next), { label })) return
  toast('Line re-timed to the vocals', {
    label: 'Undo',
    run: () => {
      if (editor.undoLabel() === label) editor.undo()
    },
  })
}
