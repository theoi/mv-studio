/**
 * Which key or MIDI control plays which pad. Keys are physical (KeyboardEvent.code), so the layout is the same on
 * every keyboard language. Combinations with Ctrl, Cmd or Alt are never bound: they stay with the browser.
 */
import { ROW_SIZE, type BindingTarget, type MidiMatch, type PadRow, type VjBindings } from './types.ts'
import type { MidiMessage } from './midi.ts'

export const KEY_ROWS: Record<PadRow, string[]> = {
  clips: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
  effects: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'],
  looks: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'],
}

/** Keys the browser or the operating system needs; they cannot be learned. */
const RESERVED = new Set([
  'Tab',
  'CapsLock',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'ContextMenu',
  'Fn',
  'PrintScreen',
  'NumLock',
  'ScrollLock',
  'Pause',
])

export function isBindableKey(code: string): boolean {
  return code !== '' && !RESERVED.has(code) && !/^F\d+$/.test(code)
}

export function keyId(code: string, shift: boolean): string {
  return shift ? `Shift+${code}` : code
}

export function defaultBindings(): VjBindings {
  const keys: Record<string, BindingTarget> = {}
  for (const row of Object.keys(KEY_ROWS) as PadRow[])
    KEY_ROWS[row].forEach((code, index) => (keys[code] = { kind: 'pad', row, index }))
  keys.Space = { kind: 'transport', action: 'play' }
  keys['Shift+KeyZ'] = { kind: 'transport', action: 'record' }
  keys.BracketLeft = { kind: 'transport', action: 'bank-prev' }
  keys.BracketRight = { kind: 'transport', action: 'bank-next' }
  keys.Backspace = { kind: 'transport', action: 'panic' }
  keys.Escape = { kind: 'transport', action: 'exit' }
  return { version: 1, keys, midi: presetMidi('pads') }
}

/**
 * The first note of each default MIDI mapping: pads on most controllers send notes from 36 up (General MIDI drums),
 * keyboards are played from middle C (60).
 */
export const MIDI_PRESETS = { pads: 36, keys: 60 } as const
export type MidiPreset = keyof typeof MIDI_PRESETS

/**
 * A default MIDI mapping: 16 notes from the preset's first one play clips 1-8 and effects 1-8. Knob blocks commonly
 * send CC 21-28 (Novation, Arturia) or CC 70-77 (Akai); CC 1 is the mod wheel.
 */
export function presetMidi(preset: MidiPreset): VjBindings['midi'] {
  const first = MIDI_PRESETS[preset]
  const midi: VjBindings['midi'] = []
  for (let i = 0; i < 8; i++) {
    midi.push({ match: { type: 'note', number: first + i }, target: { kind: 'pad', row: 'clips', index: i } })
    midi.push({
      match: { type: 'note', number: first + 8 + i },
      target: { kind: 'pad', row: 'effects', index: i },
    })
    midi.push({ match: { type: 'cc', number: 21 + i }, target: { kind: 'knob', index: i } })
    midi.push({ match: { type: 'cc', number: 70 + i }, target: { kind: 'knob', index: i } })
  }
  midi.push({ match: { type: 'cc', number: 1 }, target: { kind: 'knob', index: 0 } })
  return midi
}

/** The default mapping the MIDI bindings are, or null when some were mapped by hand. */
export function midiPresetOf(bindings: VjBindings): MidiPreset | null {
  const midi = JSON.stringify(bindings.midi)
  return (
    (Object.keys(MIDI_PRESETS) as MidiPreset[]).find((p) => JSON.stringify(presetMidi(p)) === midi) ?? null
  )
}

/** The bindings with a default MIDI mapping in place of the current one; keys stay as they are. */
export function withMidiPreset(bindings: VjBindings, preset: MidiPreset): VjBindings {
  return { ...bindings, midi: presetMidi(preset) }
}

export function sameTarget(a: BindingTarget, b: BindingTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'pad' && b.kind === 'pad') return a.row === b.row && a.index === b.index
  if (a.kind === 'knob' && b.kind === 'knob') return a.index === b.index
  return a.kind === 'transport' && b.kind === 'transport' && a.action === b.action
}

