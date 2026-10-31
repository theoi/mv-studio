import { describe, expect, it } from 'vitest'
import { midiControllers, midiDevicesLabel, midiErrorText } from '../../../src/app/state/vj.ts'

const device = (id: string, name: string, manufacturer = 'Novation') => ({ id, name, manufacturer })

describe('MIDI controller names', () => {
  it('groups the ports of one controller under its name', () => {
    const devices = [
      device('a', 'Launchkey Mini MK3 MIDI Port'),
      device('b', 'Launchkey Mini MK3 DAW Port'),
      device('c', 'MPD218', 'Akai'),
    ]
    expect(midiControllers(devices).map((c) => [c.name, c.ports.length])).toEqual([
      ['Launchkey Mini MK3', 2],
      ['MPD218', 1],
    ])
    expect(midiDevicesLabel(devices)).toBe('Launchkey Mini MK3 +1')
    expect(midiDevicesLabel(devices.slice(0, 2))).toBe('Launchkey Mini MK3')
    expect(midiDevicesLabel([])).toBe('None connected')
  })

  it('keeps controllers apart that only share a name', () => {
    const devices = [device('a', 'USB MIDI Port', 'One'), device('b', 'USB MIDI Port', 'Two')]
    expect(midiDevicesLabel(devices)).toBe('USB +1')
  })

  it('says what to do when MIDI could not start', () => {
    expect(midiErrorText('Platform dependent initialization failed.')).toBe(
      'MIDI couldn’t start: Platform dependent initialization failed. Reconnect the controller, then try again.',
    )
    expect(midiErrorText(undefined)).toBe('MIDI couldn’t start. Reconnect the controller, then try again.')
  })
})
