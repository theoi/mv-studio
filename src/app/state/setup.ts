/*
 * The setup screen ("Lyric video", "Visualizer", ...): the song, the clips, the lyrics, the idea and the visualizer
 * style the user gives before the editor opens. Chosen files are copied into browser storage right away, and a chosen
 * song is loaded in a draft project so its analysis runs (and lands) while the user fills in the rest. Opening the
 * editor builds the project from the kind's starter template with all of it.
 */
import { create } from 'zustand'
import { ProjectEditor, type Asset, type LyricsDoc, type Project } from '../../model/index.ts'
import {
  createFromTemplate,
  templateCommands,
  templateState,
  type TemplateInput,
  type VideoKind,
} from '../../plugins/templates.ts'
import { sampleSong } from '../mock/demoProject.ts'
import { draftFromSetup } from './director.ts'
import { analyzeSong, storeFiles } from './importer.ts'
import { loadSetupDraft, startProject } from './persistence.ts'
import { editor } from './project.ts'
import { editorPreset, get as getUi, maybeStartGuide, set as setUi, type Kind, type Selection } from './ui.ts'

export interface SetupSong {
  /** 'adding' while the file is copied into browser storage. */
  status: 'adding' | 'ready'
  /** The file's name. */
  name: string
  /** The song's name: the file's name without its extension, or the sample song's title. */
  title: string
  asset?: Asset
  sample?: boolean
  analysis: 'running' | 'done' | 'failed'
}

export interface SetupState {
  song: SetupSong | null
  songError: string | null
  footage: Asset[]
  /** Clip files still being copied into storage. */
  adding: number
  footageError: string | null
  lyrics: string
  idea: string
  /** VISUALIZER_STYLES id. */
  visualizerStyle: string
}

const blank: SetupState = {
  song: null,
  songError: null,
  footage: [],
  adding: 0,
  footageError: null,
  lyrics: '',
  idea: '',
  visualizerStyle: 'spectrum',
}

export const useSetup = create<SetupState>(() => blank)

const update = (patch: Partial<SetupState> | ((s: SetupState) => Partial<SetupState>)) =>
  useSetup.setState(patch)

export function setSetup(patch: Partial<Pick<SetupState, 'lyrics' | 'idea' | 'visualizerStyle'>>): void {
  update(patch)
}

/** A link to the setup screen starts it empty, or with the sample song (`song=1`). */
export function setupFromLink(sample: boolean): void {
  useSetup.setState(blank, true)
  if (sample) void chooseSampleSong()
}

/** Opens the setup screen for a kind of video, empty. */
export function startSetup(kind: Kind): void {
  useSetup.setState(blank, true)
  setUi({ screen: 'setup', kind })
}

const AUDIO_NAME = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|weba)$/i
const VISUAL_NAME = /\.(mp4|m4v|mov|webm|mkv|png|jpe?g|webp|gif|avif)$/i

export const isAudioFile = (f: File) => f.type.startsWith('audio/') || (!f.type && AUDIO_NAME.test(f.name))
export const isVisualFile = (f: File) =>
  f.type.startsWith('video/') || f.type.startsWith('image/') || (!f.type && VISUAL_NAME.test(f.name))

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** A draft project with the song, so its analysis runs now and is stored with the project opened later. */
async function loadDraft(song: Asset, name: string, analysis?: TemplateInput['analysis']): Promise<void> {
  const kind = getUi().kind
  await loadSetupDraft(createFromTemplate(kind, { name, song, ...(analysis ? { analysis } : {}) }))
}

const isCurrent = (song: SetupSong) => useSetup.getState().song === song

/** Uses a song file: copies it into browser storage, then finds its beats and sections. */
export async function chooseSong(file: File): Promise<void> {
  if (!isAudioFile(file)) {
    update({ songError: `“${file.name}” isn’t an audio file. Choose an MP3, WAV, FLAC, M4A or OGG file.` })
    return
  }
  const adding: SetupSong = {
    status: 'adding',
    name: file.name,
    title: baseName(file.name),
    analysis: 'running',
  }
  update({ song: adding, songError: null })
  const { assets, failed } = await storeFiles([file])
  if (!isCurrent(adding)) return
  const asset = assets[0]
  if (!asset) {
    update({
      song: null,
      songError: `“${file.name}” couldn’t be added: ${failed[0]?.reason ?? 'unknown error'}`,
    })
    return
  }
  const ready: SetupSong = { ...adding, status: 'ready', asset }
  update({ song: ready })
  await loadDraft(asset, ready.title)
  const ok = await analyzeSong(asset)
  const now = useSetup.getState().song
  if (now?.asset?.id === asset.id) update({ song: { ...now, analysis: ok ? 'done' : 'failed' } })
}

