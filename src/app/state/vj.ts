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
import { loadVjMode } from '../preload.ts'
import { stagePreview } from '../screens/editor/stage.ts'
import { get, set } from './ui.ts'

/** The VJ session while VJ mode is open, so Settings › VJ and MIDI changes reach it as well as the saved settings. */
let active: VjSession | null = null

export function setActiveVjSession(session: VjSession | null) {
  active = session
}

let entryFrame: ImageBitmap | null = null
const entryListeners = new Set<() => void>()
let focusVjButton = false
/** Set while VJ mode's code loads (see enterVj), so another press does not start a second entry. */
let entering = false
const enteringListeners = new Set<() => void>()

function setEntering(value: boolean) {
  if (value === entering) return
  entering = value
  for (const listener of enteringListeners) listener()
}

function subscribeEntering(listener: () => void): () => void {
  enteringListeners.add(listener)
  return () => enteringListeners.delete(listener)
}

/** True from a press until VJ mode's code has loaded and the screen switches, for the VJ button's busy state. */
export function useVjEntering(): boolean {
  return useSyncExternalStore(subscribeEntering, () => entering)
}

function setEntryFrame(frame: ImageBitmap | null) {
  if (frame === entryFrame) return
  entryFrame?.close()
  entryFrame = frame
  for (const listener of entryListeners) listener()
}

/**
 * Opens VJ mode, capturing the editor's frame at the playhead on the way (its preview finishes the capture as it
 * closes) for the VJ stage to show while its own preview starts, which takes a second or two. The editor stays on
 * screen until VJ mode's code has loaded: until then the screen's loading fallback would blank the whole window.
 */
export function enterVj() {
  if (get().screen === 'vj' || entering) return
  setEntering(true)
  setEntryFrame(null)
  const capture = stagePreview()?.captureFrame()
  capture?.then(
    (frame) => {
      if (entering || get().screen === 'vj') setEntryFrame(frame)
      else frame.close()
    },
    () => undefined,
  )
  void loadVjMode()
    .catch(() => undefined)
    .then(() => {
      setEntering(false)
      if (get().screen === 'editor') set({ screen: 'vj' })
      else clearVjEntryFrame()
    })
}

export function subscribeVjEntryFrame(listener: () => void): () => void {
  entryListeners.add(listener)
  return () => entryListeners.delete(listener)
}

/** The editor's frame from when VJ mode opened (see enterVj), until VJ mode drops it. */
export function vjEntryFrame(): ImageBitmap | null {
  return entryFrame
}

export function clearVjEntryFrame() {
  setEntryFrame(null)
}

/** Back to the editor from VJ mode; the editor then focuses its VJ button (see takeVjButtonFocus). */
export function leaveVj() {
  clearVjEntryFrame()
  focusVjButton = true
  set({ screen: 'editor', playing: false })
}

/** True once after leaving VJ mode, for the editor to put focus back on the VJ button. */
export function takeVjButtonFocus(): boolean {
  const focus = focusVjButton
  focusVjButton = false
  return focus
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
