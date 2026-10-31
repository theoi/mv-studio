import {
  createAudioClip,
  createImageClip,
  createTrack,
  createVideoClip,
  type Asset,
  type Clip,
  type EditCommand,
  type Project,
  type Track,
} from '../../model/index.ts'
import type { SongAnalysisService } from '../../analysis/client.ts'
import { JobError, jobs } from '../../shared/jobs.ts'
import { dispatch, editor } from './project.ts'
import { get, select, set, toast } from './ui.ts'

/*
 * Real media import: files are copied into browser storage (OPFS) by src/media and added to the project as assets.
 * The first song imported into a project without one becomes its song and is analyzed (beats, sections, energy).
 */

let fileInput: HTMLInputElement | null = null

/** The editor's hidden file input, used by every Import button and Mod I. */
export function registerImportInput(input: HTMLInputElement | null): void {
  fileInput = input
}

export function openImport(what: 'media' | 'song' = 'media'): void {
  if (!fileInput) return
  fileInput.accept = what === 'song' ? 'audio/*' : 'audio/*,video/*,image/*'
  fileInput.click()
}

const IMPORT_JOB = 'media.import'

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function songCommands(project: Project, song: Asset): EditCommand[] {
  const commands: EditCommand[] = []
  let track = project.tracks.find(
    (t) => t.kind === 'audio' && !t.locked && !Object.values(project.clips).some((c) => c.trackId === t.id),
  )
  if (!track) {
    track = createTrack('audio', 'Song')
    commands.push({ type: 'track.add', track })
  }
  const clip = createAudioClip({
    trackId: track.id,
    assetId: song.id,
    start: 0,
    duration: song.duration ?? 1,
  })
  commands.push({ type: 'clip.add', clip: { ...clip, name: baseName(song.name) } })
  commands.push({ type: 'project.setSong', assetId: song.id })
  if (project.name === 'Untitled video') commands.push({ type: 'project.rename', name: baseName(song.name) })
  return commands
}

let analysisService: SongAnalysisService | null = null

async function analyzeSong(song: Asset, file: Blob): Promise<void> {
  try {
    const client = await import('../../analysis/client.ts')
    analysisService ??= new client.SongAnalysisService()
    const audio = await client.decodeAudioFile(file)
    const analysis = await analysisService.analyze(song.id, audio).promise
    if (!editor.getProject().assets[song.id]) return
    dispatch(client.setAnalysisCommand(analysis), { history: 'skip' })
    const bpm = analysis.tempo ? `${Math.round(analysis.tempo.bpm)} BPM` : 'the beat'
    const sections = analysis.sections?.length ?? 0
    toast(`Found ${bpm} and ${sections} ${sections === 1 ? 'section' : 'sections'}`)
  } catch (error) {
    if (error instanceof JobError && error.code === 'cancelled') return
    toast(`Could not analyze the song: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Imports files as one undo step. Unsupported or unreadable files are reported and skipped. */
export async function importFiles(files: File[]): Promise<Asset[]> {
  if (!files.length) return []
  const { mediaStore } = await import('../../media/mediaStore.ts')
  void mediaStore.requestPersistence().catch(() => false)
  const results = await Promise.allSettled(
    files.map(
      (file) =>
        jobs.run({
          kind: IMPORT_JOB,
          title: `Importing ${file.name}`,
          run: (ctx) => mediaStore.importFile(file, ctx),
        }).promise,
    ),
  )
  const assets = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ file: files[i], error: r.reason }] : [],
  )
  if (failed[0]) {
    const { file, error } = failed[0]
    const reason = error instanceof Error ? error.message : String(error)
    toast(
      failed.length === 1
        ? `${file?.name ?? 'A file'} was not imported: ${reason}`
        : `${failed.length} files were not imported. ${reason}`,
    )
  }
  if (!assets.length) return []

  const project = editor.getProject()
  const commands: EditCommand[] = assets.map((asset) => ({ type: 'asset.add', asset }))
  const song = project.songAssetId ? undefined : assets.find((a) => a.kind === 'audio')
  if (song) commands.push(...songCommands(project, song))
  const label = assets.length === 1 ? `Import ${assets[0]?.name}` : `Import ${assets.length} files`
  if (!dispatch(commands, { label })) return []
  const visual = assets.filter((a) => a.kind === 'video' || a.kind === 'image').length
  if (song) {
    set({ playhead: 0, selection: { type: 'none' } })
    toast(`Added “${baseName(song.name)}” as the song. Finding its beats and sections…`)
    void mediaStore.getFile(song).then((file) => analyzeSong(song, file))
  } else {
    toast(
      assets.length === 1
        ? `Imported ${assets[0]?.name}`
        : `Imported ${assets.length} files${visual ? ` (${visual} clips and images)` : ''}`,
    )
  }
  if (visual) set({ libraryTab: 'media', libraryOpen: true })
  return assets
}

function busyAt(project: Project, trackId: string, start: number, end: number): boolean {
  return Object.values(project.clips).some(
    (c) => c.trackId === trackId && c.start < end && c.start + c.duration > start,
  )
}

function isFootageTrack(project: Project, track: Track): boolean {
  const clips = Object.values(project.clips).filter((c) => c.trackId === track.id)
  return (
    clips.some((c) => c.type === 'video' || c.type === 'image') &&
    !clips.some((c) => c.type === 'text' || c.meta?.behindSubjectOf)
  )
}

/** Adds an asset at the playhead on the first free track of its kind (footage tracks first), adding one if needed. */
export function addAssetAtPlayhead(assetId: string): void {
  const project = editor.getProject()
  const asset = project.assets[assetId]
  if (!asset || asset.kind === 'font') return
  const start = get().playhead
  const kind = asset.kind === 'audio' ? 'audio' : 'visual'
  const duration = asset.kind === 'image' ? 4 : Math.max(0.5, asset.duration ?? 4)
  const candidates = project.tracks
    .filter((t) => t.kind === kind && !t.locked)
    .sort((a, b) => Number(isFootageTrack(project, b)) - Number(isFootageTrack(project, a)))
  const commands: EditCommand[] = []
  let track = candidates.find((t) => !busyAt(project, t.id, start, start + duration))
  if (!track) {
    track = createTrack(kind, kind === 'audio' ? 'Audio' : 'Video')
    const footage = project.tracks.findIndex((t) => isFootageTrack(project, t))
    commands.push({
      type: 'track.add',
      track,
      index: kind === 'visual' && footage >= 0 ? footage : undefined,
    })
  }
  const common = { trackId: track.id, assetId, start, duration }
  const clip: Clip =
    asset.kind === 'audio'
      ? createAudioClip(common)
      : asset.kind === 'video'
        ? createVideoClip(common)
        : createImageClip(common)
  commands.push({ type: 'clip.add', clip: { ...clip, name: baseName(asset.name) } })
  if (dispatch(commands, { label: `Add ${baseName(asset.name)}` })) select({ type: 'clip', id: clip.id })
}