/** The target of a key press. With Shift held, a Shift binding wins over the plain key. */
export function targetForKey(bindings: VjBindings, code: string, shift: boolean): BindingTarget | undefined {
  return (shift ? bindings.keys[keyId(code, true)] : undefined) ?? bindings.keys[code]
}

function midiMatches(match: MidiMatch, msg: MidiMessage): boolean {
  const type = msg.type === 'cc' ? 'cc' : 'note'
  return (
    match.type === type &&
    match.number === msg.number &&
    (match.channel === undefined || match.channel === msg.channel) &&
    (match.device === undefined || match.device === msg.deviceName)
  )
}

/** Targets of a MIDI message. A binding for a specific device or channel hides the generic ones for that control. */
export function targetsForMidi(bindings: VjBindings, msg: MidiMessage): BindingTarget[] {
  const hits = bindings.midi.filter((b) => midiMatches(b.match, msg))
  const specific = hits.filter((b) => b.match.device !== undefined || b.match.channel !== undefined)
  return (specific.length > 0 ? specific : hits).map((b) => b.target)
}

/** Binds a key to a target. The key leaves its previous target and the target leaves its previous key. */
export function bindKey(bindings: VjBindings, key: string, target: BindingTarget): VjBindings {
  const keys: Record<string, BindingTarget> = {}
  for (const [k, t] of Object.entries(bindings.keys)) if (k !== key && !sameTarget(t, target)) keys[k] = t
  keys[key] = target
  return { ...bindings, keys }
}

/** Binds a MIDI note or CC (from this device and channel) to a target, replacing its earlier MIDI bindings. */
export function bindMidi(bindings: VjBindings, match: MidiMatch, target: BindingTarget): VjBindings {
  const sameControl = (m: MidiMatch) =>
    m.type === match.type &&
    m.number === match.number &&
    (m.channel === undefined || match.channel === undefined || m.channel === match.channel) &&
    (m.device === undefined || match.device === undefined || m.device === match.device)
  const midi = bindings.midi.filter((b) => !sameControl(b.match) && !sameTarget(b.target, target))
  return { ...bindings, midi: [...midi, { match, target }] }
}

export function keyForTarget(bindings: VjBindings, target: BindingTarget): string | undefined {
  return Object.entries(bindings.keys).find(([, t]) => sameTarget(t, target))?.[0]
}

export function midiForTarget(bindings: VjBindings, target: BindingTarget): MidiMatch | undefined {
  const all = bindings.midi.filter((b) => sameTarget(b.target, target))
  return (all.find((b) => b.match.device !== undefined) ?? all[0])?.match
}

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Backspace: 'Backspace',
  Escape: 'Esc',
  Enter: 'Enter',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
}

/** Short label for a key id, e.g. 'KeyQ' → 'Q', 'Shift+KeyZ' → 'Shift Z'. */
export function keyLabel(key: string): string {
  const shift = key.startsWith('Shift+')
  const code = shift ? key.slice(6) : key
  const base =
    CODE_LABELS[code] ??
    (code.startsWith('Key') ? code.slice(3) : null) ??
    (code.startsWith('Digit') ? code.slice(5) : null) ??
    (code.startsWith('Numpad') ? `Num ${code.slice(6)}` : null) ??
    code
  return shift ? `Shift ${base}` : base
}

/** Short label for a MIDI binding, e.g. 'Note 36' or 'CC 21 · ch 2'. */
export function midiLabel(match: MidiMatch): string {
  const base = match.type === 'note' ? `Note ${match.number}` : `CC ${match.number}`
  return match.channel === undefined ? base : `${base} · ch ${match.channel}`
}

/** Bindings for the targets that exist: pad indexes outside the rows are dropped. */
export function normalizeBindings(bindings: VjBindings): VjBindings {
  const valid = (t: BindingTarget) =>
    t.kind === 'transport' ||
    (t.kind === 'knob' && t.index >= 0 && t.index < ROW_SIZE.effects) ||
    (t.kind === 'pad' && t.index >= 0 && t.index < ROW_SIZE[t.row])
  const keys: Record<string, BindingTarget> = {}
  for (const [k, t] of Object.entries(bindings.keys)) if (valid(t)) keys[k] = t
  return { version: 1, keys, midi: bindings.midi.filter((b) => valid(b.target)) }
}
