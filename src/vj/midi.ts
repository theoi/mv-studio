/**
 * Web MIDI input: device discovery with hot-plug, and note and control-change messages with their arrival time
 * (performance.now() time base, so they can be latency-compensated like key presses).
 */

export interface MidiMessage {
  type: 'noteon' | 'noteoff' | 'cc'
  /** 1..16 */
  channel: number
  /** Note or controller number, 0..127. */
  number: number
  /** Velocity or controller value, 0..127. */
  value: number
  deviceId: string
  deviceName: string
  /** When the message arrived, in performance.now() milliseconds. */
  timeStamp: number
}

/** Decodes note on/off and control change; other messages (clock, sysex, pitch bend) return null. */
export function parseMidiData(
  data: ArrayLike<number> | null | undefined,
): Pick<MidiMessage, 'type' | 'channel' | 'number' | 'value'> | null {
  if (!data || data.length < 3) return null
  const status = (data[0] as number) & 0xf0
  const channel = ((data[0] as number) & 0x0f) + 1
  const number = (data[1] as number) & 0x7f
  const value = (data[2] as number) & 0x7f
  if (status === 0x90) return { type: value > 0 ? 'noteon' : 'noteoff', channel, number, value }
  if (status === 0x80) return { type: 'noteoff', channel, number, value }
  if (status === 0xb0) return { type: 'cc', channel, number, value }
  return null
}

/** The parts of the Web MIDI API used here (MIDIAccess, MIDIInput), so tests can supply fakes. */
export interface MidiInputPort {
  readonly id: string
  readonly name?: string | null
  readonly manufacturer?: string | null
  readonly state: 'connected' | 'disconnected'
  onmidimessage: ((event: { data: Uint8Array | null; timeStamp: number }) => void) | null
}

export interface MidiAccessLike {
  readonly inputs: { forEach(callback: (port: MidiInputPort) => void): void }
  onstatechange: ((event: unknown) => void) | null
}

export type MidiStatus = 'unsupported' | 'off' | 'requesting' | 'ready' | 'denied' | 'error'

export interface MidiDevice {
  id: string
  name: string
  manufacturer?: string
}

function browserRequest(): (() => Promise<MidiAccessLike>) | undefined {
  const nav = globalThis.navigator as
    (Navigator & { requestMIDIAccess?: (o?: { sysex?: boolean }) => Promise<unknown> }) | undefined
  if (typeof nav?.requestMIDIAccess !== 'function') return undefined
  return () => nav.requestMIDIAccess!({ sysex: false }) as Promise<MidiAccessLike>
}

export class MidiInputManager {
  private readonly request: (() => Promise<MidiAccessLike>) | undefined
  private access: MidiAccessLike | null = null
  private readonly ports = new Map<string, MidiInputPort>()
  private statusValue: MidiStatus
  private errorValue: string | undefined
  private deviceList: MidiDevice[] = []
  private readonly messageListeners = new Set<(message: MidiMessage) => void>()
  private readonly disconnectListeners = new Set<(device: MidiDevice) => void>()
  private readonly changeListeners = new Set<() => void>()
  private enabling: Promise<MidiStatus> | null = null

  /** `request` defaults to navigator.requestMIDIAccess. */
  constructor(request: (() => Promise<MidiAccessLike>) | undefined = browserRequest()) {
    this.request = request
    this.statusValue = request ? 'off' : 'unsupported'
  }

  get status(): MidiStatus {
    return this.statusValue
  }

  /** Connected input devices. */
  get devices(): MidiDevice[] {
    return this.deviceList
  }

  /** Why the last request failed, for the 'denied' and 'error' states. */
  get error(): string | undefined {
    return this.errorValue
  }

  /** Asks for MIDI access (Chrome shows a permission prompt the first time); call from a user gesture. */
  enable(): Promise<MidiStatus> {
    if (!this.request) return Promise.resolve(this.statusValue)
    if (this.statusValue === 'ready') return Promise.resolve('ready')
    if (this.enabling) return this.enabling
    const request = this.request
    this.setStatus('requesting')
    this.enabling = request()
      .then((access) => {
        this.access = access
        access.onstatechange = () => this.refresh()
        this.errorValue = undefined
        this.statusValue = 'ready'
        this.refresh(true)
        return this.statusValue
      })
      .catch((error: unknown) => {
        const name = error instanceof Error || error instanceof DOMException ? error.name : ''
        this.errorValue = error instanceof Error ? error.message : String(error)
        this.setStatus(name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'error')
        return this.statusValue
      })
      .finally(() => {
        this.enabling = null
      })
    return this.enabling
  }

  onMessage(listener: (message: MidiMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** Called when a device goes away, so pads it was holding can be released. */
  onDisconnect(listener: (device: MidiDevice) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  /** Status and device list changes. */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private setStatus(status: MidiStatus) {
    this.statusValue = status
    for (const l of this.changeListeners) l()
  }

  private device(port: MidiInputPort): MidiDevice {
    return {
      id: port.id,
      name: port.name || 'MIDI device',
      ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
    }
  }

  private attach(port: MidiInputPort) {
    const device = this.device(port)
    // Setting onmidimessage also opens the port.
    port.onmidimessage = (event) => {
      const parsed = parseMidiData(event.data)
      if (!parsed) return
      const message: MidiMessage = {
        ...parsed,
        deviceId: device.id,
        deviceName: device.name,
        timeStamp: event.timeStamp,
      }
      for (const l of this.messageListeners) l(message)
    }
    this.ports.set(port.id, port)
  }

  private refresh(force = false) {
    const access = this.access
    if (!access) return
    const connected = new Map<string, MidiInputPort>()
    access.inputs.forEach((port) => {
      if (port.state === 'connected') connected.set(port.id, port)
    })
    let changed = force
    for (const [id, port] of this.ports) {
      if (connected.get(id) === port) continue
      port.onmidimessage = null
      this.ports.delete(id)
      changed = true
      for (const l of this.disconnectListeners) l(this.device(port))
    }
    for (const [id, port] of connected) {
      if (this.ports.has(id)) continue
      this.attach(port)
      changed = true
    }
    if (!changed) return
    this.deviceList = [...this.ports.values()].map((p) => this.device(p))
    for (const l of this.changeListeners) l()
  }

  dispose(): void {
    for (const port of this.ports.values()) port.onmidimessage = null
    this.ports.clear()
    if (this.access) this.access.onstatechange = null
    this.access = null
    this.messageListeners.clear()
    this.disconnectListeners.clear()
    this.changeListeners.clear()
  }
}
