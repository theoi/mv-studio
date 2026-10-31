/**
 * Samples precomputed song analysis at timeline times for audio-reactive parameters. Everything is a pure function
 * of (project, time), with no state carried between frames, so scrubbing, preview and export agree exactly.
 */
import {
  STEM_NAMES,
  type AudioAnalysis,
  type AudioClip,
  type AudioFeatures,
  type AudioFeatureSource,
  type Clip,
  type Id,
  type Project,
  type Seconds,
  type StemName,
} from '../model/types.ts'
import type { AudioFrame } from './types.ts'

export interface AudioSampler {
  /** Feature value in 0..1 at timeline `time`. `smoothing` 0..1 averages over up to 0.5 s of the past. */
  sample(source: AudioFeatureSource, time: Seconds, smoothing?: number, audioAssetId?: Id): number
  /** All features at `time` for the main song, for effect and generator shaders. */
  frame(time: Seconds): AudioFrame
  /**
   * The same, with loudness, bands, onsets and flow from one stem of the song: in frame(), and in sample() for sources
   * that name no stem. The beat and bar grid stay the song's. Where the stem has not been separated, the full mix.
   */
  stem(name: StemName): AudioSampler
}

/** The sampler for everything reactive on a clip: a generator clip's audio source, else the song's mix. */
export function clipSampler(audio: AudioSampler, clip: Clip): AudioSampler {
  return clip.type === 'generator' && clip.audio ? audio.stem(clip.audio.stem) : audio
}
const SMOOTHING_WINDOW = 0.5
const SMOOTHING_TAPS = 8
const FALLBACK_BPM = 120
const BEATS_PER_BAR = 4
/** Flow speed (loudness units per second) used when there is no loudness analysis. */
const FALLBACK_FLOW_RATE = 0.5

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

/**
 * Continuous position on an event grid (beats or downbeats) at time t: k at events[k], interpolated between events and
 * extrapolated with the nearest interval outside them. Null when there are fewer than two events.
 */
export function gridPosition(events: readonly number[] | undefined, t: number): number | null {
  if (!events || events.length < 2) return null
  const n = events.length
  const i = lastEventIndex(events, t)
  const at = (k: number) => events[k] as number
  if (i < 0) return (t - at(0)) / Math.max(at(1) - at(0), 1e-3)
  if (i >= n - 1) return n - 1 + (t - at(n - 1)) / Math.max(at(n - 1) - at(n - 2), 1e-3)
  return i + (t - at(i)) / Math.max(at(i + 1) - at(i), 1e-3)
}

/** Running integral of a uniformly sampled series: out[k] = sum of values[0..k-1] / rate. */
function prefixSums(values: readonly number[], rate: number): Float64Array {
  const out = new Float64Array(values.length + 1)
  for (let k = 0; k < values.length; k++)
    out[k + 1] = (out[k] as number) + clamp01(values[k] as number) / rate
  return out
}

