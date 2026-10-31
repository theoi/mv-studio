/*
 * A synthesized stand-in for the sample project's song: the arrangement in ./arrangement.ts played by a handful of
 * long-lived Web Audio oscillators with automation (pads, bass, chorus arpeggio), rendered offline, plus drums
 * written directly into a buffer.
 */
import { arrangement, type Bar, type DrumHit, type Note } from './arrangement.ts'
import { song } from './song.ts'

const SAMPLE_RATE = 32_000

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12)

function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2147483648 - 1
  }
}

/** Gives the main thread a turn between chunks of synthesis work, so the UI stays responsive. */
const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const CHUNK_MS = 8

async function renderDrums(out: Float32Array, hits: DrumHit[]): Promise<void> {
  const rand = noise(9)
  const add = (at: number, seconds: number, gain: number, voice: (t: number) => number) => {
    const from = Math.round(at * SAMPLE_RATE)
    const n = Math.min(Math.round(seconds * SAMPLE_RATE), out.length - from)
    for (let i = 0; i < n; i++) out[from + i]! += gain * voice(i / SAMPLE_RATE)
  }
  let chunkStart = performance.now()
  for (const { kind, t, gain } of hits) {
    if (performance.now() - chunkStart > CHUNK_MS) {
      await yieldToMain()
      chunkStart = performance.now()
    }
    if (kind === 'kick') {
      let phase = 0
      add(t, 0.42, gain, (s) => {
        phase += (2 * Math.PI * (44 + 90 * Math.exp(-s * 32))) / SAMPLE_RATE
        return Math.sin(phase) * Math.exp(-s * 7.5) + (s < 0.004 ? 0.4 * (1 - s / 0.004) : 0)
      })
    } else if (kind === 'snare') {
      let prev = 0
      add(t, 0.24, gain, (s) => {
        const n = rand()
        const bright = n - prev
        prev = n
        return bright * 0.55 * Math.exp(-s * 18) + Math.sin(2 * Math.PI * 185 * s) * 0.5 * Math.exp(-s * 28)
      })
    } else {
      const open = kind === 'open-hat'
      let p1 = 0
      let p2 = 0
      add(t, open ? 0.18 : 0.05, gain, (s) => {
        const n = rand()
        const hp = n - 2 * p1 + p2
        p2 = p1
        p1 = n
        return hp * 0.35 * Math.exp(-s * (open ? 16 : 70))
      })
    }
  }
}

/** Quick attack, decay to a sustain level, release just before the note ends. */
function envelope(gain: AudioParam, note: Note, sustain: number, decay: number) {
  const { t, length, peak } = note
  gain.setValueAtTime(0, t)
  gain.linearRampToValueAtTime(peak, t + 0.006)
  gain.setTargetAtTime(peak * sustain, t + 0.006, decay)
  gain.setTargetAtTime(0, t + Math.max(0.02, length - 0.03), 0.012)
}

/** Low-pass filter into a gain, starting silent. */
function chain(ctx: OfflineAudioContext, out: AudioNode, q: number) {
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = q
  const gain = ctx.createGain()
  gain.gain.value = 0
  filter.connect(gain).connect(out)
  return { filter, gain }
}

function voice(ctx: OfflineAudioContext, out: AudioNode, type: OscillatorType, q: number) {
  const { filter, gain } = chain(ctx, out, q)
  const osc = ctx.createOscillator()
  osc.type = type
  osc.connect(filter)
  osc.start(0)
  return { osc, filter, gain }
}

function scheduleTonal(ctx: OfflineAudioContext, out: AudioNode, bars: Bar[], bass: Note[], lead: Note[]) {
  // Pads: three voices of two detuned saws through one low-pass, gently ducked at chord changes.
  const pad = chain(ctx, out, 0.6)
  const padVoices = [0, 1, 2].map(() =>
    [-7, 7].map((detune) => {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.detune.value = detune
      osc.connect(pad.filter)
      osc.start(0)
      return osc
    }),
  )
  for (const bar of bars) {
    bar.chord.pad.forEach((note, v) => {
      for (const osc of padVoices[v] ?? []) osc.frequency.setValueAtTime(midiHz(note), bar.start)
    })
    pad.gain.gain.setValueAtTime(bar.pad * 0.55, bar.start)
    pad.gain.gain.setTargetAtTime(bar.pad, bar.start, 0.12)
    pad.filter.frequency.setValueAtTime(bar.padCutoff, bar.start)
  }

  const bassVoice = voice(ctx, out, 'sawtooth', 3)
  for (const bar of bars) bassVoice.filter.frequency.setValueAtTime(320 + bar.energy * 900, bar.start)
  for (const note of bass) {
    bassVoice.osc.frequency.setValueAtTime(midiHz(note.midi), note.t)
    envelope(bassVoice.gain.gain, note, note.length > 1 ? 0.7 : 0.55, note.length > 1 ? 0.4 : 0.08)
  }

  const leadVoice = voice(ctx, out, 'square', 0.7)
  leadVoice.filter.frequency.value = 2600
  for (const note of lead) {
    leadVoice.osc.frequency.setValueAtTime(midiHz(note.midi), note.t)
    envelope(leadVoice.gain.gain, note, 0.3, 0.05)
  }
}

/** Peak-normalized and gently saturated, so the song sits near the loudness of released music. */
async function wav(samples: Float32Array, sampleRate: number): Promise<Blob> {
  let peak = 1e-6
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as number
    if (s > peak) peak = s
    else if (-s > peak) peak = -s
  }
  const drive = 2.2
  const shape = (x: number) => (Math.tanh((drive * x) / peak) / Math.tanh(drive)) * 0.89 * 32767
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  const pcm = new Int16Array(buffer, 44, samples.length)
  const step = 1 << 17
  for (let from = 0; from < samples.length; from += step) {
    const to = Math.min(samples.length, from + step)
    for (let i = from; i < to; i++) pcm[i] = Math.round(shape(samples[i] as number))
    await yieldToMain()
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Renders the sample song as a mono 16-bit WAV file. */
export async function synthesizeSong(): Promise<Blob> {
  const { bars, drums, bass, lead } = arrangement()
  const length = Math.ceil(song.duration * SAMPLE_RATE)
  const ctx = new OfflineAudioContext(1, length, SAMPLE_RATE)
  const bus = ctx.createGain()
  bus.connect(ctx.destination)

  const drumBuffer = ctx.createBuffer(1, length, SAMPLE_RATE)
  await renderDrums(drumBuffer.getChannelData(0), drums)
  const drumSource = ctx.createBufferSource()
  drumSource.buffer = drumBuffer
  drumSource.connect(bus)
  drumSource.start(0)

  scheduleTonal(ctx, bus, bars, bass, lead)
  const rendered = await ctx.startRendering()
  return wav(rendered.getChannelData(0), SAMPLE_RATE)
}
