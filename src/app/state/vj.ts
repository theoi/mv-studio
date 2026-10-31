import {
  DEFAULT_SETTINGS,
  localVjStore,
  type QuantizeSettings,
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

/** Connected MIDI controllers while VJ mode is open (access is asked for there). */
export function vjMidiDevices(): string {
  return (
    active
      ?.getSnapshot()
      .midi.devices.map((d) => d.name)
      .join(', ') || 'None connected'
  )
}

export function setVjQuantize(quantize: QuantizeSettings) {
  if (active) {
    active.setQuantize(quantize)
    return
  }
  const store = localVjStore()
  store?.saveSettings({ ...vjSettings(), quantize })
}
