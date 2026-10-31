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
