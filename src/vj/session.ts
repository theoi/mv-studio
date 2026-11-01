/**
 * VJ session: the headless controller behind VJ mode. It turns key presses, MIDI and pad clicks into a live
 * performance shown in the preview, records takes with latency-compensated times, and puts each take on the
 * timeline as one undoable edit when playback stops.
 *
 *   const vj = new VjSession({ editor, preview })      // while VJ mode is open, vj drives preview.setProject
 *   const detach = vj.attachKeyboard(window)
 *   const snapshot = useSyncExternalStore(vj.subscribe, vj.getSnapshot)
 *   preview.onFrame((t) => paint(vj.padLevels(t)))   // pad lights at 60 fps without React renders
 *   vj.close()                                       // on exit; takes are already on the timeline
 *
 * The preview shows the project with the take so far applied (./convert.ts), so what the user sees while
 * performing is exactly what lands on the timeline (quantizing, when on, then moves hits to the grid).
 */
import { pluginRegistry } from '../engine/registry.ts'
import type { PlaybackState, PluginCatalogEntry } from '../engine/types.ts'
import type { ProjectEditor } from '../model/editor.ts'
import { newId } from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type { Asset, JsonValue, Project, Seconds } from '../model/types.ts'
import {
  bindKey,
  bindMidi,
  isBindableKey,
  keyForTarget,
  keyId,
  keyLabel,
  midiForTarget,
  midiLabel,
  targetForKey,
  targetsForMidi,
} from './bindings.ts'
import {
  applyCommands,
  padLevelsAt,
  takeOfClip,
  takeToCommands,
  type Lane,
  type TakeConversion,
} from './convert.ts'
import { attachKeyboard, type KeyInput } from './keyboard.ts'
import { LAYOUT_EXTENSION_KEY, layoutForProject, padAt } from './layout.ts'
import { MidiInputManager, type MidiDevice, type MidiMessage, type MidiStatus } from './midi.ts'
import { beatGridOf } from './quantize.ts'
import { loadBindings, localVjStore, type VjStore } from './storage.ts'
import { estimateInputOffset, inputTimelineTime, type InputOffsetEstimate } from './timing.ts'
import {
  DEFAULT_SETTINGS,
  ROW_SIZE,
  type BindingTarget,
  type ClipSource,
  type Pad,
  type PadRow,
  type PadSnapshot,
  type QuantizeSettings,
  type Take,
  type VjBindings,
  type VjEvent,
  type VjLayout,
  type VjSettings,
} from './types.ts'

export interface VjClock {
  readonly state: PlaybackState
  currentTime(): Seconds
  subscribe(listener: (state: PlaybackState, time: Seconds) => void): () => void
}

/** What the session needs from the preview (PreviewController implements it). */
export interface VjPreview {
  readonly clock: VjClock
  setProject(project: Project): void
  play(): Promise<void>
  pause(): void
  /** Keeps these video assets loaded, so clips that use them start without a load (PreviewController.prefetch). */
  prefetch?(assets: Asset[]): void
}

