import { describe, expect, it } from 'vitest'
import {
  bindKey,
  bindMidi,
  defaultBindings,
  isBindableKey,
  keyForTarget,
  keyLabel,
  midiLabel,
  midiPresetOf,
  targetForKey,
  targetsForMidi,
  withMidiPreset,
  type MidiMessage,
} from '../../../src/vj/index.ts'

const note = (number: number, extra: Partial<MidiMessage> = {}): MidiMessage => ({
  type: 'noteon',
  channel: 1,
  number,
  value: 100,
  deviceId: 'dev',
  deviceName: 'Pad Controller',
  timeStamp: 0,
  ...extra,
})

describe('VJ bindings', () => {
  it('maps the three key rows and the transport keys', () => {
    const b = defaultBindings()
    expect(targetForKey(b, 'KeyQ', false)).toEqual({ kind: 'pad', row: 'clips', index: 0 })
    expect(targetForKey(b, 'KeyP', false)).toEqual({ kind: 'pad', row: 'clips', index: 9 })
    expect(targetForKey(b, 'KeyL', false)).toEqual({ kind: 'pad', row: 'effects', index: 8 })
    expect(targetForKey(b, 'Digit8', false)).toEqual({ kind: 'pad', row: 'looks', index: 7 })
    expect(targetForKey(b, 'KeyZ', true)).toEqual({ kind: 'transport', action: 'record' })
    expect(targetForKey(b, 'KeyZ', false)).toBeUndefined()
    // Shift with a pad key still plays the pad.
    expect(targetForKey(b, 'KeyR', true)).toEqual({ kind: 'pad', row: 'clips', index: 3 })
    expect(targetForKey(b, 'Space', false)).toEqual({ kind: 'transport', action: 'play' })
    expect(targetForKey(b, 'BracketRight', false)).toEqual({ kind: 'transport', action: 'bank-next' })
  })

  it('matches MIDI on any channel and device, and a learned control replaces the default for it', () => {
    let b = defaultBindings()
    expect(targetsForMidi(b, note(36))).toEqual([{ kind: 'pad', row: 'clips', index: 0 }])
    expect(targetsForMidi(b, note(44, { channel: 10 }))).toEqual([{ kind: 'pad', row: 'effects', index: 0 }])
    expect(targetsForMidi(b, { ...note(21), type: 'cc' })).toEqual([{ kind: 'knob', index: 0 }])
    b = bindMidi(
      b,
      { type: 'note', number: 36, channel: 1, device: 'Pad Controller' },
      { kind: 'pad', row: 'looks', index: 2 },
    )
    expect(targetsForMidi(b, note(36))).toEqual([{ kind: 'pad', row: 'looks', index: 2 }])
    expect(targetsForMidi(b, note(36, { deviceName: 'Other' }))).toEqual([])
    b = bindMidi(b, { type: 'note', number: 37 }, { kind: 'pad', row: 'clips', index: 5 })
    b = bindMidi(
      b,
      { type: 'note', number: 37, device: 'Pad Controller' },
      { kind: 'pad', row: 'looks', index: 0 },
    )
    expect(targetsForMidi(b, note(37))).toEqual([{ kind: 'pad', row: 'looks', index: 0 }])
  })

  it('learning a key moves it off its old target and the target off its old key', () => {
    const b = bindKey(defaultBindings(), 'KeyQ', { kind: 'pad', row: 'effects', index: 0 })
    expect(targetForKey(b, 'KeyQ', false)).toEqual({ kind: 'pad', row: 'effects', index: 0 })
    expect(targetForKey(b, 'KeyA', false)).toBeUndefined()
    expect(keyForTarget(b, { kind: 'pad', row: 'clips', index: 0 })).toBeUndefined()
  })

  it('labels keys and MIDI controls, and refuses keys the browser needs', () => {
    expect(['KeyQ', 'Digit1', 'Shift+KeyZ', 'BracketLeft', 'Escape'].map(keyLabel)).toEqual([
      'Q',
      '1',
      'Shift Z',
      '[',
      'Esc',
    ])
    expect(midiLabel({ type: 'note', number: 36 })).toBe('Note 36')
    expect(midiLabel({ type: 'cc', number: 21, channel: 2 })).toBe('CC 21 \u00B7 ch 2')
    expect(['F5', 'F12', 'Tab', 'MetaLeft'].some(isBindableKey)).toBe(false)
    expect(isBindableKey('KeyM')).toBe(true)
  })
})

describe('default MIDI mappings', () => {
  it('maps pad controllers from note 36 and keyboards from middle C, and keeps the keys', () => {
    const b = defaultBindings()
    expect(midiPresetOf(b)).toBe('pads')
    expect(targetsForMidi(b, note(36))).toEqual([{ kind: 'pad', row: 'clips', index: 0 }])
    const keys = withMidiPreset(b, 'keys')
    expect(midiPresetOf(keys)).toBe('keys')
    expect(keys.keys).toEqual(b.keys)
    expect(targetsForMidi(keys, note(60))).toEqual([{ kind: 'pad', row: 'clips', index: 0 }])
    expect(targetsForMidi(keys, note(68))).toEqual([{ kind: 'pad', row: 'effects', index: 0 }])
    expect(targetsForMidi(keys, note(36))).toEqual([])
  })

  it('is no default mapping once a control was mapped by hand', () => {
    const b = bindMidi(
      defaultBindings(),
      { type: 'note', number: 99 },
      { kind: 'pad', row: 'looks', index: 0 },
    )
    expect(midiPresetOf(b)).toBeNull()
  })
})
