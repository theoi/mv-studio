/*
 * The sample song's arrangement as events (bars, drum hits, bass and lead notes) following the mock sections. The
 * synthesizer (./sampleSong.ts) plays it, and songFeatures() derives the analysis features (loudness, bands, onsets)
 * from the same events, so reactive visuals move with what is heard.
 */
import type { AudioFeatures } from '../../model/index.ts'
import { beatInterval, energy, energyRate, sections, song, type SectionKind } from './song.ts'

export const BAR = beatInterval * 4

/** Triads (pad voicing) and bass roots, in MIDI notes. */
const CHORDS = {
  Am: { pad: [57, 60, 64], root: 45 },
  F: { pad: [53, 57, 60], root: 41 },
  C: { pad: [55, 60, 64], root: 48 },
  G: { pad: [55, 59, 62], root: 43 },
  Em: { pad: [52, 55, 59], root: 40 },
} as const
type ChordName = keyof typeof CHORDS
export type Chord = (typeof CHORDS)[ChordName]

const PROGRESSIONS: Record<SectionKind, ChordName[]> = {
  intro: ['Am', 'F', 'C', 'G'],
  verse: ['Am', 'F', 'C', 'G'],
  pre: ['F', 'G', 'Em', 'Am'],
  chorus: ['F', 'G', 'Am', 'C'],
  bridge: ['F', 'C', 'G', 'Am'],
  outro: ['Am', 'F', 'C', 'G'],
}

const PAD_LEVEL: Record<SectionKind, number> = {
  intro: 0.2,
  verse: 0.13,
  pre: 0.15,
  chorus: 0.16,
  bridge: 0.22,
  outro: 0.18,
}

export interface Bar {
  start: number
  kind: SectionKind
  /** Bar number within its section. */
  local: number
  barsInSection: number
  chord: Chord
  energy: number
  /** Pad level and low-pass cutoff for the bar. */
  pad: number
  padCutoff: number
}

export type DrumKind = 'kick' | 'snare' | 'hat' | 'open-hat'

export interface DrumHit {
  kind: DrumKind
  t: number
  gain: number
}

export interface Note {
  t: number
  length: number
  midi: number
  peak: number
}

function energyAt(t: number): number {
  return energy[Math.max(0, Math.min(energy.length - 1, Math.floor(t * energyRate)))] ?? 0.4
}

function buildBars(): Bar[] {
  const out: Bar[] = []
  for (const s of sections) {
    const count = Math.round((s.end - s.start) / BAR)
    for (let local = 0; local < count; local++) {
      const start = s.start + local * BAR
      const e = energyAt(start + BAR / 2)
      let pad = PAD_LEVEL[s.kind]
      if (s.kind === 'outro') pad *= 1 - local / count
      if (s.kind === 'intro') pad *= 0.5 + (0.5 * local) / count
      out.push({
        start,
        kind: s.kind,
        local,
        barsInSection: count,
        chord: CHORDS[PROGRESSIONS[s.kind][local % 4] as ChordName],
        energy: e,
        pad,
        padCutoff: s.kind === 'intro' ? 500 + (1400 * local) / count : 900 + e * 1500,
      })
    }
  }
  return out
}

function buildDrums(list: Bar[]): DrumHit[] {
  const hits: DrumHit[] = []
  const hit = (kind: DrumKind, t: number, gain: number) => hits.push({ kind, t, gain })
  for (const bar of list) {
    const e = 0.75 + bar.energy * 0.35
    const k = bar.kind
    for (let beat = 0; beat < 4; beat++) {
      const t = bar.start + beat * beatInterval
      if (k === 'chorus' || k === 'pre') hit('kick', t, 0.95 * e)
      else if (k === 'verse' && (beat === 0 || beat === 2)) hit('kick', t, 0.85 * e)
      else if ((k === 'bridge' || (k === 'outro' && bar.local < 2)) && beat === 0) hit('kick', t, 0.7 * e)
      if ((k === 'verse' || k === 'pre' || k === 'chorus') && (beat === 1 || beat === 3))
        hit('snare', t, (k === 'chorus' ? 0.6 : 0.45) * e)
      if (k === 'chorus') {
        hit('open-hat', t + beatInterval / 2, 0.5 * e)
        hit('hat', t + beatInterval / 4, 0.22 * e)
        hit('hat', t + (3 * beatInterval) / 4, 0.22 * e)
      } else if (k === 'verse' || k === 'pre') hit('hat', t + beatInterval / 2, 0.32 * e)
      else if (k === 'intro' && bar.local >= 4) hit('hat', t + beatInterval / 2, 0.18)
    }
    // A snare roll into the chorus.
    if (k === 'pre' && bar.local === bar.barsInSection - 1)
      for (let i = 0; i < 8; i++) hit('snare', bar.start + BAR / 2 + (i * BAR) / 16, 0.18 + i * 0.05)
  }
  return hits.sort((a, b) => a.t - b.t)
}

