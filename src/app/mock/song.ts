/*
 * Raw mock song data for the design preview: section layout, an energy curve, waveform peaks and original
 * placeholder lyrics with word timing. ./demoProject.ts turns it into project analysis and lyrics.
 */

export type SectionKind = 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'outro'

interface MockSection {
  id: string
  label: string
  kind: SectionKind
  start: number
  end: number
}

interface MockWord {
  text: string
  start: number
  end: number
}

interface MockLine {
  id: string
  text: string
  start: number
  end: number
  words: MockWord[]
}

export const song = {
  title: 'Neon Skyline',
  artist: 'Lumen Drive',
  file: 'neon-skyline.wav',
  duration: 204,
  bpm: 120,
  meter: '4/4',
}

export const beatInterval = 60 / song.bpm
export const barInterval = beatInterval * 4

export const sections: MockSection[] = [
  { id: 's-intro', label: 'Intro', kind: 'intro', start: 0, end: 16 },
  { id: 's-v1', label: 'Verse 1', kind: 'verse', start: 16, end: 48 },
  { id: 's-pre', label: 'Pre-chorus', kind: 'pre', start: 48, end: 64 },
  { id: 's-c1', label: 'Chorus', kind: 'chorus', start: 64, end: 96 },
  { id: 's-v2', label: 'Verse 2', kind: 'verse', start: 96, end: 128 },
  { id: 's-c2', label: 'Chorus', kind: 'chorus', start: 128, end: 160 },
  { id: 's-bridge', label: 'Bridge', kind: 'bridge', start: 160, end: 184 },
  { id: 's-c3', label: 'Chorus', kind: 'chorus', start: 184, end: 196 },
  { id: 's-outro', label: 'Outro', kind: 'outro', start: 196, end: 204 },
]

const sectionEnergy: Record<SectionKind, number> = {
  intro: 0.28,
  verse: 0.45,
  pre: 0.62,
  chorus: 0.9,
  bridge: 0.38,
  outro: 0.22,
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function mockSectionAt(t: number): MockSection {
  return sections.find((s) => t >= s.start && t < s.end) ?? (sections[sections.length - 1] as MockSection)
}

/** Energy sampled every 0.25 s, 0..1, smoothed across section boundaries. */
export const energyRate = 4
export const energy: Float32Array = (() => {
  const n = Math.ceil(song.duration * energyRate)
  const out = new Float32Array(n)
  const r = rng(7)
  for (let i = 0; i < n; i++) {
    const t = i / energyRate
    const s = mockSectionAt(t)
    const p = (t - s.start) / (s.end - s.start)
    let e = sectionEnergy[s.kind]
    if (s.kind === 'pre') e += p * 0.18
    if (s.kind === 'intro') e += p * 0.12
    if (s.kind === 'outro') e -= p * 0.12
    out[i] = e + (r() - 0.5) * 0.06
  }
  const smooth = new Float32Array(n)
  const k = 6
  for (let i = 0; i < n; i++) {
    let sum = 0
    let c = 0
    for (let j = -k; j <= k; j++) {
      const v = out[i + j]
      if (v !== undefined) {
        sum += v
        c++
      }
    }
    smooth[i] = Math.max(0.05, Math.min(1, sum / c))
  }
  return smooth
})()

function mockEnergyAt(t: number): number {
  return energy[Math.max(0, Math.min(energy.length - 1, Math.floor(t * energyRate)))] ?? 0
}

/** Waveform peaks, 50 per second. In the real app these come from decoding the song. */
export const peakRate = 50
export const peaks: Float32Array = (() => {
  const n = Math.ceil(song.duration * peakRate)
  const out = new Float32Array(n)
  const r = rng(42)
  for (let i = 0; i < n; i++) {
    const t = i / peakRate
    const e = mockEnergyAt(t)
    const phase = (t % beatInterval) / beatInterval
    const kick = Math.exp(-phase * 7) * (e > 0.35 ? 0.55 : 0.25)
    const snare =
      (Math.floor(t / beatInterval) % 2 === 1 ? Math.exp(-phase * 9) * 0.25 : 0) * (e > 0.4 ? 1 : 0.4)
    const body = e * (0.45 + r() * 0.35)
    out[i] = Math.min(1, body * 0.8 + kick * e + snare)
  }
  return out
})()

function line(id: string, text: string, start: number, end: number): MockLine {
  const tokens = text.split(' ')
  const total = tokens.reduce((a, w) => a + w.length + 1.5, 0)
  let t = start
  const words = tokens.map((w) => {
    const d = ((w.length + 1.5) / total) * (end - start)
    const word = { text: w, start: t, end: t + d * 0.92 }
    t += d
    return word
  })
  return { id, text, start, end, words }
}

const chorusLines = (offset: number, prefix: string) => [
  line(`${prefix}-1`, 'Under the neon skyline', offset + 0.5, offset + 4.3),
  line(`${prefix}-2`, 'We come alive tonight', offset + 4.5, offset + 7.8),
  line(`${prefix}-3`, 'Under the neon skyline', offset + 8.5, offset + 12.3),
  line(`${prefix}-4`, 'Nothing to lose but light', offset + 12.5, offset + 15.8),
  line(`${prefix}-5`, 'Under the neon skyline', offset + 16.5, offset + 20.3),
  line(`${prefix}-6`, 'Hearts in overdrive', offset + 20.5, offset + 23.8),
  line(`${prefix}-7`, 'Under the neon skyline', offset + 24.5, offset + 28.3),
  line(`${prefix}-8`, 'We come alive', offset + 28.5, offset + 31.6),
]

export const lyrics: MockLine[] = [
  line('l-v1-1', 'City lights are calling out my name', 16.5, 23.5),
  line('l-v1-2', 'Every window flickers like a flame', 24.5, 31.5),
  line('l-v1-3', 'I keep running where the river meets the sky', 32.5, 39.5),
  line('l-v1-4', 'Counting heartbeats as the trains roll by', 40.5, 47.5),
  line('l-pre-1', 'Hold on, hold on', 48.5, 51.8),
  line('l-pre-2', "We're almost there", 52.5, 55.8),
  line('l-pre-3', 'Hold on, hold on', 56.5, 59.8),
  line('l-pre-4', 'Can you feel the air', 60.5, 63.6),
  ...chorusLines(64, 'l-c1'),
  line('l-v2-1', 'Paper moons are hanging on a wire', 96.5, 103.5),
  line('l-v2-2', 'Every echo burning like a fire', 104.5, 111.5),
  line('l-v2-3', 'Strangers singing on the overpass tonight', 112.5, 119.5),
  line('l-v2-4', 'Holding on to every borrowed light', 120.5, 127.5),
  ...chorusLines(128, 'l-c2'),
  line('l-br-1', 'And if the morning never comes', 161, 167),
  line('l-br-2', "We'll be the ones who stayed", 168, 174),
  line('l-br-3', 'Dancing where the static hums', 175, 183),
  line('l-c3-1', 'Under the neon skyline', 184.5, 188.3),
  line('l-c3-2', 'We come alive tonight', 188.5, 191.8),
]