export interface VjSessionOptions {
  editor: ProjectEditor
  preview: VjPreview
  /** Plugin catalog; defaults to the app registry's. */
  catalog?: () => readonly PluginCatalogEntry[]
  /** Where bindings and settings are kept; defaults to localStorage. null keeps them in memory. */
  store?: VjStore | null
  midi?: MidiInputManager
  /** Called when the exit key (Esc) is pressed. */
  onExit?: () => void
  now?: () => number
  requestFrame?: (callback: () => void) => unknown
  cancelFrame?: (handle: unknown) => void
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface PadView {
  id: string
  label: string
  row: PadRow
  index: number
  kind: 'clip' | 'effect' | 'look'
  /** 'latch' | 'momentary' for clips, the effect trigger for effects, 'switch' for looks. */
  trigger: string
  /** Clip pads: what they show (for thumbnails). */
  source?: ClipSource | null
  key?: string
  midi?: string
  /** Lit: the playing clip or look, a toggled or held effect. One-shot flashes are in padLevels(). */
  active: boolean
  /** Effect pads: the knob amount, 0..1. */
  amount?: number
}

export interface TakeView {
  id: string
  number: number
  start: Seconds
  end: Seconds
  /** Pad presses in the take. */
  presses: number
  status: 'kept' | 'discarded' | 'failed'
  error?: string
  summary?: TakeConversion['summary']
  quantized: boolean
  canDiscard: boolean
  /** Only the latest take, while nothing else changed since, can be quantized again. */
  canRequantize: boolean
}

export interface VjSnapshot {
  /** 'empty': nothing on the timeline to perform over; 'no-song': no song set (VJ still works over the timeline). */
  problem: 'empty' | 'no-song' | null
  transport: {
    state: PlaybackState
    armed: boolean
    recording: boolean
    takeStart: Seconds | null
    /** Pad presses in the take being recorded. */
    presses: number
  }
  bank: { index: number; count: number }
  pads: Record<PadRow, (PadView | null)[]>
  takes: TakeView[]
  settings: VjSettings
  /** Quantizing needs the song's beats. */
  quantizeAvailable: boolean
  midi: { status: MidiStatus; devices: MidiDevice[]; error?: string }
  /** Waiting for a key, note or knob to bind to this target. */
  learn: BindingTarget | null
  calibrating: { taps: number } | null
  /** True when the layout is saved with the project (edited by the user), false when generated. */
  layoutCustomized: boolean
  error: string | null
}

interface TakeRecord {
  take: Take
  number: number
  status: TakeView['status']
  error?: string
  committed?: Project
  createdTracks: string[]
  quantize: QuantizeSettings | null
  summary?: TakeConversion['summary']
}

interface Pressed {
  pad: PadSnapshot
  velocity: number
}

/** While recording, the live preview is rebuilt at least this often so strobes keep being generated ahead. */
const OVERLAY_REFRESH: Seconds = 3
const STROBE_HORIZON: Seconds = 6
/** Knob moves closer together than this are merged into one recorded point. */
const KNOB_MIN_INTERVAL: Seconds = 1 / 120

export class VjSession {
  private readonly editor: ProjectEditor
  private readonly preview: VjPreview
  private readonly catalog: () => readonly PluginCatalogEntry[]
  private readonly store: VjStore | null
  private readonly midi: MidiInputManager
  private readonly onExit: (() => void) | undefined
  private readonly now: () => number
  private readonly requestFrame: (callback: () => void) => unknown
  private readonly cancelFrame: (handle: unknown) => void
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  private layout: VjLayout
  private layoutInputs: { assets: unknown; saved: unknown; catalog: unknown }
  private bank = 0
  private bindings: VjBindings
  private settings: VjSettings

  private readonly pressed = new Map<string, Pressed>()
  private latch = {
    clip: null as PadSnapshot | null,
    look: null as PadSnapshot | null,
    momentary: [] as PadSnapshot[],
    toggles: new Map<string, PadSnapshot>(),
  }
  private knobs: Record<string, number> = {}
  private readonly ccDown = new Map<string, boolean>()
  private readonly flashes = new Map<string, { pad: PadSnapshot; velocity: number; timer: unknown }>()
  private performance: { take: Take; armed: boolean } | null = null
  private nextTakeId = newId()
  private pausedAt: Seconds
  private lastTime: Seconds
  private overlayAt = 0
  private lanes: Lane[] = []
  private readonly takes: TakeRecord[] = []
  private cursors: Record<string, Seconds> = {}
  private learnTarget: BindingTarget | null = null
  private calibration: Seconds[] | null = null
  private error: string | null = null

  private snapshot: VjSnapshot
  private readonly listeners = new Set<() => void>()
  private frame: unknown = null
  private dirtyOverlay = false
  private dirtySnapshot = false
  private readonly cleanups: (() => void)[] = []
  private disposed = false
  /** Asset ids last passed to preview.prefetch. */
  private prefetched = ''

