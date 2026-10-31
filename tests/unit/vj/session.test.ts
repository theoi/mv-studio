import { describe, expect, it } from 'vitest'
import type { PlaybackState } from '../../../src/engine/types.ts'
import { ProjectEditor, type Clip, type Project } from '../../../src/model/index.ts'
import {
  LAYOUT_EXTENSION_KEY,
  MidiInputManager,
  VjSession,
  laneOfClip,
  type MidiAccessLike,
  type MidiInputPort,
  type VjPreview,
} from '../../../src/vj/index.ts'
import { asset, catalog, makeProject } from './helpers.ts'

class FakeClock {
  state: PlaybackState = 'paused'
  time = 0
  private listeners = new Set<(s: PlaybackState, t: number) => void>()
  currentTime() {
    return this.time
  }
  subscribe(l: (s: PlaybackState, t: number) => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  emit() {
    for (const l of this.listeners) l(this.state, this.time)
  }
}

class FakePreview implements VjPreview {
  clock = new FakeClock()
  project: Project | null = null
  setProject(p: Project) {
    this.project = p
  }
  play() {
    this.clock.state = 'playing'
    this.clock.emit()
    return Promise.resolve()
  }
  pause() {
    this.clock.state = 'paused'
    this.clock.emit()
  }
  seek(t: number) {
    this.clock.time = t
    this.clock.emit()
  }
}

function setup(project = makeProject()) {
  const editor = new ProjectEditor(project)
  const preview = new FakePreview()
  let now = 1000
  const timers: { at: number; cb: () => void }[] = []
  const frames: (() => void)[] = []
  const access: { ports: MidiInputPort[]; onstatechange: ((e: unknown) => void) | null } = {
    ports: [],
    onstatechange: null,
  }
  const midiAccess: MidiAccessLike = {
    inputs: { forEach: (cb) => access.ports.forEach(cb) },
    get onstatechange() {
      return access.onstatechange
    },
    set onstatechange(v) {
      access.onstatechange = v
    },
  }
  const midi = new MidiInputManager(() => Promise.resolve(midiAccess))
  let exited = 0
  const vj = new VjSession({
    editor,
    preview,
    catalog: () => catalog,
    store: null,
    midi,
    now: () => now,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => undefined,
    setTimer: (cb, ms) => timers.push({ at: now + ms, cb }),
    clearTimer: () => undefined,
    onExit: () => exited++,
  })
  const key = (code: string, down = true, timeStamp = now, shift = false) =>
    vj.handleKey({ code, shift, down, repeat: false, timeStamp })
  const tap = (code: string, timeStamp = now) => {
    key(code, true, timeStamp)
    key(code, false, timeStamp)
  }
  /** Advances wall and song time together, running due timers and one animation frame. */
  const advance = (seconds: number) => {
    now += seconds * 1000
    if (preview.clock.state === 'playing') preview.clock.time += seconds
    for (const t of timers.splice(0)) {
      if (t.at <= now) t.cb()
      else timers.push(t)
    }
    for (const f of frames.splice(0)) f()
  }
  return {
    editor,
    preview,
    vj,
    key,
    tap,
    advance,
    access,
    midi,
    get now() {
      return now
    },
    get exited() {
      return exited
    },
  }
}

const vjClips = (p: Project, lane: string): Clip[] =>
  Object.values(p.clips)
    .filter((c) => laneOfClip(c) === lane)
    .sort((a, b) => a.start - b.start)
const span = (c: Clip) => [
  Math.round(c.start * 1000) / 1000,
  Math.round((c.start + c.duration) * 1000) / 1000,
]
const at = (p: Project, t: number) =>
  Object.values(p.clips).filter((c) => laneOfClip(c) && t >= c.start && t < c.start + c.duration)

describe('VjSession', () => {
  it('records key presses at the time the user heard, shows them live, and commits one undo step on pause', async () => {
    const s = setup()
    await s.preview.play()
    s.advance(2)
    // The key event happened 20 ms before it was handled.
    s.key('KeyQ', true, s.now - 20)
    const live = s.preview.project!
    expect(at(live, 2).map((c) => c.name)).toEqual(['Night city'])
    expect(vjClips(s.editor.getProject(), 'clips')).toEqual([])
    expect(s.vj.getSnapshot().transport.recording).toBe(true)
    expect(s.vj.getSnapshot().pads.clips[0]?.active).toBe(true)

    s.advance(1)
    s.tap('KeyW')
    s.advance(1)
    s.preview.pause()
    const p = s.editor.getProject()
    expect(vjClips(p, 'clips').map((c) => [c.name, ...span(c)])).toEqual([
      ['Night city', 1.967, 3],
      ['Singer', 3, 4],
    ])
    expect(s.editor.undoLabel()).toBe('VJ take 1')
    expect(s.vj.getSnapshot().takes).toMatchObject([
      { number: 1, status: 'kept', presses: 2, canDiscard: true },
    ])
    s.editor.undo()
    expect(vjClips(s.editor.getProject(), 'clips')).toEqual([])
  })

  it('does not record while disarmed (rehearsal), and Shift Z arms recording mid-song', async () => {
    const s = setup()
    s.key('KeyZ', true, s.now, true)
    expect(s.vj.getSnapshot().settings.armed).toBe(false)
    await s.preview.play()
    s.advance(1)
    s.tap('KeyQ')
    expect(at(s.preview.project!, 1).map((c) => c.name)).toEqual(['Night city'])
    s.advance(1)
    s.key('KeyZ', true, s.now, true)
    s.advance(1)
    s.tap('KeyE')
    s.advance(1)
    s.preview.pause()
    // The rehearsal part is not kept; the armed part starts with the clip that was showing.
    expect(vjClips(s.editor.getProject(), 'clips').map((c) => [c.name, ...span(c)])).toEqual([
      ['Night city', 2, 3],
      ['Sunset', 3, 4],
    ])
  })

  it('carries the playing clip over a pause, and resets to the timeline after seeking elsewhere', async () => {
    const s = setup()
    await s.preview.play()
    s.tap('KeyQ')
    s.advance(2)
    s.preview.pause()
    expect(at(s.preview.project!, 2).map((c) => c.name)).toEqual(['Night city'])
    await s.preview.play()
    s.advance(2)
    s.preview.pause()
    expect(vjClips(s.editor.getProject(), 'clips').map(span)).toEqual([[0, 4]])

    s.preview.seek(10)
    expect(at(s.preview.project!, 10)).toEqual([])
    expect(s.vj.getSnapshot().pads.clips[0]?.active).toBe(false)
  })

  it('flashes a one-shot while paused for its decay time', () => {
    const s = setup()
    s.tap('KeyS')
    expect(at(s.preview.project!, 0).map((c) => c.name)).toEqual(['RGB split'])
    expect(s.vj.padLevels(0).get('fx:effect:rgb-split')).toBe(1)
    s.advance(0.4)
    expect(at(s.preview.project!, 0)).toEqual([])
    expect(s.editor.canUndo()).toBe(false)
  })

  it('holds an effect while the key is down and releases it when the window loses focus', async () => {
    const s = setup()
    await s.preview.play()
    s.advance(1)
    s.key('KeyD')
    expect(s.vj.getSnapshot().pads.effects[2]).toMatchObject({ label: 'Glow', active: true, key: 'D' })
    s.advance(1)
    // Focus loss: the keyup never arrives.
    ;(s.vj as unknown as { releaseInputs(prefix: string): void }).releaseInputs('key:')
    s.advance(1)
    s.preview.pause()
    expect(vjClips(s.editor.getProject(), 'fx:fx:effect:glow').map(span)).toEqual([[1, 2]])
  })

  it('plays MIDI pads with velocity, rides knobs, and releases a held note when its device is unplugged', async () => {
    const s = setup()
    const port: MidiInputPort = { id: 'dev', name: 'Pads', state: 'connected', onmidimessage: null }
    s.access.ports.push(port)
    await s.vj.connectMidi()
    expect(s.vj.getSnapshot().midi).toMatchObject({ status: 'ready', devices: [{ name: 'Pads' }] })
    const send = (bytes: number[]) => port.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp: s.now })
    await s.preview.play()
    s.advance(1)
    send([0x90, 45, 64]) // note 45: effects pad 2 (RGB split, one-shot) at half velocity
    send([0x90, 46, 127]) // note 46: effects pad 3 (Glow, hold)
    s.advance(0.5)
    send([0xb0, 23, 64]) // CC 23: knob 3 rides Glow
    s.advance(0.5)
    ;(port as { state: string }).state = 'disconnected'
    s.access.onstatechange?.({})
    s.advance(0.5)
    s.preview.pause()
    const p = s.editor.getProject()
    const [rgb] = vjClips(p, 'fx:fx:effect:rgb-split')
    expect(rgb?.type === 'adjustment' && rgb.effects[0]?.params.amount?.keyframes?.[0]?.value).toBeCloseTo(
      28 * (64 / 127),
      3,
    )
    const [glow] = vjClips(p, 'fx:fx:effect:glow')
    expect(span(glow!)).toEqual([1, 2])
    const intensity = glow?.type === 'adjustment' ? glow.effects[0]?.params.intensity : undefined
    expect(intensity?.keyframes?.[0]?.value).toBe(2)
    expect(intensity?.keyframes?.at(-1)?.value).toBeCloseTo(2 * (64 / 127), 2)
  })

