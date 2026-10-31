/** Saves the per-browser VJ setup (device bindings and settings) in localStorage. */
import { z } from 'zod'
import { defaultBindings, normalizeBindings } from './bindings.ts'
import { DEFAULT_SETTINGS, type VjBindings, type VjSettings } from './types.ts'

const BINDINGS_KEY = 'mv-studio:vj:bindings'
const SETTINGS_KEY = 'mv-studio:vj:settings'

export interface VjStore {
  loadBindings(): VjBindings | null
  saveBindings(bindings: VjBindings): void
  loadSettings(): VjSettings | null
  saveSettings(settings: VjSettings): void
}

const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pad'), row: z.enum(['clips', 'effects', 'looks']), index: z.number().int() }),
  z.object({ kind: z.literal('knob'), index: z.number().int() }),
  z.object({
    kind: z.literal('transport'),
    action: z.enum(['play', 'record', 'bank-next', 'bank-prev', 'panic', 'exit']),
  }),
])
const bindingsSchema = z.object({
  version: z.literal(1),
  keys: z.record(z.string(), target),
  midi: z.array(
    z.object({
      match: z.object({
        type: z.enum(['note', 'cc']),
        number: z.number().int().min(0).max(127),
        channel: z.number().int().min(1).max(16).optional(),
        device: z.string().optional(),
      }),
      target,
    }),
  ),
})
const settingsSchema = z.object({
  quantize: z.object({
    enabled: z.boolean(),
    grid: z.enum(['bar', '1/4', '1/8', '1/8T', '1/16']),
    strength: z.number().min(0).max(1),
  }),
  inputOffsetMs: z.number().min(-500).max(500),
  mode: z.enum(['overdub', 'replace']),
  armed: z.boolean(),
})

function read(storage: Storage, key: string): unknown {
  try {
    const raw = storage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

function write(storage: Storage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('Could not save VJ settings', error)
  }
}

/** A store backed by localStorage, or null where there is none. */
export function localVjStore(storage: Storage | undefined = globalThis.localStorage): VjStore | null {
  if (!storage) return null
  return {
    loadBindings() {
      const parsed = bindingsSchema.safeParse(read(storage, BINDINGS_KEY))
      return parsed.success ? normalizeBindings(parsed.data as VjBindings) : null
    },
    saveBindings: (bindings) => write(storage, BINDINGS_KEY, bindings),
    loadSettings() {
      const value = read(storage, SETTINGS_KEY)
      if (typeof value !== 'object' || value === null) return null
      const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...value })
      return parsed.success ? parsed.data : null
    },
    saveSettings: (settings) => write(storage, SETTINGS_KEY, settings),
  }
}

/** Bindings from the store, or the defaults. */
export function loadBindings(store: VjStore | null): VjBindings {
  return store?.loadBindings() ?? defaultBindings()
}
