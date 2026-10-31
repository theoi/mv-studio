import { useSyncExternalStore } from 'react'
import {
  DEFAULT_SETTINGS,
  loadBindings,
  localVjStore,
  MidiInputManager,
  type MidiDevice,
  type MidiStatus,
  type QuantizeSettings,
  type VjBindings,
  type VjSession,
  type VjSettings,
} from '../../vj/index.ts'

/** The VJ session while VJ mode is open, so Settings › VJ and MIDI changes reach it as well as the saved settings. */
let active: VjSession | null = null

export function setActiveVjSession(session: VjSession | null) {
  active = session
}

export function vjSettings(): VjSettings {
  return active?.getSnapshot().settings ?? { ...DEFAULT_SETTINGS, ...localVjStore()?.loadSettings() }
}

export function setVjQuantize(quantize: QuantizeSettings) {
  if (active) {
    active.setQuantize(quantize)
    return
  }
  const store = localVjStore()
  store?.saveSettings({ ...vjSettings(), quantize })
}

/** Which keys and MIDI controls play which pads. */
export function vjBindings(): VjBindings {
  return active?.getBindings() ?? loadBindings(localVjStore())
}

export function setVjBindings(bindings: VjBindings) {
  if (active) active.setBindings(bindings)
  else localVjStore()?.saveBindings(bindings)
}

let midi: MidiInputManager | null = null

/**
 * The app's one MIDI connection, shared by Settings › VJ and MIDI and VJ mode: connected in either, a controller
 * stays connected in both until the page reloads.
 */
export function vjMidi(): MidiInputManager {
  midi ??= new MidiInputManager()
  return midi
}

export interface VjMidiState {
  status: MidiStatus
  devices: MidiDevice[]
  error?: string
}

let midiState: VjMidiState | null = null

function currentMidiState(): VjMidiState {
  const m = vjMidi()
  if (midiState?.status !== m.status || midiState.devices !== m.devices || midiState.error !== m.error)
    midiState = { status: m.status, devices: m.devices, ...(m.error ? { error: m.error } : {}) }
  return midiState
}

/** The MIDI connection's status and devices, kept current. */
export function useVjMidi(): VjMidiState {
  return useSyncExternalStore((listener) => vjMidi().subscribe(listener), currentMidiState)
}

/** One controller: its input ports, which a browser can list as several devices ("… MIDI Port", "… DAW Port"). */
export interface MidiController {
  name: string
  manufacturer?: string
  ports: MidiDevice[]
}

const PORT_SUFFIX = /\s+(?:\S+\s+)?Port(?:\s*\d+)?$/i

export function midiControllers(devices: MidiDevice[]): MidiController[] {
  const out: MidiController[] = []
  for (const d of devices) {
    const name = d.name.replace(PORT_SUFFIX, '') || d.name
    const known = out.find((c) => c.name === name && c.manufacturer === d.manufacturer)
    if (known) known.ports.push(d)
    else out.push({ name, ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}), ports: [d] })
  }
  return out
}

/** The connected controllers in a few words: the first one's name, then "+N" for the others. */
export function midiDevicesLabel(devices: MidiDevice[]): string {
  const [first, ...others] = midiControllers(devices)
  if (!first) return 'None connected'
  return others.length ? `${first.name} +${others.length}` : first.name
}

const RECONNECT = 'Reconnect the controller, then try again.'

export function midiErrorText(error: string | undefined): string {
  const reason = error?.trim().replace(/\.$/, '')
  return reason ? `MIDI couldn’t start: ${reason}. ${RECONNECT}` : `MIDI couldn’t start. ${RECONNECT}`
}
