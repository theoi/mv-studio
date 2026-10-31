import { fitSize, layerMatrix } from '../../../engine/layout.ts'
import {
  FORMAT_LABELS,
  exportPreferences,
  framingOverrides,
  newOutput,
  sectionTeaserRange,
  setFramingCommand,
  setOutputsCommand,
  startExport,
  suggestedOutputs,
  type FramingOverride,
  type OutputSpec,
  type PlannedOutput,
} from '../../../export/index.ts'
import type { AspectPreset, ImageClip, Project, VideoClip } from '../../../model/index.ts'
import { JobError, jobs } from '../../../shared/jobs.ts'
import { readSubjectTrack } from '../../../vision/analysisData.ts'
import { formatTime } from '../../format.ts'
import { downloadFile, showExport, useExports } from '../../state/exports.ts'
import { JOB_KINDS, runningJobs } from '../../state/jobs.ts'
import { appMedia } from '../../state/media.ts'
import { dispatch, editor } from '../../state/project.ts'
import { toast } from '../../state/ui.ts'

export interface OutputItem {
  spec: OutputSpec
  /** Included in the next export. */
  on: boolean
}

export const RATIO: Record<AspectPreset, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 }

const RESOLUTION_LABELS: Record<OutputSpec['resolution'], string> = {
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '1440p',
  '2160p': '4K',
}

/** The row title: what the output is, independent of its file name. */
export function outputTitle(project: Project, spec: Pick<OutputSpec, 'kind' | 'aspect'>): string {
  if (spec.kind === 'teaser') return 'Chorus teaser'
  if (spec.kind === 'loop') return 'Loop for Canvas'
  return spec.aspect === project.settings.aspect ? 'Full video' : FORMAT_LABELS[spec.aspect]
}

export function outputSummary(project: Project, spec: OutputSpec): string {
  if (spec.kind === 'teaser') return '15–30 s highlight of the chorus'
  if (spec.kind === 'loop') return 'Seamless 3–8 s vertical loop'
  return spec.aspect === project.settings.aspect
    ? 'The whole video as edited'
    : `${spec.aspect}, reframed to the subject`
}

export function specsLine(planned: PlannedOutput): string {
  const { spec, duration } = planned
  const length =
    spec.kind === 'teaser'
      ? `${Math.round(duration)} s`
      : spec.kind === 'loop'
        ? `${Math.round(duration)} s loop`
        : formatTime(duration)
  return `${spec.aspect} · ${RESOLUTION_LABELS[spec.resolution]} · ${spec.fps} fps · ${length}`
}

/** Outputs fill the same slot when they make the same kind of file (videos: in the same format). */
function sameSlot(a: OutputSpec, b: OutputSpec): boolean {
  return a.kind === b.kind && (a.kind !== 'video' || a.aspect === b.aspect)
}

/**
 * The dialog's starting list: the outputs saved with the project, else the suggested ones. With `teaserSection`,
 * the list's teaser (added when there is none) starts on that song section and comes first in `selected`.
 */
export function initialItems(
  project: Project,
  teaserSection: string | null = null,
): { items: OutputItem[]; selectedId: string | undefined } {
  const saved = exportPreferences(project).outputs
  const specs = saved?.length ? saved : suggestedOutputs(project).selected
  const items = specs.map((spec) => ({ spec, on: true }))
  const range = teaserSection ? sectionTeaserRange(project, teaserSection) : null
  if (!range) return { items, selectedId: items[0]?.spec.id }
  const existing = items.find((i) => i.spec.kind === 'teaser')
  const { maxLength: _auto, ...base } = existing?.spec ?? newOutput(project, 'teaser')
  const teaser = { spec: { ...base, range }, on: true }
  return {
    items: existing ? items.map((i) => (i === existing ? teaser : i)) : [...items, teaser],
    selectedId: teaser.spec.id,
  }
}

/** Every suggested output, for "Add another" (those already in the list are hidden). */
export function candidateOutputs(project: Project): OutputSpec[] {
  const { selected, more } = suggestedOutputs(project)
  return [...selected, ...more]
}

export function remainingCandidates(candidates: OutputSpec[], items: OutputItem[]): OutputSpec[] {
  return candidates.filter((c) => !items.some((i) => sameSlot(i.spec, c)))
}

/** A fresh output (with its own id) for a candidate. */
export function addCandidate(project: Project, candidate: OutputSpec): OutputSpec {
  return newOutput(project, candidate.kind, { aspect: candidate.aspect })
}

/** Changes the format, renaming the output when it still has the default name of its old format. */
export function withAspect(project: Project, spec: OutputSpec, aspect: AspectPreset): OutputSpec {
  const defaultName = (a: AspectPreset) => newOutput(project, spec.kind, { aspect: a }).name
  return { ...spec, aspect, name: spec.name === defaultName(spec.aspect) ? defaultName(aspect) : spec.name }
}

/** The moment shown for an output: the playhead for videos, just past the start (and its fade) for short ones. */
export function stillTime(planned: PlannedOutput, playhead: number): number {
  const { range, duration } = planned
  const t =
    planned.spec.kind === 'video'
      ? Math.min(Math.max(playhead, range.start), Math.max(range.start, range.end - 0.05))
      : range.start + Math.min(1.5, duration / 2)
  return Math.round(t * 100) / 100
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1e9
    ? `About ${(bytes / 1e9).toFixed(1)} GB`
    : `About ${Math.max(1, Math.round(bytes / 1e6))} MB`
}

export function timeLabel(seconds: number): string {
  return seconds < 60
    ? 'Under a minute on this device'
    : `About ${Math.round(seconds / 60)} min on this device`
}

/**
 * Saves the outputs with the project and renders them one after another in one job; every file downloads when the
 * job finishes. Returns false when another export is still running.
 */
