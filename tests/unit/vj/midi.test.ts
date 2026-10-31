import { describe, expect, it } from 'vitest'
import {
  MidiInputManager,
  parseMidiData,
  type MidiAccessLike,
  type MidiInputPort,
  type MidiMessage,
} from '../../../src/vj/index.ts'

class FakePort implements MidiInputPort {
  state: 'connected' | 'disconnected' = 'connected'
  onmidimessage: MidiInputPort['onmidimessage'] = null
  readonly id: string
  readonly name: string
  constructor(id: string, name: string) {
    this.id = id
    this.name = name
  }
  send(bytes: number[], timeStamp: number) {
    this.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp })
  }
}

class FakeAccess implements MidiAccessLike {
  ports: FakePort[] = []
  onstatechange: ((event: unknown) => void) | null = null
  inputs = { forEach: (cb: (p: MidiInputPort) => void) => this.ports.forEach(cb) }
  change() {
    this.onstatechange?.({})
  }
}

describe('parseMidiData', () => {
  it('decodes notes (velocity 0 is a note-off) and control changes, and ignores the rest', () => {
    expect(parseMidiData([0x90, 36, 100])).toEqual({ type: 'noteon', channel: 1, number: 36, value: 100 })
    expect(parseMidiData([0x99, 36, 0])).toEqual({ type: 'noteoff', channel: 10, number: 36, value: 0 })
    expect(parseMidiData([0x81, 40, 64])).toEqual({ type: 'noteoff', channel: 2, number: 40, value: 64 })
    expect(parseMidiData([0xb0, 21, 127])).toEqual({ type: 'cc', channel: 1, number: 21, value: 127 })
    expect(parseMidiData([0xf8])).toBeNull()
    expect(parseMidiData([0xe0, 0, 64])).toBeNull()
  })
})

describe('MidiInputManager', () => {
  it('reports unsupported browsers and denied permission', async () => {
    expect(new MidiInputManager(undefined).status).toBe('unsupported')
    const denied = new MidiInputManager(() => Promise.reject(new DOMException('no', 'NotAllowedError')))
    expect(await denied.enable()).toBe('denied')
  })

  it('delivers messages with their timestamps and follows devices plugged in and out', async () => {
    const access = new FakeAccess()
    const first = new FakePort('a', 'Pads')
    access.ports.push(first)
    const midi = new MidiInputManager(() => Promise.resolve(access))
    const messages: MidiMessage[] = []
    const gone: string[] = []
    midi.onMessage((m) => messages.push(m))
    midi.onDisconnect((d) => gone.push(d.name))
    expect(await midi.enable()).toBe('ready')
    expect(midi.devices.map((d) => d.name)).toEqual(['Pads'])
    first.send([0x90, 36, 64], 1234.5)
    expect(messages).toEqual([
      {
        type: 'noteon',
        channel: 1,
        number: 36,
        value: 64,
        deviceId: 'a',
        deviceName: 'Pads',
        timeStamp: 1234.5,
      },
    ])

    const second = new FakePort('b', 'Knobs')
    access.ports.push(second)
    access.change()
    expect(midi.devices.map((d) => d.name)).toEqual(['Pads', 'Knobs'])
    second.send([0xb0, 21, 10], 2000)
    expect(messages.at(-1)?.deviceName).toBe('Knobs')

    first.state = 'disconnected'
    access.change()
    expect(gone).toEqual(['Pads'])
    expect(midi.devices.map((d) => d.name)).toEqual(['Knobs'])
    expect(first.onmidimessage).toBeNull()
  })
})
