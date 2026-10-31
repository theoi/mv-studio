/**
 * Live VJ mode data. A layout says what each pad triggers (switch to a clip, fire or hold an effect, switch a look);
 * bindings say which key, MIDI note or MIDI CC plays each pad; a take is a recorded performance that converts into
 * ordinary timeline content through edit commands (./convert.ts).
 */
import type { ColorAdjustmentKey, Id, ParamValue, Seconds } from '../model/types.ts'

export type PadRow = 'clips' | 'effects' | 'looks'

/** Pads per row; clip pads come in banks of this size. */
export const ROW_SIZE: Record<PadRow, number> = { clips: 10, effects: 9, looks: 8 }

export type ClipSource =
  | { type: 'asset'; assetId: Id }
  | { type: 'generator'; generatorId: string; params?: Record<string, ParamValue> }
  | { type: 'solid'; color: string }

/**
 * Where a video pad's footage is when it is cut to: 'resume' continues where that pad left off, 'restart' starts
 * from the beginning on every press, 'sync' follows the song time (footage shot to the track).
 */
export type ClipPlayback = 'resume' | 'restart' | 'sync'

export interface ClipPadAction {
  kind: 'clip'
  /** null clears the VJ layer so the timeline underneath shows. */
  source: ClipSource | null
  /** 'latch' stays until another clip pad; 'momentary' shows while held, then returns to the latched clip. */
  trigger: 'latch' | 'momentary'
  playback: ClipPlayback
}

/**
 * What an effect pad does to the picture. `amount` (0..1) scales it:
 * - 'effect': a registry effect on an adjustment clip; amount drives `amountParam` from range[0] to range[1]
 *   (resolved from the catalog when omitted), or the clip opacity when the effect has no suitable parameter.
 * - 'adjust': color adjustments on an adjustment clip, at `adjustments` values when amount is 1.
 * - 'flash': a full-frame solid whose opacity follows the amount; `strobe` flashes per beat while active.
 * - 'freeze': holds the current frame of the VJ footage while active (its clips play at speed 0).
 */
export type FxSpec =
  | {
      type: 'effect'
      effectId: string
      params?: Record<string, ParamValue>
      amountParam?: string
      range?: [number, number]
    }
  | { type: 'adjust'; adjustments: Partial<Record<ColorAdjustmentKey, number>> }
  | { type: 'flash'; color: string; strobe?: number }
  | { type: 'freeze' }

/**
 * 'one-shot' fires and decays over `decay` seconds; 'hold' is on while held; 'toggle' flips on each press; 'knob' is
 * on whenever its knob is above zero.
 */
export type FxTrigger = 'one-shot' | 'hold' | 'toggle' | 'knob'

export interface EffectPadAction {
  kind: 'effect'
  fx: FxSpec
  trigger: FxTrigger
  decay: Seconds
  /** Amount at full velocity with the knob fully up, 0..1. */
  amount: number
  /** Scale the amount by MIDI note velocity. */
  velocity: boolean
}

export interface LookSpec {
  adjustments?: Partial<Record<ColorAdjustmentKey, number>>
  effects?: { effectId: string; params?: Record<string, ParamValue> }[]
}

export interface LookPadAction {
  kind: 'look'
  /** null is "Original": no look. */
  look: LookSpec | null
}

export type PadAction = ClipPadAction | EffectPadAction | LookPadAction

export interface Pad {
  /** Stable id; recorded takes and timeline lanes refer to it. */
  id: string
  label: string
  action: PadAction
}

/** Saved with the project as project.extensions.vj once the user edits it; otherwise generated (./layout.ts). */
export interface VjLayout {
  version: 1
  /** Banks of clip pads; the clips row shows one bank at a time. */
  clipBanks: (Pad | null)[][]
  effects: (Pad | null)[]
  looks: (Pad | null)[]
  /** Pad ids the user removed, so they are not added back automatically. */
  dismissed?: string[]
}

// ---------------------------------------------------------------------------------------------------------------
// Device bindings (global, per browser)

export type TransportAction = 'play' | 'record' | 'bank-next' | 'bank-prev' | 'panic' | 'exit'

export type BindingTarget =
  /** For the clips row, `index` is the slot in the current bank. */
  | { kind: 'pad'; row: PadRow; index: number }
  /** The amount of the effect pad at this index. */
  | { kind: 'knob'; index: number }
  | { kind: 'transport'; action: TransportAction }

export interface MidiMatch {
  type: 'note' | 'cc'
  number: number
  /** 1..16; any channel when omitted. */
  channel?: number
  /** Input port name; any device when omitted. */
  device?: string
}

export interface VjBindings {
  version: 1
  /** Key id ('KeyQ', 'Shift+KeyZ'; physical KeyboardEvent.code) to target. */
  keys: Record<string, BindingTarget>
  midi: { match: MidiMatch; target: BindingTarget }[]
}

// ---------------------------------------------------------------------------------------------------------------
// Takes

/** Times are timeline seconds of what the user heard when they pressed (see ./timing.ts). */
export type VjEvent =
  | { t: Seconds; type: 'press'; pad: string; velocity: number }
  | { t: Seconds; type: 'release'; pad: string }
  /** A knob move: the amount (0..1) of an effect pad. */
  | { t: Seconds; type: 'amount'; pad: string; value: number }

export interface PadSnapshot extends Pad {
  row: PadRow
  /** Position in its row; orders the effect lanes on the timeline. */
  index: number
}

export interface Take {
  id: string
  start: Seconds
  /** Unset while recording. */
  end?: Seconds
  /** Every pad the take uses, as it was when pressed, so later layout edits do not change the take. */
  pads: Record<string, PadSnapshot>
  events: VjEvent[]
  /** Knob amounts at the take start, by effect pad id (1 when absent). */
  amounts: Record<string, number>
  /** Footage position at the take start for 'resume' clip pads, by pad id. */
  cursors: Record<string, Seconds>
}

/** Grid for quantizing, with the beat as a quarter note: a bar, a beat, eighths, eighth triplets or sixteenths. */
export type QuantizeGrid = 'bar' | '1/4' | '1/8' | '1/8T' | '1/16'

export interface QuantizeSettings {
  enabled: boolean
  grid: QuantizeGrid
  /** 0..1: how far each hit moves toward the grid. */
  strength: number
}

export interface VjSettings {
  quantize: QuantizeSettings
  /** Added input latency to compensate (positive when presses land late), from calibration. */
  inputOffsetMs: number
  /** 'overdub' replaces only the lanes played in a take; 'replace' clears every VJ lane over the take. */
  mode: 'overdub' | 'replace'
  /** Record takes while playing; when off, playing is a rehearsal and nothing is added to the timeline. */
  armed: boolean
}

export const DEFAULT_SETTINGS: VjSettings = {
  quantize: { enabled: false, grid: '1/8', strength: 1 },
  inputOffsetMs: 0,
  mode: 'overdub',
  armed: true,
}
