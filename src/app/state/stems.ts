import type { StemsEstimate, StemSeparationService, StemStore } from '../../analysis/stems/client.ts'
import {
  STEM_NAMES,
  type AudioFeatures,
  type Project,
  type StemName,
  type Track,
  type TrackStems,
} from '../../model/index.ts'
import { JobError } from '../../shared/jobs.ts'
import { isRunning, JOB_KINDS } from './jobs.ts'
import { dispatch, editor } from './project.ts'
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

/* ---------- stem mute and solo: Track.stems on the song's track, honored by preview and export ---------- */

export const STEM_LABELS: Record<StemName, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other',
}

/** The audio track that plays the song: the track of the first audio clip of the song asset. */
export function songStemTrack(project: Project): Track | undefined {
  const songId = project.songAssetId
  if (!songId) return undefined
  const clip = Object.values(project.clips).find((c) => c.type === 'audio' && c.assetId === songId)
  return clip && project.tracks.find((t) => t.id === clip.trackId && t.kind === 'audio')
}

/** The stems the song has been separated into, in the usual order. */
export function separatedStems(project: Project): StemName[] {
  const stems = project.songAssetId ? project.analysis.audio[project.songAssetId]?.stems : undefined
  return stems ? STEM_NAMES.filter((name) => stems[name]) : []
}

/** Stem mute and solo that change what the song sounds like, or null when none does. */
export interface StemMix {
  solo: StemName[]
  muted: StemName[]
}

/**
 * The song track's stem flags that take effect: only stems the song has separated (and whose audio is in the
 * project), like the mix itself. Null when the song has no separated stems or no flag is set.
 */
export function stemMix(project: Project): StemMix | null {
  const track = songStemTrack(project)
  const separated = project.songAssetId ? project.analysis.audio[project.songAssetId]?.stems : undefined
  if (!track?.stems || !separated) return null
  const flags = track.stems
  const present = STEM_NAMES.filter((name) => {
    const id = separated[name]
    return id !== undefined && project.assets[id] !== undefined
  })
  const solo = present.filter((name) => flags[name]?.solo)
  const muted = present.filter((name) => flags[name]?.muted)
  return solo.length || muted.length ? { solo, muted } : null
}

/** "Only the other plays" does not read as a stem, so sentences say "the other stem". */
const SENTENCE_NAMES: Record<StemName, string> = {
  vocals: 'vocals',
  drums: 'drums',
  bass: 'bass',
  other: 'other stem',
}

/** "the vocals", "the vocals and bass", "the vocals, drums and bass". */
export function stemList(names: readonly StemName[]): string {
  const words = names.map((n) => SENTENCE_NAMES[n])
  const last = words.pop() ?? ''
  return `the ${words.length ? `${words.join(', ')} and ${last}` : last}`
}

const singular = (names: readonly StemName[]) =>
  names.length === 1 && (names[0] === 'bass' || names[0] === 'other')

/** Header badge of the song track: "Stems: vocals solo · drums muted". */
export function stemBadgeText(mix: StemMix): string {
  const part = (names: StemName[], what: string) =>
    names.length ? `${names.map((n) => STEM_LABELS[n].toLowerCase()).join(', ')} ${what}` : ''
  return `Stems: ${[part(mix.solo, 'solo'), part(mix.muted, 'muted')].filter(Boolean).join(' · ')}`
}

/** Assist › Stems note: what plays, in the preview and the export. */
export function stemNoteText(mix: StemMix): string {
  const muted = mix.muted.length
    ? `${capitalize(stemList(mix.muted))} ${singular(mix.muted) ? 'is' : 'are'} muted`
    : ''
  if (!mix.solo.length) return `${muted}, in the preview and the export.`
  const only = `Only ${stemList(mix.solo)} ${singular(mix.solo) ? 'plays' : 'play'}, in the preview and the export.`
  return muted ? `${only} ${muted}.` : only
}

/** Export dialog warning. */
export function stemExportWarning(mix: StemMix): string {
  const muted = `${capitalize(stemList(mix.muted))} ${singular(mix.muted) ? 'is' : 'are'} muted in this export.`
  if (!mix.solo.length) return muted
  const only = `Only ${stemList(mix.solo)} will play in this export`
  return mix.muted.length ? `${only}, without ${stemList(mix.muted)}.` : `${only}.`
}

/** The one-click fix next to the export warning. */
export function stemFixLabel(mix: StemMix): string {
  if (mix.solo.length && mix.muted.length) return 'Play all stems'
  return mix.solo.length ? 'Unsolo' : 'Unmute'
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The song track's stem flags after toggling one, without entries that end up with no flag. */
export function toggledStems(
  stems: TrackStems | undefined,
  name: StemName,
  flag: 'muted' | 'solo',
): TrackStems {
  const next: TrackStems = { ...stems }
  const entry = { ...next[name] }
  if (entry[flag]) delete entry[flag]
  else entry[flag] = true
  if (entry.muted || entry.solo) next[name] = entry
  else delete next[name]
  return next
}

/** Mutes or solos one stem of the song, as one undo step ("Solo vocals", "Unmute drums"). */
export function toggleStem(name: StemName, flag: 'muted' | 'solo'): void {
  const track = songStemTrack(editor.getProject())
  if (!track) return
  const on = !track.stems?.[name]?.[flag]
  const verb = flag === 'solo' ? (on ? 'Solo' : 'Unsolo') : on ? 'Mute' : 'Unmute'
  dispatch(
    { type: 'track.update', trackId: track.id, patch: { stems: toggledStems(track.stems, name, flag) } },
    { label: `${verb} ${STEM_LABELS[name].toLowerCase()}` },
  )
}

/** Undo label for clearing the stem flags: "Unsolo stems", "Unmute stems" or "Play all stems". */
export function resetStemsLabel(stems: TrackStems | undefined): string {
  const flags = Object.values(stems ?? {})
  const solo = flags.some((f) => f?.solo)
  const muted = flags.some((f) => f?.muted)
  if (solo && muted) return 'Play all stems'
  return solo ? 'Unsolo stems' : 'Unmute stems'
}

/** Clears every stem mute and solo of the song track, as one undo step. */
export function resetStems(): void {
  const track = songStemTrack(editor.getProject())
  if (!track?.stems || !Object.values(track.stems).some((f) => f?.muted || f?.solo)) return
  dispatch(
    { type: 'track.update', trackId: track.id, patch: { stems: {} } },
    { label: resetStemsLabel(track.stems) },
  )
}
