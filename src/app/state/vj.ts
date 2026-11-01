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
import type { PreviewController } from '../../engine/preview.ts'
import { loadVjMode } from '../preload.ts'
import { stagePreview } from '../screens/editor/stage.ts'
import { get, set, toastLoadFailed, useUi } from './ui.ts'

/** The VJ session while VJ mode is open, so Settings › VJ and MIDI changes reach it as well as the saved settings. */
let active: VjSession | null = null
/** VJ mode's live output, for its last frame on the way back to the editor (see leaveVj). */
let livePreview: PreviewController | null = null

export function setActiveVjSession(session: VjSession | null, preview: PreviewController | null = null) {
  active = session
  livePreview = preview
}

/** How long a stand-in frame stays over a stage after its own preview's first frame: with a software GPU, that
 * frame reaches the screen a few hundred ms after it is drawn. */
export const SHOWN_AFTER_MS = 400

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
 * screen until VJ mode's code has loaded: until then the screen's loading fallback would blank the whole window. If
 * the code can't load, the editor stays and says so; the next press tries again.
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
  void loadVjMode().then(
    () => {
      setEntering(false)
      if (get().screen === 'editor') set({ screen: 'vj' })
      else clearVjEntryFrame()
    },
    () => {
      setEntering(false)
      clearVjEntryFrame()
      if (get().screen === 'editor') toastLoadFailed('VJ mode')
    },
  )
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

/** VJ mode's last frame, or 'pending' while it is captured, for the editor's stage while its preview starts. */
let returnFrame: ImageBitmap | 'pending' | null = null
let returns = 0
const returnListeners = new Set<() => void>()

function setReturnFrame(frame: ImageBitmap | 'pending' | null) {
  if (frame === returnFrame) return
  if (returnFrame && returnFrame !== 'pending') returnFrame.close()
  returnFrame = frame
  for (const listener of returnListeners) listener()
}

export function subscribeVjReturnFrame(listener: () => void): () => void {
  returnListeners.add(listener)
  return () => returnListeners.delete(listener)
}

export function vjReturnFrame(): ImageBitmap | 'pending' | null {
  return returnFrame
}

export function clearVjReturnFrame() {
  setReturnFrame(null)
}

// Only for the stage right after leaving: dropped once the editor closes, shown or not.
useUi.subscribe((s, prev) => {
  if (prev.screen === 'editor' && s.screen !== 'editor') setReturnFrame(null)
})

/** How long leaving VJ mode waits for the live output's last frame before the editor opens without it. */
const RETURN_WAIT_MS = 250
/** Set while leaving waits for that frame, so another press does not start a second capture. */
let leaving = false

/**
 * Back to the editor from VJ mode. The live output stops, and VJ mode stays on screen until its last frame is
 * captured (about 150 ms with a software GPU, at most RETURN_WAIT_MS), so the editor opens with that frame on its
 * stage while its own preview starts, as entering does the other way. The editor then focuses its VJ button (see
 * takeVjButtonFocus).
 */
export function leaveVj() {
  if (leaving) return
  clearVjEntryFrame()
  focusVjButton = true
  const preview = livePreview
  if (!preview) {
    set({ screen: 'editor', playing: false })
    return
  }
  leaving = true
  preview.pause()
  const id = ++returns
  setReturnFrame('pending')
  const open = () => {
    if (!leaving) return
    leaving = false
    window.clearTimeout(timer)
    if (get().screen === 'vj') set({ screen: 'editor', playing: false })
  }
  const timer = window.setTimeout(open, RETURN_WAIT_MS)
  preview.captureFrame().then(
    (frame) => {
      open()
      if (id === returns && returnFrame === 'pending' && get().screen === 'editor') setReturnFrame(frame)
      else frame.close()
    },
    () => {
      open()
      if (id === returns && returnFrame === 'pending') setReturnFrame(null)
    },
  )
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
