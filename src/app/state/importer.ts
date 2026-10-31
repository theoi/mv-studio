import {
  ProjectEditor,
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
import { importLut, isCubeFile, isLutAsset } from '../../plugins/lut.ts'
import { JobError, jobs } from '../../shared/jobs.ts'
import { templateState } from '../../plugins/templates.ts'
import { TRACK_IDS } from '../mock/demoProject.ts'
import { numberedName } from './clipboard.ts'
import { backgroundAnalysisOn } from './footage.ts'
import { JOB_KINDS } from './jobs.ts'
import { formatTime, plural } from '../format.ts'
import { barsToSeconds, prefs } from './prefs.ts'
import { bpmOf, dispatch, editor } from './project.ts'
import { analysisService, findBars, foundText, markSongPending } from './songAnalysis.ts'
import { get, select, set, toast } from './ui.ts'

/*
 * Real media import: files are copied into browser storage (OPFS) by src/media and added to the project as assets.
 * The first song imported into a project without one becomes its song and is analyzed (beats, sections, energy),
 * then refined in the background (bars and steadier beats).
 */

let fileInput: HTMLInputElement | null = null

/** The editor's hidden file input, used by every Import button and Mod I. */
export function registerImportInput(input: HTMLInputElement | null): void {
  fileInput = input
}

/** Fonts go by extension: few systems give them a MIME type, and accept has no font/* wildcard. */
const MEDIA_FILE_TYPES = 'audio/*,video/*,image/*,.ttf,.otf,.woff,.woff2,.cube'

export function openImport(what: 'media' | 'song' = 'media'): void {
  if (!fileInput) return
  fileInput.accept = what === 'song' ? 'audio/*' : MEDIA_FILE_TYPES
  fileInput.click()
}

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
  if (project.name === 'Untitled video')
    commands.push({ type: 'project.rename', name: song.tags?.title ?? baseName(song.name) })
  return commands
}

const analyzing = new Map<string, Promise<boolean>>()

/** The analysis of this song still running, if any (an import or the setup screen started it). */
export function songAnalysisRunning(songId: string): Promise<boolean> | undefined {
  return analyzing.get(songId)
}

/**
 * Finds the song's beats, sections and energy, then bars in the background. The result goes into the open project
 * if it has the song by then (the setup screen opens the editor while this runs). False when it failed.
 */
export function analyzeSong(song: Asset): Promise<boolean> {
  const running = analyzing.get(song.id)
  if (running) return running
  const run = analyze(song).finally(() => analyzing.delete(song.id))
  analyzing.set(song.id, run)
  return run
}