/** Integral of the series from 0 to t, holding the last value past the end. */
function integralAt(values: readonly number[], sums: Float64Array, rate: number, t: number): number {
  if (values.length === 0 || t <= 0) return 0
  const x = t * rate
  const i = Math.floor(x)
  if (i >= values.length)
    return (
      (sums[values.length] as number) +
      ((x - values.length) * clamp01(values[values.length - 1] as number)) / rate
    )
  return (sums[i] as number) + ((x - i) * clamp01(values[i] as number)) / rate
}

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

  /** A source's own stem; else the sampler's stem where it was separated; else the full mix. */
  function featuresFor(
    analysis: AudioAnalysis,
    stem?: StemName,
    preferred?: StemName,
  ): AudioFeatures | undefined {
    if (stem) return analysis.stemFeatures?.[stem]
    return (preferred && analysis.stemFeatures?.[preferred]) || analysis.features
  }

  function raw(
    source: AudioFeatureSource,
    analysis: AudioAnalysis,
    assetTime: Seconds,
    smoothing: number,
    preferred: StemName | undefined,
  ): number {
    switch (source.kind) {
      case 'loudness': {
        const f = featuresFor(analysis, source.stem, preferred)
        return f ? clamp01(seriesAt(f.loudness, f.rate, assetTime)) : 0
      }
      case 'band': {
        const f = featuresFor(analysis, source.stem, preferred)
        return f ? clamp01(seriesAt(bandColumn(f, source.band), f.rate, assetTime)) : 0
      }
      case 'onset':
        return pulse(featuresFor(analysis, source.stem, preferred)?.onsets, assetTime, 0.08 + smoothing * 0.4)
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

  function sample(
    source: AudioFeatureSource,
    time: Seconds,
    smoothing: number,
    audioAssetId: Id | undefined,
    preferred: StemName | undefined,
  ): number {
    const assetId = audioAssetId ?? project.songAssetId
    if (!assetId) return 0
    const analysis = project.analysis.audio[assetId]
    if (!analysis) return 0
    const assetTime = assetTimeAt(assetId, time)
    if (assetTime === null) return 0
    const isPulse = source.kind === 'onset' || source.kind === 'beat' || source.kind === 'downbeat'
    if (smoothing <= 0 || isPulse) return raw(source, analysis, assetTime, smoothing, preferred)
    // Exponentially weighted average over the recent past (stateless, unlike a one-pole filter).
    const window = smoothing * SMOOTHING_WINDOW
    let sum = 0
    let weights = 0
    for (let k = 0; k < SMOOTHING_TAPS; k++) {
      const age = (window * k) / (SMOOTHING_TAPS - 1)
      const w = Math.exp((-3 * k) / (SMOOTHING_TAPS - 1))
      sum += w * raw(source, analysis, Math.max(0, assetTime - age), 0, preferred)
      weights += w
    }
    return sum / weights
  }

  /**
   * The song's own time at a timeline time, extrapolated through the nearest song clip when the song is not playing,
   * so grid and flow positions continue smoothly across gaps. Null without a song clip.
   */
  function extrapolatedAssetTime(assetId: Id, time: Seconds): Seconds | null {
    const clips = clipsByAsset.get(assetId)
    if (!clips || clips.length === 0) return null
    let best = clips[0] as AudioClip
    let bestGap = Infinity
    for (const c of clips) {
      const gap =
        time < c.start ? c.start - time : time >= c.start + c.duration ? time - c.start - c.duration : 0
      if (gap < bestGap) {
        best = c
        bestGap = gap
      }
    }
    return best.sourceStart + (time - best.start) * best.playbackRate
  }

  const flowSums = new WeakMap<AudioFeatures, Float64Array>()
  function flowAt(f: AudioFeatures, t: Seconds): number {
    let sums = flowSums.get(f)
    if (!sums) {
      sums = prefixSums(f.loudness, f.rate)
      flowSums.set(f, sums)
    }
    return integralAt(f.loudness, sums, f.rate, t)
  }

  /** Beat and bar grid positions, and flow of `f`, at a song time. Pure: no state carried between frames. */
  function motion(analysis: AudioAnalysis | undefined, f: AudioFeatures | undefined, t: Seconds) {
    const period = 60 / (analysis?.tempo?.bpm && analysis.tempo.bpm > 0 ? analysis.tempo.bpm : FALLBACK_BPM)
    const beats = analysis?.beats
    const beatPos = gridPosition(beats, t) ?? (t - (beats?.[0] ?? 0)) / period
    let barPos = gridPosition(analysis?.downbeats, t)
    if (barPos === null) {
      const first = analysis?.downbeats?.[0]
      const offset =
        first !== undefined ? (gridPosition(beats, first) ?? (first - (beats?.[0] ?? 0)) / period) : 0
      barPos = (beatPos - offset) / BEATS_PER_BAR
    }
    const beatIndex = Math.floor(beatPos)
    const barIndex = Math.floor(barPos)
    return {
      beatIndex,
      beatPhase: beatPos - beatIndex,
      barIndex,
      barPhase: barPos - barIndex,
      flow: f && f.loudness.length > 0 ? flowAt(f, t) : Math.max(0, t) * FALLBACK_FLOW_RATE,
    }
  }

  function frame(time: Seconds, preferred: StemName | undefined): AudioFrame {
    const assetId = project.songAssetId
    const analysis = assetId ? project.analysis.audio[assetId] : undefined
    const assetTime = assetId ? assetTimeAt(assetId, time) : null
    const motionTime = (assetId ? extrapolatedAssetTime(assetId, time) : null) ?? time
    const f = analysis && featuresFor(analysis, undefined, preferred)
    const silent = { loudness: 0, bands: [], onset: 0, beat: 0, downbeat: 0, stems: {} }
    if (!analysis || assetTime === null) return { ...silent, ...motion(analysis, f, motionTime) }
    const bandCount = f?.bands[0]?.length ?? 0
    const out: AudioFrame = {
      loudness: f ? clamp01(seriesAt(f.loudness, f.rate, assetTime)) : 0,
      bands: f
        ? Array.from({ length: bandCount }, (_, b) => clamp01(seriesAt(bandColumn(f, b), f.rate, assetTime)))
        : [],
      onset: pulse(f?.onsets, assetTime, 0.08),
      beat: pulse(analysis.beats, assetTime, 0.12),
      downbeat: pulse(analysis.downbeats, assetTime, 0.2),
      ...motion(analysis, f, assetTime),
      stems: {},
    }
    for (const stem of STEM_NAMES) {
      const sf = analysis.stemFeatures?.[stem]
      if (!sf) continue
      const n = sf.bands[0]?.length ?? 0
      out.stems[stem] = {
        loudness: clamp01(seriesAt(sf.loudness, sf.rate, assetTime)),
        bands: Array.from({ length: n }, (_, b) => clamp01(seriesAt(bandColumn(sf, b), sf.rate, assetTime))),
        onset: pulse(sf.onsets, assetTime, 0.08),
      }
    }
    return out
  }

  const views = new Map<StemName | undefined, AudioSampler>()
  function view(preferred: StemName | undefined): AudioSampler {
    let v = views.get(preferred)
    if (!v) {
      v = {
        sample: (source, time, smoothing = 0, audioAssetId) =>
          sample(source, time, smoothing, audioAssetId, preferred),
        frame: (time) => frame(time, preferred),
        stem: view,
      }
      views.set(preferred, v)
    }
    return v
  }
  return view(undefined)
}