  it('learns a key for a pad, and Esc cancels learning without exiting', () => {
    const s = setup()
    s.vj.learn({ kind: 'pad', row: 'looks', index: 3 })
    s.key('KeyM')
    expect(s.vj.getSnapshot().learn).toBeNull()
    expect(s.vj.getSnapshot().pads.looks[3]?.key).toBe('M')
    s.vj.learn({ kind: 'pad', row: 'looks', index: 4 })
    s.key('Escape')
    expect(s.vj.getSnapshot().learn).toBeNull()
    expect(s.exited).toBe(0)
    s.key('Escape')
    expect(s.exited).toBe(1)
  })

  it('discards the latest take by undoing it, and an older take by removing its clips', async () => {
    const s = setup()
    await s.preview.play()
    s.tap('KeyQ')
    s.advance(2)
    s.preview.pause()
    s.preview.seek(5)
    await s.preview.play()
    s.tap('KeyW')
    s.advance(2)
    s.preview.pause()
    const [first, second] = s.vj.getSnapshot().takes
    expect(vjClips(s.editor.getProject(), 'clips').map(span)).toEqual([
      [0, 2],
      [5, 7],
    ])
    s.vj.discardTake(first!.id)
    expect(vjClips(s.editor.getProject(), 'clips').map(span)).toEqual([[5, 7]])
    expect(s.editor.undoLabel()).toBe('Discard VJ take 1')
    s.editor.undo()
    s.editor.undo()
    expect(vjClips(s.editor.getProject(), 'clips').map(span)).toEqual([[0, 2]])
    expect(s.vj.getSnapshot().takes.map((t) => t.status)).toEqual(['discarded', 'kept'])
    expect(second).toBeDefined()
  })