async function analyze(song: Asset): Promise<boolean> {
  // The setup screen shows the progress and the result itself.
  const say = (message: string) => get().screen === 'editor' && toast(message)
  try {
    const [{ mediaStore }, client] = await Promise.all([
      import('../../media/mediaStore.ts'),
      import('../../analysis/client.ts'),
    ])
    const audio = await client.decodeAudioFile(await mediaStore.getFile(song))
    const analysis = await (await analysisService()).analyze(song.id, audio).promise
    if (!editor.getProject().assets[song.id]) return true
    dispatch(client.setAnalysisCommand(analysis), { history: 'skip' })
    say(foundText(analysis))
    // Bars and steadier beats from Beat This! (a model downloaded on first use), shown in the activity list while
    // it runs. Beats or sections the user corrected meanwhile are kept. If it fails, the fast analysis stays.
    if (backgroundAnalysisOn()) void findBars(song.id, { baseline: analysis, sections: true })
    return true
  } catch (error) {
    if (error instanceof JobError && error.code === 'cancelled') return false
    say(`Couldn’t analyze the song: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export interface StoredFiles {
  assets: Asset[]
  failed: { file: File; reason: string }[]
}

/** Copies files into browser storage, one import job each, without adding them to the project. */
export async function storeFiles(files: File[]): Promise<StoredFiles> {
  const { mediaStore } = await import('../../media/mediaStore.ts')
  void mediaStore.requestPersistence().catch(() => false)
  const results = await Promise.allSettled(
    files.map(
      (file) =>
        jobs.run({
          kind: JOB_KINDS.import,
          title: `Importing ${file.name}`,
          run: (ctx) =>
            isCubeFile(file)
              ? importLut(file, mediaStore, Object.values(editor.getProject().assets))
              : mediaStore.importFile(file, ctx),
        }).promise,
    ),
  )
  return {
    assets: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    failed: results.flatMap((r, i) => {
      const file = files[i]
      if (r.status === 'fulfilled' || !file) return []
      return [{ file, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
    }),
  }
}

/**
 * Imports files as one undo step. Unsupported or unreadable files are reported and skipped. With `at` (files dropped
 * on the timeline), the clips and images go there one after another in the same step; a song for a project without
 * one still becomes its song.
 */
export async function importFiles(files: File[], at?: Placement): Promise<Asset[]> {
  if (!files.length) return []
  const stored = await storeFiles(files)
  if (stored.failed[0]) {
    const { file, reason } = stored.failed[0]
    toast(
      stored.failed.length === 1
        ? `${file.name} was not imported: ${reason}`
        : `${stored.failed.length} files were not imported. ${reason}`,
    )
  }
  const project = editor.getProject()
  // A LUT file the project already has comes back as that LUT, already in the project.
  const known = stored.assets.filter((a) => project.assets[a.id])
  if (known[0])
    toast(
      known.length === 1
        ? `“${known[0].name}” is already in this project.`
        : `${known.length} of these LUTs are already in this project.`,
    )
  const assets = stored.assets.filter((a) => !project.assets[a.id])
  if (!assets.length) return []

  const commands: EditCommand[] = assets.map((asset) => ({ type: 'asset.add', asset }))
  const song = project.songAssetId ? undefined : assets.find((a) => a.kind === 'audio')
  if (song) commands.push(...songCommands(project, song))
  const placed = at
    ? placeAll(
        project,
        commands,
        assets.filter((a) => a !== song && !isLutAsset(a)),
        at,
      )
    : []
  const label = assets.length === 1 ? `Import ${assets[0]?.name}` : `Import ${assets.length} files`
  // Before the song is in the project, so Inspector › Song never says "Not analyzed yet" while its file loads.
  if (song) markSongPending(song.id, true)
  if (!dispatch([...commands, ...placed.flatMap((p) => p.commands)], { label })) {
    if (song) markSongPending(song.id, false)
    return []
  }
  const luts = assets.filter(isLutAsset)
  const visual = assets.filter((a) => (a.kind === 'video' || a.kind === 'image') && !isLutAsset(a)).length
  // A LUT is not media, so the Media library doesn't list it: say where it went.
  const lutNote = luts[0]
    ? luts.length === 1
      ? `Imported the LUT “${luts[0].name}”. Choose it in a Color grade’s LUT.`
      : `Imported ${luts.length} LUTs. Choose them in a Color grade’s LUT.`
    : undefined
  const first = placed[0]?.clip
  if (first) {
    select({ type: 'clip', id: first.id })
    toast(
      placed.length === 1
        ? `Added “${first.name}” at ${formatTime(first.start, true)}`
        : `Added ${placed.length} files from ${formatTime(first.start, true)}`,
    )
  }
  if (song) {
    set({ playhead: 0, selection: { type: 'none' } })
    toast(`Added “${baseName(song.name)}” as the song. Finding its beats and sections…`)
    void analyzeSong(song).finally(() => markSongPending(song.id, false))
  }
  if (lutNote && (song || first || luts.length === assets.length)) toast(lutNote)
  else if (!song && !first) toast(assets.length === 1 ? `Imported ${assets[0]?.name}` : importedFiles(assets))
  if (visual) set({ libraryTab: 'media', libraryOpen: true })
  return assets
}

/** "Imported 3 files: 2 clips and images, 1 LUT." */
function importedFiles(assets: readonly Asset[]): string {
  const luts = assets.filter(isLutAsset).length
  const visual = assets.filter((a) => (a.kind === 'video' || a.kind === 'image') && !isLutAsset(a)).length
  const audio = assets.filter((a) => a.kind === 'audio').length
  const fonts = assets.filter((a) => a.kind === 'font').length
  const kinds = [
    visual && plural(visual, 'clip or image', 'clips and images'),
    audio && plural(audio, 'audio file'),
    fonts && plural(fonts, 'font'),
    luts && plural(luts, 'LUT'),
  ].filter(Boolean)
  return `Imported ${assets.length} files: ${kinds.join(', ')}.`
}
/** Places assets one after another from `at`, against the project as `before` (the import) leaves it. */
function placeAll(
  project: Project,
  before: EditCommand[],
  assets: Asset[],
  at: Placement,
): { commands: EditCommand[]; clip: Clip }[] {
  const scratch = new ProjectEditor(project)
  scratch.dispatch(before)
  const placed: { commands: EditCommand[]; clip: Clip }[] = []
  let start = at.start
  for (const asset of assets) {
    const next = assetPlacement(scratch.getProject(), asset, { ...at, start })
    if (!next) continue
    scratch.dispatch(next.commands)
    placed.push(next)
    start = next.clip.start + next.clip.duration
  }
  return placed
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

export interface Placement {
  /** Timeline start (default: the playhead). */
  start?: number
  /** Default: the whole clip, or Settings › Editing › Default image duration for an image. */
  duration?: number
  /** Where in a video or audio file to start, in source seconds. */
  sourceStart?: number
  /** The track to use while it is free there (default: the first free track of the asset's kind). */
  trackId?: string
  /** The longest the clip may be, to fit a gap. */
  maxDuration?: number
}

/** Tracks kept for lyric lines: the sample's, a template's Lyrics track, and any track that holds lyric lines. */
function isLyricTrack(project: Project, trackId: string): boolean {
  return (
    trackId === TRACK_IDS.lyrics ||
    templateState(project)?.tracks.lyrics === trackId ||
    Object.values(project.clips).some((c) => c.trackId === trackId && c.type === 'text' && !!c.lyricLineId)
  )
}

/**
 * Adds an asset on the given track or the first free track of its kind (footage tracks first), adding one if needed,
 * and selects the new clip. `inspect: false` leaves the right panel as it is, for panels that place several clips in a
 * row.
 */
export function addAsset(assetId: string, at: Placement = {}, { inspect = true } = {}): boolean {
  const project = editor.getProject()
  const asset = project.assets[assetId]
  const placed = asset && assetPlacement(project, asset, at)
  if (!placed || !dispatch(placed.commands, { label: `Add ${baseName(asset.name)}` })) return false
  const selection = { type: 'clip', id: placed.clip.id } as const
  if (inspect) select(selection)
  else set({ selection })
  return true
}

/** A Library card's add: at the playhead, saying where it landed, with Undo. */
export function addAssetAtPlayhead(assetId: string): void {
  if (!addAsset(assetId)) return
  const { selection } = get()
  const clip = selection.type === 'clip' ? editor.getProject().clips[selection.id] : undefined
  if (!clip) return
  const label = editor.undoLabel()
  toast(`Added “${clip.name}” at ${formatTime(clip.start, true)}`, {
    label: 'Undo',
    run: () => {
      if (editor.undoLabel() === label) editor.undo()
    },
  })
}

/**
 * The commands that put an asset (already in the project, or added by the same dispatch) on the first free track of
 * its kind, footage tracks first, adding a track if none is free.
 */
export function assetPlacement(
  project: Project,
  asset: Asset,
  at: Placement = {},
): { commands: EditCommand[]; clip: Clip } | null {
  if (asset.kind === 'font') return null
  const start = at.start ?? get().playhead
  const kind = asset.kind === 'audio' ? 'audio' : 'visual'
  const sourceStart = asset.kind === 'image' ? 0 : Math.max(0, at.sourceStart ?? 0)
  const available = asset.kind === 'image' ? Infinity : Math.max(0.5, (asset.duration ?? 4) - sourceStart)
  const imageDuration = barsToSeconds(prefs().imageBars, bpmOf(project))
  const duration = Math.min(
    available,
    at.duration ?? (asset.kind === 'image' ? imageDuration : available),
    at.maxDuration ?? Infinity,
  )
  const candidates = project.tracks
    .filter((t) => t.kind === kind && !t.locked && !isLyricTrack(project, t.id))
    .sort((a, b) => Number(isFootageTrack(project, b)) - Number(isFootageTrack(project, a)))
  const commands: EditCommand[] = []
  const free = (t: Track) => !busyAt(project, t.id, start, start + duration)
  let track = candidates.find((t) => t.id === at.trackId && free(t)) ?? candidates.find(free)
  if (!track) {
    track = createTrack(kind, numberedName(project.tracks, kind === 'audio' ? 'Audio' : 'Video'))
    const footage = project.tracks.findIndex((t) => isFootageTrack(project, t))
    commands.push({
      type: 'track.add',
      track,
      index: kind === 'visual' && footage >= 0 ? footage : undefined,
    })
  }
  const common = { trackId: track.id, assetId: asset.id, start, duration }
  const clip: Clip =
    asset.kind === 'audio'
      ? createAudioClip({ ...common, sourceStart })
      : asset.kind === 'video'
        ? createVideoClip({ ...common, sourceStart })
        : createImageClip(common)
  const named = { ...clip, name: baseName(asset.name) }
  commands.push({ type: 'clip.add', clip: named })
  return { commands, clip: named }
}