  constructor(options: VjSessionOptions) {
    this.editor = options.editor
    this.preview = options.preview
    this.catalog = options.catalog ?? (() => pluginRegistry.catalog())
    this.store = options.store === undefined ? localVjStore() : options.store
    this.midi = options.midi ?? new MidiInputManager()
    this.onExit = options.onExit
    this.now = options.now ?? (() => performance.now())
    this.requestFrame =
      options.requestFrame ??
      (typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => setTimeout(cb, 16))
    this.cancelFrame =
      options.cancelFrame ??
      (typeof cancelAnimationFrame === 'function'
        ? (h) => cancelAnimationFrame(h as number)
        : (h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

    this.bindings = loadBindings(this.store)
    this.settings = { ...DEFAULT_SETTINGS, ...this.store?.loadSettings() }
    const project = this.editor.getProject()
    this.layoutInputs = { assets: null, saved: null, catalog: null }
    this.layout = this.syncLayout(project)
    this.pausedAt = this.preview.clock.currentTime()
    this.lastTime = this.pausedAt

    this.cleanups.push(
      this.editor.subscribe((p, change) => {
        if (change.source === 'load') this.resetForNewProject()
        this.syncLayout(p)
        this.prefetchBank()
        this.refreshOverlay()
        this.emit()
      }),
      this.preview.clock.subscribe((state, time) => this.onClock(state, time)),
      this.midi.onMessage((m) => this.handleMidi(m)),
      this.midi.onDisconnect((d) => this.releaseInputs(`midi:${d.id}:`)),
      this.midi.subscribe(() => this.emit()),
    )
    this.snapshot = this.buildSnapshot()
    this.prefetchBank()
    if (this.preview.clock.state === 'playing') this.begin(this.preview.clock.currentTime())
    this.refreshOverlay()
  }

  // -------------------------------------------------------------------------------------------------------------
  // Snapshot for the UI

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): VjSnapshot => this.snapshot

  /** How lit each pad is (0..1) at timeline time `time`; cheap enough to call every frame. */
  padLevels(time: Seconds = this.preview.clock.currentTime()): Map<string, number> {
    return padLevelsAt(this.lanes, time)
  }

  getLayout(): VjLayout {
    return this.layout
  }

  getBindings(): VjBindings {
    return this.bindings
  }

  private emit() {
    if (this.disposed) return
    this.dirtySnapshot = false
    this.snapshot = this.buildSnapshot()
    for (const l of this.listeners) l()
  }

  private emitSoon() {
    this.dirtySnapshot = true
    this.schedule()
  }

  private buildSnapshot(): VjSnapshot {
    const project = this.editor.getProject()
    const clock = this.preview.clock
    const currentClip = this.latch.momentary[this.latch.momentary.length - 1] ?? this.latch.clip
    const lit = (pad: Pad, row: PadRow) => {
      if (row === 'clips') return currentClip?.id === pad.id
      if (row === 'looks') return this.latch.look?.id === pad.id
      return this.latch.toggles.has(pad.id) || [...this.pressed.values()].some((p) => p.pad.id === pad.id)
    }
    const view = (pad: Pad | null, row: PadRow, index: number): PadView | null => {
      if (!pad) return null
      const target: BindingTarget = { kind: 'pad', row, index }
      const key = keyForTarget(this.bindings, target)
      const midi = midiForTarget(this.bindings, target)
      const action = pad.action
      return {
        id: pad.id,
        label: pad.label,
        row,
        index,
        kind: action.kind,
        trigger: action.kind === 'look' ? 'switch' : action.trigger,
        ...(action.kind === 'clip' ? { source: action.source } : {}),
        ...(key ? { key: keyLabel(key) } : {}),
        ...(midi ? { midi: midiLabel(midi) } : {}),
        active: lit(pad, row),
        ...(action.kind === 'effect' ? { amount: this.knobs[pad.id] ?? 1 } : {}),
      }
    }
    const bank = this.layout.clipBanks[this.bank] ?? []
    const latest = this.takes.findLast((r) => r.status === 'kept')
    return {
      problem: projectDuration(project) <= 0 ? 'empty' : project.songAssetId ? null : 'no-song',
      transport: {
        state: clock.state,
        armed: this.settings.armed,
        recording: this.performance?.armed === true,
        takeStart: this.performance?.take.start ?? null,
        presses: this.performance?.armed
          ? this.performance.take.events.filter((e) => e.type === 'press').length
          : 0,
      },
      bank: { index: this.bank, count: this.layout.clipBanks.length },
      pads: {
        clips: Array.from({ length: ROW_SIZE.clips }, (_, i) => view(bank[i] ?? null, 'clips', i)),
        effects: this.layout.effects.map((p, i) => view(p, 'effects', i)),
        looks: this.layout.looks.map((p, i) => view(p, 'looks', i)),
      },
      takes: this.takes.map((r) => ({
        id: r.take.id,
        number: r.number,
        start: r.take.start,
        end: r.take.end ?? r.take.start,
        presses: r.take.events.filter((e) => e.type === 'press').length,
        status: r.status,
        ...(r.error ? { error: r.error } : {}),
        ...(r.summary ? { summary: r.summary } : {}),
        quantized: r.quantize !== null,
        canDiscard: r.status === 'kept',
        canRequantize: r === latest && r.committed === project && beatGridOf(project) !== null,
      })),
      settings: this.settings,
      quantizeAvailable: beatGridOf(project) !== null,
      midi: {
        status: this.midi.status,
        devices: this.midi.devices,
        ...(this.midi.error ? { error: this.midi.error } : {}),
      },
      learn: this.learnTarget,
      calibrating: this.calibration ? { taps: this.calibration.length } : null,
      layoutCustomized: project.extensions?.[LAYOUT_EXTENSION_KEY] !== undefined,
      error: this.error,
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Layout

  private syncLayout(project: Project): VjLayout {
    const catalog = this.catalog()
    const saved = project.extensions?.[LAYOUT_EXTENSION_KEY]
    const inputs = this.layoutInputs
    if (inputs.assets !== project.assets || inputs.saved !== saved || inputs.catalog !== catalog) {
      this.layoutInputs = { assets: project.assets, saved, catalog }
      this.layout = layoutForProject(project, catalog)
      this.bank = Math.min(this.bank, this.layout.clipBanks.length - 1)
    }
    return this.layout
  }

  /** Saves a layout with the project (undoable). */
  setLayout(layout: VjLayout): void {
    this.dispatchSafely(
      { type: 'project.setExtension', key: LAYOUT_EXTENSION_KEY, value: layout as unknown as JsonValue },
      'Change VJ pads',
    )
  }

  /** Puts a pad in a slot (null empties it). Clip slots are in the current bank. */
  setPad(row: PadRow, index: number, pad: Pad | null): void {
    const layout: VjLayout = structuredClone(this.layout)
    const rowPads =
      row === 'clips' ? layout.clipBanks[this.bank] : row === 'effects' ? layout.effects : layout.looks
    if (!rowPads || index < 0 || index >= ROW_SIZE[row]) return
    const previous = rowPads[index]
    rowPads[index] = pad
    if (previous && !pad && previous.action.kind === 'clip')
      layout.dismissed = [...new Set([...(layout.dismissed ?? []), previous.id])]
    if (pad && layout.dismissed) layout.dismissed = layout.dismissed.filter((id) => id !== pad.id)
    this.setLayout(layout)
  }

  /** Back to the generated layout. */
  resetLayout(): void {
    if (this.editor.getProject().extensions?.[LAYOUT_EXTENSION_KEY] === undefined) return
    this.dispatchSafely(
      { type: 'project.setExtension', key: LAYOUT_EXTENSION_KEY, value: null },
      'Reset VJ pads',
    )
  }

  setBank(index: number): void {
    const next = Math.max(0, Math.min(this.layout.clipBanks.length - 1, index))
    if (next === this.bank) return
    this.bank = next
    this.prefetchBank()
    this.emit()
  }

  /** Keeps the footage of the current bank's video pads loaded, so even the first press of each cuts in at once. */
  private prefetchBank(): void {
    if (!this.preview.prefetch) return
    const project = this.editor.getProject()
    const assets: Asset[] = []
    for (const pad of this.layout.clipBanks[this.bank] ?? []) {
      const source = pad?.action.kind === 'clip' ? pad.action.source : null
      const asset = source?.type === 'asset' ? project.assets[source.assetId] : undefined
      if (asset?.kind === 'video' && !assets.includes(asset)) assets.push(asset)
    }
    const ids = assets.map((a) => a.id).join(' ')
    if (ids === this.prefetched) return
    this.prefetched = ids
    this.preview.prefetch(assets)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Settings, bindings, learn, calibration

  private saveSettings(patch: Partial<VjSettings>) {
    this.settings = { ...this.settings, ...patch }
    this.store?.saveSettings(this.settings)
    this.emit()
  }

  setQuantize(patch: Partial<QuantizeSettings>): void {
    this.saveSettings({ quantize: { ...this.settings.quantize, ...patch } })
  }

  setMode(mode: VjSettings['mode']): void {
    this.saveSettings({ mode })
    this.refreshOverlay()
  }

  setInputOffset(ms: number): void {
    this.saveSettings({ inputOffsetMs: Math.max(-500, Math.min(500, ms)) })
  }

  /** Arms or disarms recording. Mid-performance, the take so far ends and a new one (or a rehearsal) starts. */
  setArmed(armed: boolean): void {
    if (armed === this.settings.armed) return
    this.saveSettings({ armed })
    if (this.performance && this.preview.clock.state === 'playing') {
      const t = this.preview.clock.currentTime()
      this.finish(t)
      this.begin(t)
      this.refreshOverlay()
      this.emit()
    }
  }

  setBindings(bindings: VjBindings): void {
    this.bindings = bindings
    this.store?.saveBindings(bindings)
    this.emit()
  }

  /** The next key, MIDI note or MIDI CC is bound to `target`; null cancels. Esc also cancels. */
  learn(target: BindingTarget | null): void {
    this.learnTarget = target
    this.emit()
  }

  /** Starts measuring input latency: the user taps any pad key or MIDI pad along with the beat while playing. */
  startCalibration(): void {
    this.calibration = []
    this.emit()
  }

  cancelCalibration(): void {
    this.calibration = null
    this.emit()
  }

  /** Ends calibration and applies the measured offset. Null when there were too few taps or no beat grid. */
  finishCalibration(): InputOffsetEstimate | null {
    const taps = this.calibration ?? []
    this.calibration = null
    const grid = beatGridOf(this.editor.getProject())
    const estimate = grid ? estimateInputOffset(taps, grid.beats) : null
    if (estimate) this.saveSettings({ inputOffsetMs: Math.round(estimate.offsetMs) })
    else this.emit()
    return estimate
  }

  clearError(): void {
    this.error = null
    this.emit()
  }

  // -------------------------------------------------------------------------------------------------------------
  // Inputs

  /** Starts listening to the keyboard on `target` (usually window). Returns a function that stops listening. */
  attachKeyboard(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const detach = attachKeyboard(
      target,
      (input) => this.handleKey(input),
      () => this.releaseInputs('key:'),
    )
    this.cleanups.push(detach)
    return detach
  }

  /** Requests MIDI access (from a user gesture). Devices plugged in later connect automatically. */
  connectMidi(): Promise<MidiStatus> {
    return this.midi.enable()
  }

  /** Handles a key; returns true when VJ mode used it (the caller then prevents the browser default). */
  handleKey(input: KeyInput): boolean {
    if (this.disposed) return false
    const inputId = `key:${input.code}`
    if (!input.down) return this.release(inputId, input.timeStamp)
    if (this.learnTarget) {
      if (input.code === 'Escape') this.learn(null)
      else if (!input.repeat && isBindableKey(input.code)) {
        const target = this.learnTarget
        this.learnTarget = null
        this.setBindings(bindKey(this.bindings, keyId(input.code, input.shift), target))
      }
      return true
    }
    const target = targetForKey(this.bindings, input.code, input.shift)
    if (!target) return false
    if (input.repeat) return true
    this.trigger(target, inputId, 1, input.timeStamp)
    return true
  }

  handleMidi(message: MidiMessage): void {
    if (this.disposed) return
    const inputId = `midi:${message.deviceId}:${message.channel}:${message.number}`
    const control = `${inputId}:${message.type === 'cc' ? 'cc' : 'note'}`
    if (this.learnTarget) {
      const activates = message.type === 'noteon' || (message.type === 'cc' && message.value > 0)
      const isKnob = this.learnTarget.kind === 'knob'
      if (activates && (message.type === 'cc' || !isKnob)) {
        const target = this.learnTarget
        this.learnTarget = null
        this.setBindings(
          bindMidi(
            this.bindings,
            {
              type: message.type === 'cc' ? 'cc' : 'note',
              number: message.number,
              channel: message.channel,
              device: message.deviceName,
            },
            target,
          ),
        )
      }
      return
    }
    const targets = targetsForMidi(this.bindings, message)
    if (message.type === 'noteoff') {
      this.release(inputId, message.timeStamp)
      return
    }
    for (const target of targets) {
      if (message.type === 'noteon') this.trigger(target, inputId, message.value / 127, message.timeStamp)
      else if (target.kind === 'knob') this.setKnob(target.index, message.value / 127, message.timeStamp)
      else {
        // Buttons that send CC: on at 64 and above, off below.
        const down = message.value >= 64
        const was = this.ccDown.get(control) ?? false
        this.ccDown.set(control, down)
        if (down && !was) this.trigger(target, inputId, 1, message.timeStamp)
        else if (!down && was) this.release(inputId, message.timeStamp)
      }
    }
  }

  /** A pad pressed with the mouse or touch. Pair with releasePad(). */
  pressPad(row: PadRow, index: number, timeStamp = this.now()): void {
    this.trigger({ kind: 'pad', row, index }, `pointer:${row}:${index}`, 1, timeStamp)
  }

  releasePad(row: PadRow, index: number, timeStamp = this.now()): void {
    this.release(`pointer:${row}:${index}`, timeStamp)
  }

  /** Sets the amount (0..1) of the effect pad at `index`, as a knob or slider does. */
  setKnob(index: number, value: number, timeStamp = this.now()): void {
    const pad = this.layout.effects[index]
    if (!pad) return
    const v = Math.max(0, Math.min(1, value))
    this.knobs[pad.id] = v
    const perf = this.performance
    if (perf) {
      const t = this.inputTime(timeStamp)
      perf.take.pads[pad.id] ??= { ...pad, row: 'effects', index }
      const last = perf.take.events.findLast((e) => e.type === 'amount' && e.pad === pad.id)
      if (last && last.type === 'amount' && t - last.t < KNOB_MIN_INTERVAL && t >= last.t) last.value = v
      else perf.take.events.push({ t, type: 'amount', pad: pad.id, value: v })
    }
    this.dirtyOverlay = true
    this.emitSoon()
  }

  private trigger(target: BindingTarget, inputId: string, velocity: number, timeStamp: number) {
    if (target.kind === 'transport') {
      this.transport(target.action)
      return
    }
    if (target.kind === 'knob') return
    if (this.calibration) {
      if (this.preview.clock.state === 'playing') {
        const clock = this.preview.clock
        this.calibration.push(
          inputTimelineTime({
            clockTime: clock.currentTime(),
            playing: true,
            now: this.now(),
            eventTime: timeStamp,
          }),
        )
        this.emit()
      }
      return
    }
    const pad = padAt(this.layout, target.row, target.index, this.bank)
    if (!pad || this.pressed.has(inputId)) return
    this.press({ ...pad, row: target.row, index: target.index }, inputId, velocity, timeStamp)
  }

  private transport(action: Extract<BindingTarget, { kind: 'transport' }>['action']) {
    switch (action) {
      case 'play':
        this.togglePlay()
        return
      case 'record':
        this.setArmed(!this.settings.armed)
        return
      case 'bank-next':
        this.setBank(this.bank + 1)
        return
      case 'bank-prev':
        this.setBank(this.bank - 1)
        return
      case 'panic':
        this.panic()
        return
      case 'exit':
        this.onExit?.()
        return
    }
  }

  togglePlay(): void {
    if (this.preview.clock.state === 'playing') this.preview.pause()
    else
      this.preview.play().catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : 'Playback couldn’t start'
        this.emit()
      })
  }

  private inputTime(timeStamp: number): Seconds {
    const clock = this.preview.clock
    const perf = this.performance
    const t = inputTimelineTime({
      clockTime: clock.currentTime(),
      playing: perf !== null && clock.state === 'playing',
      now: this.now(),
      eventTime: timeStamp,
      offsetMs: this.settings.inputOffsetMs,
    })
    return perf ? Math.max(perf.take.start, t) : t
  }

  private holders(padId: string): number {
    let n = 0
    for (const p of this.pressed.values()) if (p.pad.id === padId) n++
    return n
  }

  private record(event: VjEvent, pad: PadSnapshot) {
    const perf = this.performance
    if (!perf) return
    perf.take.pads[pad.id] ??= pad
    perf.take.events.push(event)
  }

  private press(pad: PadSnapshot, inputId: string, velocity: number, timeStamp: number) {
    const action = pad.action
    const first = this.holders(pad.id) === 0
    this.pressed.set(inputId, { pad, velocity })
    const t = this.inputTime(timeStamp)
    let records = true
    if (action.kind === 'clip') {
      if (action.trigger === 'momentary') {
        records = first
        this.latch.momentary = [...this.latch.momentary.filter((p) => p.id !== pad.id), pad]
      } else {
        this.latch.clip = pad
        this.latch.momentary = []
      }
    } else if (action.kind === 'look') {
      this.latch.look = pad
    } else if (action.trigger === 'toggle') {
      if (this.latch.toggles.has(pad.id)) this.latch.toggles.delete(pad.id)
      else this.latch.toggles.set(pad.id, pad)
    } else if (action.trigger === 'hold') {
      records = first
    } else if (action.trigger === 'one-shot') {
      if (!this.performance) this.flash(pad, velocity)
    } else records = false
    if (records) this.record({ t, type: 'press', pad: pad.id, velocity }, pad)
    this.refreshOverlay()
    this.emit()
  }

  /** While paused, a one-shot shows at its peak for its decay time, measured on the wall clock. */
  private flash(pad: PadSnapshot, velocity: number) {
    const existing = this.flashes.get(pad.id)
    if (existing) this.clearTimer(existing.timer)
    const decay = pad.action.kind === 'effect' ? pad.action.decay : 0.3
    const timer = this.setTimer(() => {
      this.flashes.delete(pad.id)
      this.refreshOverlay()
      this.emit()
    }, decay * 1000)
    this.flashes.set(pad.id, { pad, velocity, timer })
  }

  private release(inputId: string, timeStamp: number): boolean {
    const pressed = this.pressed.get(inputId)
    if (!pressed) return false
    this.pressed.delete(inputId)
    const { pad } = pressed
    if (this.holders(pad.id) > 0) return true
    const action = pad.action
    const momentary = action.kind === 'clip' && action.trigger === 'momentary'
    const hold = action.kind === 'effect' && action.trigger === 'hold'
    if (momentary) this.latch.momentary = this.latch.momentary.filter((p) => p.id !== pad.id)
    if (momentary || hold) {
      this.record({ t: this.inputTime(timeStamp), type: 'release', pad: pad.id }, pad)
      this.refreshOverlay()
    }
    this.emit()
    return true
  }

  /** Releases every pad held by inputs whose id starts with `prefix` (focus lost, device unplugged). */
  private releaseInputs(prefix: string) {
    for (const inputId of [...this.pressed.keys()])
      if (inputId.startsWith(prefix)) this.release(inputId, this.now())
  }

  /** Turns every effect off: releases held pads and switches toggles off. */
  panic(): void {
    const t = this.inputTime(this.now())
    for (const pad of this.latch.toggles.values())
      this.record({ t, type: 'press', pad: pad.id, velocity: 1 }, pad)
    this.latch.toggles.clear()
    for (const [inputId, { pad }] of [...this.pressed]) {
      if (pad.action.kind !== 'effect') continue
      this.pressed.delete(inputId)
      if (this.holders(pad.id) === 0 && pad.action.trigger === 'hold')
        this.record({ t, type: 'release', pad: pad.id }, pad)
    }
    for (const f of this.flashes.values()) this.clearTimer(f.timer)
    this.flashes.clear()
    this.refreshOverlay()
    this.emit()
  }

  // -------------------------------------------------------------------------------------------------------------
  // Takes

  private onClock(state: PlaybackState, time: Seconds) {
    if (state === 'playing') {
      // While playing, the clock only reports seeks and loop wraps: end the take where the jump happened.
      if (this.performance) this.finish(this.lastTime)
      this.begin(time)
    } else {
      if (this.performance) this.finish(time)
      else if (Math.abs(time - this.pausedAt) > 1e-3) this.resetLatch()
      this.pausedAt = time
    }
    this.refreshOverlay()
    this.emit()
  }

  /** Clip, look and toggled effects carry over a pause; seeking elsewhere shows the timeline there instead. */
  private resetLatch() {
    this.latch.clip = null
    this.latch.look = null
    this.latch.momentary = this.latch.momentary.filter((p) =>
      [...this.pressed.values()].some((x) => x.pad.id === p.id),
    )
    this.latch.toggles.clear()
  }

  private seed(take: Take, t: Seconds, withFlashes: boolean) {
    const press = (pad: PadSnapshot, velocity = 1) => {
      take.pads[pad.id] = pad
      take.events.push({ t, type: 'press', pad: pad.id, velocity })
    }
    if (this.latch.clip) press(this.latch.clip)
    for (const pad of this.latch.momentary) press(pad)
    if (this.latch.look) press(this.latch.look)
    for (const pad of this.latch.toggles.values()) press(pad)
    const held = new Map<string, Pressed>()
    for (const p of this.pressed.values())
      if (p.pad.action.kind === 'effect' && p.pad.action.trigger === 'hold') held.set(p.pad.id, p)
    for (const p of held.values()) press(p.pad, p.velocity)
    if (withFlashes) for (const f of this.flashes.values()) press(f.pad, f.velocity)
    this.layout.effects.forEach((pad, index) => {
      if (pad?.action.kind === 'effect' && pad.action.trigger === 'knob' && (this.knobs[pad.id] ?? 0) > 0)
        take.pads[pad.id] ??= { ...pad, row: 'effects', index }
    })
  }

  private newTake(start: Seconds, withFlashes: boolean): Take {
    const take: Take = {
      id: this.nextTakeId,
      start,
      pads: {},
      events: [],
      amounts: { ...this.knobs },
      cursors: { ...this.cursors },
    }
    this.seed(take, start, withFlashes)
    return take
  }

  private begin(time: Seconds) {
    for (const f of this.flashes.values()) this.clearTimer(f.timer)
    this.flashes.clear()
    this.performance = { take: this.newTake(time, false), armed: this.settings.armed }
    this.lastTime = time
    this.overlayAt = time
    this.schedule()
  }

  private finish(end: Seconds) {
    const perf = this.performance
    if (!perf) return
    this.performance = null
    this.nextTakeId = newId()
    const take = perf.take
    take.end = Math.max(take.start, end)
    if (!perf.armed || take.end - take.start < 1e-3) return
    const meaningful = take.events.length > 0 || Object.values(take.pads).length > 0
    if (meaningful) this.commit(take)
  }

  private convert(project: Project, take: Take, quantize: QuantizeSettings | null): TakeConversion {
    return takeToCommands(project, take, {
      catalog: this.catalog(),
      grid: beatGridOf(project),
      quantize,
      mode: this.settings.mode,
    })
  }

  private commit(take: Take) {
    const project = this.editor.getProject()
    const quantize = this.settings.quantize.enabled && beatGridOf(project) ? this.settings.quantize : null
    const record: TakeRecord = {
      take,
      number: this.takes.length + 1,
      status: 'kept',
      createdTracks: [],
      quantize,
    }
    try {
      const conversion = this.convert(project, take, quantize)
      if (conversion.commands.length === 0) return
      this.editor.dispatch(conversion.commands, { label: `VJ take ${record.number}` })
      record.committed = this.editor.getProject()
      record.summary = conversion.summary
      record.createdTracks = conversion.commands.flatMap((c) => (c.type === 'track.add' ? [c.track.id] : []))
      Object.assign(this.cursors, conversion.cursors)
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      this.error = `Take ${record.number} couldn’t be added to the timeline: ${record.error}`
    }
    this.takes.push(record)
  }

  /** Removes a kept take from the timeline: undo if it is the last edit, otherwise removes its clips. */
  discardTake(id: string): void {
    const record = this.takes.find((r) => r.take.id === id)
    if (!record || record.status !== 'kept') return
    if (record.committed && this.editor.getProject() === record.committed) {
      this.editor.undo()
    } else {
      const project = this.editor.getProject()
      const ids = Object.values(project.clips)
        .filter((c) => takeOfClip(c) === id)
        .map((c) => c.id)
      const remaining = new Set(
        Object.values(project.clips)
          .filter((c) => !ids.includes(c.id))
          .map((c) => c.trackId),
      )
      const tracks = record.createdTracks.filter(
        (t) => project.tracks.some((x) => x.id === t) && !remaining.has(t),
      )
      const commands = [
        ...(ids.length > 0 ? [{ type: 'clip.remove' as const, clipIds: ids }] : []),
        ...tracks.map((trackId) => ({ type: 'track.remove' as const, trackId })),
      ]
      if (commands.length > 0 && !this.dispatchSafely(commands, `Discard VJ take ${record.number}`)) return
    }
    record.status = 'discarded'
    this.emit()
  }

  /** Re-applies the latest take with different quantizing, still as one undo step. */
  requantizeTake(id: string, quantize: QuantizeSettings | null): void {
    const record = this.takes.findLast((r) => r.status === 'kept')
    if (!record || record.take.id !== id || this.editor.getProject() !== record.committed) return
    this.editor.undo()
    const project = this.editor.getProject()
    try {
      const conversion = this.convert(project, record.take, quantize?.enabled ? quantize : null)
      this.editor.dispatch(conversion.commands, { label: `VJ take ${record.number}` })
      record.committed = this.editor.getProject()
      record.summary = conversion.summary
      record.quantize = quantize?.enabled ? quantize : null
    } catch (error) {
      this.editor.redo()
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.emit()
  }

  private dispatchSafely(commands: Parameters<ProjectEditor['dispatch']>[0], label: string): boolean {
    try {
      this.editor.dispatch(commands, { label })
      return true
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
      return false
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Live preview

  private schedule() {
    if (this.frame !== null || this.disposed) return
    this.frame = this.requestFrame(() => {
      this.frame = null
      this.onFrame()
    })
  }

  private onFrame() {
    if (this.disposed) return
    const performing = this.performance !== null
    if (performing) {
      this.lastTime = this.preview.clock.currentTime()
      if (this.lastTime - this.overlayAt > OVERLAY_REFRESH) this.dirtyOverlay = true
    }
    if (this.dirtyOverlay) this.refreshOverlay()
    if (this.dirtySnapshot) this.emit()
    if (performing) this.schedule()
  }

  /** Shows the project with the live performance applied: the take being recorded, or the pending pad state. */
  private refreshOverlay() {
    if (this.disposed) return
    this.dirtyOverlay = false
    const base = this.editor.getProject()
    const time = this.preview.clock.currentTime()
    this.overlayAt = time
    const take = this.performance?.take ?? this.newTake(time, true)
    try {
      const conversion = takeToCommands(base, take, {
        catalog: this.catalog(),
        end: projectDuration(base),
        grid: beatGridOf(base),
        mode: this.settings.mode,
        horizon: time + STROBE_HORIZON,
      })
      this.lanes = conversion.lanes
      this.preview.setProject(applyCommands(base, conversion.commands))
    } catch (error) {
      console.warn('VJ live preview failed', error)
      this.lanes = []
      this.preview.setProject(base)
    }
  }

  private resetForNewProject() {
    if (this.performance) this.performance = null
    this.pressed.clear()
    this.resetLatch()
    this.latch.momentary = []
    this.takes.length = 0
    this.cursors = {}
    this.knobs = {}
    this.bank = 0
  }

  /** Ends VJ mode: stops playback (the running take lands on the timeline) and hands the preview back. */
  close(): { kept: number } {
    if (this.preview.clock.state === 'playing') this.preview.pause()
    if (this.performance) this.finish(this.preview.clock.currentTime())
    const kept = this.takes.filter((r) => r.status === 'kept').length
    this.dispose()
    return { kept }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frame !== null) this.cancelFrame(this.frame)
    for (const f of this.flashes.values()) this.clearTimer(f.timer)
    this.flashes.clear()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.listeners.clear()
    if (this.prefetched) this.preview.prefetch?.([])
    this.preview.setProject(this.editor.getProject())
  }
}