/** Uses the sample song, which is already analyzed. */
export async function chooseSampleSong(): Promise<void> {
  const { asset, analysis, title } = sampleSong()
  update({
    song: { status: 'ready', name: asset.name, title, asset, sample: true, analysis: 'done' },
    songError: null,
  })
  await loadDraft(asset, title, analysis)
}

/** Adds clips and images for a beat-cut video: copies them into browser storage. */
export async function addFootage(files: File[]): Promise<void> {
  const visual = files.filter(isVisualFile)
  const skipped = files.length - visual.length
  update({ footageError: skipped ? 'Only video clips and images can be added here.' : null })
  if (!visual.length) return
  update((s) => ({ adding: s.adding + visual.length }))
  const { assets, failed } = await storeFiles(visual)
  update((s) => ({
    adding: Math.max(0, s.adding - visual.length),
    footage: [...s.footage, ...assets.filter((a) => !s.footage.some((f) => f.id === a.id))],
    ...(failed[0]
      ? {
          footageError:
            failed.length === 1
              ? `“${failed[0].file.name}” couldn’t be added: ${failed[0].reason}`
              : `${failed.length} files couldn’t be added. ${failed[0].reason}`,
        }
      : {}),
  }))
}

export function removeFootage(id: string): void {
  update((s) => ({ footage: s.footage.filter((a) => a.id !== id) }))
}

export interface SetupInput {
  /** The project's name (default: the template's). */
  name?: string
  song?: Asset
  analysis?: TemplateInput['analysis']
  /** Already timed lyrics (the sample song's), used when none were pasted. */
  timedLyrics?: LyricsDoc
  footage?: Asset[]
  lyrics?: string
  idea?: string
  visualizerStyle?: string
}

/** The project the setup screen opens: the kind's starter template with the song and everything else given. */
export function buildSetupProject(kind: VideoKind, input: SetupInput): Project {
  const lyrics = input.lyrics?.trim()
  const project = createFromTemplate(kind, {
    ...(input.name ? { name: input.name } : {}),
    ...(input.song ? { song: input.song } : {}),
    ...(input.analysis ? { analysis: input.analysis } : {}),
    ...(input.footage?.length ? { footage: input.footage } : {}),
    ...(lyrics ? { lyrics } : {}),
    ...(input.idea?.trim() ? { idea: input.idea.trim() } : {}),
    ...(input.visualizerStyle ? { visualizerStyle: input.visualizerStyle } : {}),
  })
  if (lyrics || !input.timedLyrics) return project
  const built = new ProjectEditor(project)
  built.dispatch({ type: 'lyrics.set', lyrics: input.timedLyrics })
  const rest = templateCommands(built.getProject())
  if (rest.length) built.dispatch(rest)
  return built.getProject()
}

/** What the inspector shows first: a visualizer video opens on its visualizer. */
function firstSelection(project: Project, kind: Kind): Selection {
  const trackId = kind === 'visualizer' ? templateState(project)?.tracks.visualizer : undefined
  const clip = trackId && Object.values(project.clips).find((c) => c.trackId === trackId)
  return clip ? { type: 'clip', id: clip.id } : { type: 'none' }
}

/**
 * Opens the editor with a new project of the setup screen's kind, with the song unless `withSong` is false ("Skip for
 * now"). A project with a song, lyrics, an idea or clips is kept right away; an AI video starts its draft.
 */
export async function openFromSetup(withSong = true): Promise<void> {
  const kind = getUi().kind
  const s = useSetup.getState()
  const song = withSong && s.song?.status === 'ready' ? s.song : undefined
  const asset = song?.asset
  const analysis = asset && editor.getProject().analysis.audio[asset.id]
  const input: SetupInput = {
    ...(song && asset ? { song: asset, name: song.title } : {}),
    ...(analysis ? { analysis } : {}),
    ...(song?.sample && kind === 'lyric' ? { timedLyrics: sampleSong().lyrics } : {}),
    ...(kind === 'lyric' ? { lyrics: s.lyrics } : {}),
    ...(kind === 'footage' ? { footage: s.footage } : {}),
    ...(kind === 'ai' ? { idea: s.idea } : {}),
    ...(kind === 'visualizer' ? { visualizerStyle: s.visualizerStyle } : {}),
  }
  const project = buildSetupProject(kind, input)
  const given = !!asset || !!input.lyrics?.trim() || !!input.idea?.trim() || !!input.footage?.length
  await startProject(project, {
    keep: given,
    fromDraft: !!asset && editor.getProject().assets[asset.id] !== undefined,
  })
  setUi({ ...editorPreset(kind), selection: firstSelection(project, kind) })
  maybeStartGuide()
  useSetup.setState(blank, true)
  if (kind === 'ai' && asset) draftFromSetup(s.idea)
}

/** The start screen's "Blank project". */
export async function openBlankProject(): Promise<void> {
  useSetup.setState(blank, true)
  setUi({ kind: 'blank' })
  await openFromSetup(false)
}