export function startOutputs(project: Project, planned: PlannedOutput[]): boolean {
  if (runningJobs(jobs.list()).some((j) => j.kind === JOB_KINDS.export)) {
    toast('An export is already running. Wait for it to finish or cancel it first.')
    return false
  }
  const specs = planned.map((p) => p.spec)
  const saved = exportPreferences(project).outputs ?? null
  if (JSON.stringify(saved) !== JSON.stringify(specs))
    dispatch(setOutputsCommand(project, specs), { label: 'Save export outputs' })
  const handle = startExport(project, specs, {
    media: appMedia,
    onOutput: (result) => {
      useExports.setState((s) => ({ files: { ...s.files, [result.spec.id]: result.file } }))
      downloadFile(result.file, result.file.name)
    },
  })
  showExport(
    handle.id,
    planned.map((p) => ({
      id: p.spec.id,
      title: outputTitle(project, p.spec),
      aspect: p.spec.aspect,
      frames: p.frames,
    })),
  )
  handle.promise.then(
    (results) => {
      toast(
        results.length === 1
          ? `Saved ${results[0]?.file.name ?? 'the video'} to Downloads`
          : `Saved ${results.length} files to Downloads`,
      )
    },
    (error: unknown) => {
      if (error instanceof JobError && error.code === 'cancelled') return
      toast(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
  return true
}

export interface Shot {
  clipId: string
  start: number
  end: number
}

const RESHOT: ReadonlySet<string> = new Set(['reframed', 'centred', 'fit'])

/**
 * The footage shots an output reframes, within its range and in time order (topmost first where they overlap).
 * Behind-subject cutouts follow their host, so they are not shots of their own.
 */
export function shotsOf(project: Project, planned: PlannedOutput): Shot[] {
  const order = new Map(project.tracks.map((t, i) => [t.id, i]))
  const { start, end } = planned.range
  return Object.values(project.clips)
    .filter(
      (c) =>
        c.enabled &&
        !c.meta?.behindSubjectOf &&
        RESHOT.has(planned.framing[c.id] ?? '') &&
        c.start < end &&
        c.start + c.duration > start,
    )
    .sort((a, b) => a.start - b.start || (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
    .map((c) => ({ clipId: c.id, start: Math.max(start, c.start), end: Math.min(end, c.start + c.duration) }))
}

/**
 * The clips an output reframes, and how many of them subject analysis found no one in (auto framing keeps those
 * centered).
 */
export function subjectCounts(project: Project, planned: PlannedOutput): { clips: number; nobody: number } {
  const clips = new Set<string>()
  const nobody = new Set<string>()
  for (const { clipId } of shotsOf(project, planned)) {
    const clip = project.clips[clipId]
    if (clip?.type !== 'video' && clip?.type !== 'image') continue
    clips.add(clip.assetId)
    const track = readSubjectTrack(project.analysis.visual[clip.assetId])
    if (track?.samples.every((s) => s.source === 'none')) nobody.add(clip.assetId)
  }
  return { clips: clips.size, nobody: nobody.size }
}

/** A moment inside a shot that shows it (just past its first frame). */
export function shotTime(shot: Shot): number {
  return Math.round((shot.start + Math.min(0.5, (shot.end - shot.start) / 2)) * 100) / 100
}

export interface CropBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the output's frame sits in the project's frame for a reframed shot at `time`, as fractions with a
 * top-left origin: the source window the converted clip shows, measured against the window the original shows.
 */
export function cropBox(
  project: Project,
  planned: PlannedOutput,
  clipId: string,
  time: number,
): CropBox | null {
  const clip = project.clips[clipId]
  const out = planned.project.clips[clipId]
  if (!clip || !out || (clip.type !== 'video' && clip.type !== 'image')) return null
  if (out.type !== 'video' && out.type !== 'image') return null
  const asset = project.assets[clip.assetId]
  const W = asset?.width ?? 1920
  const H = asset?.height ?? 1080
  const local = time - clip.start
  const sourceWindow = (c: VideoClip | ImageClip, cw: number, ch: number) => {
    const [bw, bh] = fitSize(c.fit, W, H, cw, ch)
    const m = layerMatrix(c, local, time, bw, bh, cw, ch)
    return { u0: -m[4] / m[0], u1: (cw - m[4]) / m[0], v0: -m[5] / m[3], v1: (ch - m[5]) / m[3] }
  }
  const src = sourceWindow(clip, project.settings.width, project.settings.height)
  const dst = sourceWindow(out, planned.project.settings.width, planned.project.settings.height)
  const sw = src.u1 - src.u0
  const sh = src.v1 - src.v0
  if (!(sw > 0 && sh > 0)) return null
  return {
    left: (dst.u0 - src.u0) / sw,
    top: (dst.v0 - src.v0) / sh,
    width: (dst.u1 - dst.u0) / sw,
    height: (dst.v1 - dst.v0) / sh,
  }
}

/**
 * Sets (or with null clears) the framing of a shot in one format as one undo step, together with the cutouts that
 * put text behind its subject, so they stay aligned with it.
 */
export function adjustFraming(aspect: AspectPreset, clipId: string, patch: FramingOverride | null): void {
  const project = editor.getProject()
  const ids = [
    clipId,
    ...Object.values(project.clips)
      .filter((c) => c.meta?.behindSubjectOf === clipId)
      .map((c) => c.id),
  ]
  const coalesceKey = `framing:${clipId}:${Date.now()}`
  for (const id of ids) {
    const current = editor.getProject()
    const next = patch && { ...framingOverrides(current, aspect)[id], ...patch }
    dispatch(setFramingCommand(current, aspect, id, next), { label: 'Adjust framing', coalesceKey })
  }
  editor.endGesture()
}
