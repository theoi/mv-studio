/**
 * Samples precomputed song analysis at timeline times for audio-reactive parameters. Everything is a pure function
 * of (project, time), with no state carried between frames, so scrubbing, preview and export agree exactly.
 */
import type {
  AudioAnalysis,
  AudioClip,
  AudioFeatures,
  AudioFeatureSource,
  Id,
  Project,
  Seconds,
  StemName,
} from '../model/types.ts'
import type { AudioFrame } from './types.ts'

export interface AudioSampler {
  /** Feature value in 0..1 at timeline `time`. `smoothing` 0..1 averages over up to 0.5 s of the past. */
  sample(source: AudioFeatureSource, time: Seconds, smoothing?: number, audioAssetId?: Id): number
  /** All features at `time` for the main song, for effect and generator shaders. */
  frame(time: Seconds): AudioFrame
}

const STEMS: StemName[] = ['vocals', 'drums', 'bass', 'other']
const SMOOTHING_WINDOW = 0.5
const SMOOTHING_TAPS = 8

function seriesAt(values: readonly number[], rate: number, assetTime: Seconds): number {
  if (values.length === 0) return 0
  const x = assetTime * rate
  if (x <= 0) return values[0] as number
  const i = Math.floor(x)
  if (i >= values.length - 1) return values[values.length - 1] as number
  const f = x - i
  return (values[i] as number) * (1 - f) + (values[i + 1] as number) * f
}

/** Index of the last event at or before t (events sorted ascending), or -1. */
function lastEventIndex(events: readonly number[], t: number): number {
  let lo = 0
  let hi = events.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((events[mid] as number) <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** 1 at an event, decaying exponentially afterwards. */
function pulse(events: readonly number[] | undefined, t: number, decay: number): number {
  if (!events || events.length === 0) return 0
  const i = lastEventIndex(events, t)
  if (i < 0) return 0
  return Math.exp(-(t - (events[i] as number)) / decay)
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function createAudioSampler(project: Project): AudioSampler {
  const clipsByAsset = new Map<Id, AudioClip[]>()
  const audibleTracks = new Set(project.tracks.filter((t) => t.kind === 'audio' && !t.muted).map((t) => t.id))
  for (const clip of Object.values(project.clips)) {
    if (clip.type !== 'audio' || !clip.enabled || !audibleTracks.has(clip.trackId)) continue
    const list = clipsByAsset.get(clip.assetId) ?? []
    list.push(clip)
    clipsByAsset.set(clip.assetId, list)
  }

  /** Maps a timeline time to the asset's own time through the clip that plays it, or null when it is not playing. */
  function assetTimeAt(assetId: Id, time: Seconds): Seconds | null {
    const clips = clipsByAsset.get(assetId)
    if (!clips) return null
    for (const c of clips) {
      if (time >= c.start && time < c.start + c.duration)
        return c.sourceStart + (time - c.start) * c.playbackRate
    }
    return null
  }

  function featuresFor(analysis: AudioAnalysis, stem?: StemName): AudioFeatures | undefined {
    return stem ? analysis.stemFeatures?.[stem] : analysis.features
  }

  function raw(
    source: AudioFeatureSource,
    analysis: AudioAnalysis,
    assetTime: Seconds,
    smoothing: number,
  ): number {
    switch (source.kind) {
      case 'loudness': {
        const f = featuresFor(analysis, source.stem)
        return f ? clamp01(seriesAt(f.loudness, f.rate, assetTime)) : 0
      }
      case 'band': {
        const f = featuresFor(analysis, source.stem)
        return f ? clamp01(seriesAt(bandColumn(f, source.band), f.rate, assetTime)) : 0
      }
      case 'onset':
        return pulse(featuresFor(analysis, source.stem)?.onsets, assetTime, 0.08 + smoothing * 0.4)
      case 'beat':
        return pulse(analysis.beats, assetTime, 0.12 + smoothing * 0.4)
      case 'downbeat':
        return pulse(analysis.downbeats, assetTime, 0.2 + smoothing * 0.6)
    }
  }

  // Band columns are extracted lazily per (features object, band) since bands are stored frame-major.
  const bandColumns = new WeakMap<AudioFeatures, Map<number, number[]>>()
  function bandColumn(f: AudioFeatures, band: number): number[] {
    let perFeatures = bandColumns.get(f)
    if (!perFeatures) {
      perFeatures = new Map()
      bandColumns.set(f, perFeatures)
    }
    let col = perFeatures.get(band)
    if (!col) {
      col = f.bands.map((frame) => frame[band] ?? 0)
      perFeatures.set(band, col)
    }
    return col
  }

  function sample(source: AudioFeatureSource, time: Seconds, smoothing = 0, audioAssetId?: Id): number {
    const assetId = audioAssetId ?? project.songAssetId
    if (!assetId) return 0
    const analysis = project.analysis.audio[assetId]
    if (!analysis) return 0
    const assetTime = assetTimeAt(assetId, time)
    if (assetTime === null) return 0
    const isPulse = source.kind === 'onset' || source.kind === 'beat' || source.kind === 'downbeat'
    if (smoothing <= 0 || isPulse) return raw(source, analysis, assetTime, smoothing)
    // Exponentially weighted average over the recent past (stateless, unlike a one-pole filter).
    const window = smoothing * SMOOTHING_WINDOW
    let sum = 0
    let weights = 0
    for (let k = 0; k < SMOOTHING_TAPS; k++) {
      const age = (window * k) / (SMOOTHING_TAPS - 1)
      const w = Math.exp((-3 * k) / (SMOOTHING_TAPS - 1))
      sum += w * raw(source, analysis, Math.max(0, assetTime - age), 0)
      weights += w
    }
    return sum / weights
  }

  function frame(time: Seconds): AudioFrame {
    const assetId = project.songAssetId
    const analysis = assetId ? project.analysis.audio[assetId] : undefined
    const assetTime = assetId ? assetTimeAt(assetId, time) : null
    const empty: AudioFrame = { loudness: 0, bands: [], onset: 0, beat: 0, downbeat: 0, stems: {} }
    if (!analysis || assetTime === null) return empty
    const f = analysis.features
    const bandCount = f?.bands[0]?.length ?? 0
    const out: AudioFrame = {
      loudness: f ? clamp01(seriesAt(f.loudness, f.rate, assetTime)) : 0,
      bands: f
        ? Array.from({ length: bandCount }, (_, b) => clamp01(seriesAt(bandColumn(f, b), f.rate, assetTime)))
        : [],
      onset: pulse(f?.onsets, assetTime, 0.08),
      beat: pulse(analysis.beats, assetTime, 0.12),
      downbeat: pulse(analysis.downbeats, assetTime, 0.2),
      stems: {},
    }
    for (const stem of STEMS) {
      const sf = analysis.stemFeatures?.[stem]
      if (!sf) continue
      const n = sf.bands[0]?.length ?? 0
      out.stems[stem] = {
        loudness: clamp01(seriesAt(sf.loudness, sf.rate, assetTime)),
        bands: Array.from({ length: n }, (_, b) => clamp01(seriesAt(bandColumn(sf, b), sf.rate, assetTime))),
      }
    }
    return out
  }

  return { sample, frame }
}