  it('re-quantizes the latest take in place', async () => {
    const s = setup()
    await s.preview.play()
    s.advance(1.07)
    s.tap('KeyQ')
    s.advance(1)
    s.preview.pause()
    const take = s.vj.getSnapshot().takes[0]!
    expect(take.canRequantize).toBe(true)
    s.vj.requantizeTake(take.id, { enabled: true, grid: '1/4', strength: 1 })
    expect(vjClips(s.editor.getProject(), 'clips').map(span)).toEqual([[1, 2.067]])
    expect(s.vj.getSnapshot().takes[0]?.quantized).toBe(true)
    s.editor.undo()
    expect(vjClips(s.editor.getProject(), 'clips')).toEqual([])
  })

  it('switches clip banks with ] so the same key plays another clip', () => {
    const project = makeProject()
    for (let i = 0; i < 9; i++)
      project.assets['x' + i] = asset('x' + i, 'image', 'Extra ' + i + '.png', undefined, 5)
    const s = setup(project)
    expect(s.vj.getSnapshot().bank).toEqual({ index: 0, count: 2 })
    s.tap('BracketRight')
    expect(s.vj.getSnapshot().bank.index).toBe(1)
    s.tap('KeyQ')
    expect(at(s.preview.project!, 0).map((c) => c.type === 'image' && c.assetId)).toEqual(['x7'])
  })

  it('measures input latency from taps along to the beat', async () => {
    const s = setup()
    s.vj.startCalibration()
    await s.preview.play()
    for (let i = 0; i < 8; i++) {
      s.advance(i === 0 ? 0.535 : 0.5)
      s.tap('KeyQ')
    }
    const estimate = s.vj.finishCalibration()
    expect(estimate?.offsetMs).toBeCloseTo(35, 0)
    expect(s.vj.getSnapshot().settings.inputOffsetMs).toBe(35)
    s.preview.pause()
    expect(vjClips(s.editor.getProject(), 'clips')).toEqual([])
  })

  it('saves pad edits with the project as an undoable change', () => {
    const s = setup()
    const flash = s.vj.getLayout().effects.find((p) => p?.label === 'Flash')!
    s.vj.setPad('effects', 0, flash)
    expect(s.vj.getSnapshot().pads.effects[0]?.label).toBe('Flash')
    expect(s.vj.getSnapshot().layoutCustomized).toBe(true)
    expect(s.editor.getProject().extensions?.[LAYOUT_EXTENSION_KEY]).toBeDefined()
    s.editor.undo()
    expect(s.vj.getSnapshot().pads.effects[0]?.label).toBe('Strobe')
  })

  it('hands the preview back the plain project on close, committing a running take', async () => {
    const s = setup()
    await s.preview.play()
    s.tap('KeyQ')
    s.advance(1)
    expect(s.vj.close()).toEqual({ kept: 1 })
    expect(s.preview.project).toBe(s.editor.getProject())
    expect(vjClips(s.editor.getProject(), 'clips').map(span)).toEqual([[0, 1]])
  })
})
