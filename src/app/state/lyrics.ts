import type {
  LyricsDeps,
  LyricsEstimate,
  LyricsRequest,
  LyricsService,
} from '../../analysis/lyrics/client.ts'
import { retimeDirectorLyricCommands } from '../../director/retime.ts'
import { createTrack, type EditCommand, type LyricsDoc, type Project } from '../../model/index.ts'
import { JobError } from '../../shared/jobs.ts'
import { lyricClipCommands } from '../../plugins/lyricClips.ts'
import { starterTemplate, templateState } from '../../plugins/templates.ts'
import { plural } from '../format.ts'
import { dispatch, editor } from './project.ts'
import { stemStore } from './stems.ts'
import { toast } from './ui.ts'

/*
 * Assist › Lyrics: pasted lyrics timed to the vocals, or a draft written from them, as one job from src/analysis
 * (stems are separated first when the song has none). The result lands as one undo step: the lyrics, the clips on
 * the Lyrics track and the director's emphasized words and previews moved with their lines.
 */

type LyricsBackend = Pick<
  LyricsService,
  'estimate' | 'run' | 'prepareRealign' | 'canRealign' | 'realignFrom' | 'realignLine'
>

let service: Promise<LyricsBackend> | null = null

/**
 * The app's one LyricsService. Re-timing single lines and dragged words (realignFrom, realignLine) uses the aligner
 * output this instance kept from the last run, so Assist › Lyrics and the inspector must share it. After a reload,
 * prepareRealign(songId, lyricsDeps()) listens to the vocals again.
 */
export function lyricsService(): Promise<LyricsBackend> {
  service ??= import('../../analysis/lyrics/client.ts').then((m) => new m.LyricsService())
  return service
}

/** The project and media the lyrics service reads and writes (stems it separates are stored with the project). */
export async function lyricsDeps(): Promise<LyricsDeps> {
  return { editor, store: await stemStore() }
}

/** For end-to-end tests: a stand-in for stem separation, alignment and transcription, which need large models. */
export function setLyricsServiceForTests(fake: LyricsBackend): void {
  service = Promise.resolve(fake)
}

/** What timing or drafting will download and how long it takes, or null without a song. */
export async function estimateLyrics(kind: LyricsRequest['kind']): Promise<LyricsEstimate | null> {
  const project = editor.getProject()
  if (!project.songAssetId) return null
  return (await lyricsService()).estimate(project, project.songAssetId, { kind })
}

/** The latest request, for "Try again". */
export let lastLyricsRequest: LyricsRequest | null = null

export async function startLyrics(request: LyricsRequest): Promise<void> {
  const songId = editor.getProject().songAssetId
  if (!songId) return
  lastLyricsRequest = request
  const [lyrics, deps] = await Promise.all([lyricsService(), lyricsDeps()])
  try {
    const result = await lyrics.run(songId, request, deps).promise
    if (editor.getProject().songAssetId !== songId) return
    const label = request.kind === 'time' ? 'Time lyrics' : 'Draft lyrics'
    if (!dispatch(lyricsCommands(editor.getProject(), result.doc), { label })) return
    // Relabels sections from repeated lines; derived data, so it is not part of the undo step.
    if (result.chorus) dispatch(result.chorus, { history: 'skip' })
    const lines = result.doc.lines.length
    toast(
      request.kind === 'time'
        ? `Timed ${plural(lines, 'line')} to the vocals`
        : `Drafted ${plural(lines, 'line')}. Check each one; sung words are tricky.`,
      {
        label: 'Undo',
        run: () => {
          if (editor.undoLabel() === label) editor.undo()
        },
      },
    )
  } catch (error) {
    // Failures and their messages show in Assist › Lyrics, from the job.
    if (!(error instanceof JobError)) throw error
  }
}

/**
 * Edits that store `doc` and rebuild the lyric clips for it: on the track that holds them (keeping their look), else
 * a template's Lyrics track, else a new Lyrics track on top. The director's emphasized words and next-line previews
 * follow their lines, or are removed when their line's words changed.
 */
export function lyricsCommands(project: Project, doc: LyricsDoc): EditCommand[] {
  // Read against the lyrics being replaced, so it runs before `lyrics.set` is applied.
  const director = retimeDirectorLyricCommands(project, doc)
  // setLyricsCommand's edit, without loading the lyrics client into this chunk.
  const commands: EditCommand[] = [{ type: 'lyrics.set', lyrics: doc }]
  const template = templateState(project)
  const textStyleId = (template && starterTemplate(template.kind).textStyleId) || 'caption'
  const usable = (id: string | undefined) =>
    project.tracks.find((t) => t.id === id && t.kind === 'visual' && !t.locked)
  let track = usable(busiestLyricTrack(project)) ?? usable(template?.tracks.lyrics)
  let base = project
  if (!track) {
    track = createTrack('visual', 'Lyrics')
    commands.push({ type: 'track.add', track, index: 0 })
    base = { ...project, tracks: [track, ...project.tracks] }
  }
  commands.push(...lyricClipCommands(base, doc, { trackId: track.id, textStyleId }), ...director)
  return commands
}

function busiestLyricTrack(project: Project): string | undefined {
  const counts = new Map<string, number>()
  for (const c of Object.values(project.clips))
    if (c.type === 'text' && c.lyricLineId) counts.set(c.trackId, (counts.get(c.trackId) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}