function buildBass(list: Bar[]): Note[] {
  const notes: Note[] = []
  for (const { start, kind, chord } of list) {
    const root = chord.root
    if (kind === 'chorus' || kind === 'pre') {
      for (let i = 0; i < 8; i++)
        notes.push({
          t: start + i * (beatInterval / 2),
          length: beatInterval / 2,
          midi: kind === 'chorus' && i % 2 === 1 ? root + 12 : root,
          peak: 0.42,
        })
    } else if (kind === 'verse') {
      for (let i = 0; i < 4; i++)
        notes.push({ t: start + i * beatInterval, length: beatInterval * 0.9, midi: root, peak: 0.4 })
    } else if (kind === 'bridge') notes.push({ t: start, length: BAR, midi: root, peak: 0.3 })
  }
  return notes
}

const ARP = [0, 1, 2, 3, 2, 1, 2, 3]

function buildLead(list: Bar[]): Note[] {
  const notes: Note[] = []
  for (const { start, kind, chord } of list) {
    if (kind !== 'chorus') continue
    const tones = [chord.pad[0] + 12, chord.pad[1] + 12, chord.pad[2] + 12, chord.pad[0] + 24]
    for (let i = 0; i < 16; i++)
      notes.push({
        t: start + i * (beatInterval / 4),
        length: beatInterval / 4,
        midi: tones[ARP[i % 8] as number] as number,
        peak: 0.09,
      })
  }
  return notes
}

export interface Arrangement {
  bars: Bar[]
  drums: DrumHit[]
  bass: Note[]
  lead: Note[]
}

let built: Arrangement | null = null

export function arrangement(): Arrangement {
  if (!built) {
    const bars = buildBars()
    built = { bars, drums: buildDrums(bars), bass: buildBass(bars), lead: buildLead(bars) }
  }
  return built
}

const FEATURE_RATE = 50
/** The same bands as src/analysis: sub, bass, low mids, mids, high mids, presence, brilliance. */
const BAND_EDGES_HZ = [20, 60, 250, 500, 2000, 4000, 6000, 11025]

/** How much each sound excites each band, and how fast it decays (per second). */
const DRUM_SHAPE: Record<DrumKind, { bands: number[]; decay: number }> = {
  kick: { bands: [1, 0.85, 0.3, 0.1, 0, 0, 0], decay: 9 },
  snare: { bands: [0, 0.15, 0.45, 0.6, 0.7, 0.55, 0.4], decay: 16 },
  hat: { bands: [0, 0, 0, 0, 0.15, 0.55, 0.8], decay: 45 },
  'open-hat': { bands: [0, 0, 0, 0, 0.2, 0.6, 0.9], decay: 14 },
}
const BASS_BANDS = [0.5, 1, 0.55, 0.15, 0, 0, 0]
const LEAD_BANDS = [0, 0, 0, 0.5, 0.9, 0.4, 0.1]
const PAD_BANDS = [0, 0.2, 0.7, 0.9, 0.55, 0.25, 0.1]

let features: AudioFeatures | null = null

/** Loudness, band levels (0..1) and onsets at 50 frames per second, as src/analysis stores them. */
export function songFeatures(): AudioFeatures {
  if (features) return features
  const { bars, drums, bass, lead } = arrangement()
  const n = Math.ceil(song.duration * FEATURE_RATE)
  const bandCount = BAND_EDGES_HZ.length - 1
  const bands = Array.from({ length: n }, () => new Array<number>(bandCount).fill(0))
  const add = (from: number, seconds: number, shape: number[], level: (dt: number) => number) => {
    const i0 = Math.ceil(from * FEATURE_RATE)
    const i1 = Math.min(n, Math.ceil((from + seconds) * FEATURE_RATE))
    for (let i = i0; i < i1; i++) {
      const frame = bands[i] as number[]
      const v = level(i / FEATURE_RATE - from)
      for (let b = 0; b < bandCount; b++) frame[b] = (frame[b] as number) + (shape[b] as number) * v
    }
  }
  for (const bar of bars) add(bar.start, BAR, PAD_BANDS, () => bar.pad * 2.4)
  for (const h of drums)
    add(h.t, 0.4, DRUM_SHAPE[h.kind].bands, (dt) => h.gain * Math.exp(-dt * DRUM_SHAPE[h.kind].decay))
  for (const note of bass)
    add(note.t, note.length, BASS_BANDS, (dt) => note.peak * (0.55 + 0.45 * Math.exp(-dt * 12)))
  for (const note of lead) add(note.t, note.length, LEAD_BANDS, (dt) => note.peak * 4 * Math.exp(-dt * 14))

  // Normalize each band to its loud end so choruses reach near the top, like analyzed songs.
  const peaks = new Array<number>(bandCount).fill(0)
  for (let b = 0; b < bandCount; b++) {
    const sorted = bands.map((f) => f[b] as number).sort((x, y) => x - y)
    peaks[b] = Math.max(1e-6, sorted[Math.floor(sorted.length * 0.98)] as number)
  }
  const loudness: number[] = []
  for (const frame of bands) {
    let sum = 0
    for (let b = 0; b < bandCount; b++) {
      const v = Math.min(1, (frame[b] as number) / (peaks[b] as number))
      frame[b] = Math.round(v * 1000) / 1000
      sum += v
    }
    loudness.push(Math.round(Math.min(1, (sum / bandCount) * 1.7) * 1000) / 1000)
  }
  const onsets = drums.filter((h) => h.kind === 'kick' || h.kind === 'snare').map((h) => h.t)
  features = { rate: FEATURE_RATE, loudness, bands, bandEdgesHz: [...BAND_EDGES_HZ], onsets }
  return features
}
