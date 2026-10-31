/**
 * Cloud settings and keys, stored only in this browser (localStorage, or sessionStorage when the user chooses not
 * to remember them). Nothing here is sent anywhere except to the provider the key belongs to. Never log the values.
 *
 * Works with React's useSyncExternalStore: useSyncExternalStore(settings.subscribe, settings.get)
 */

export type LlmPresetId = 'openai' | 'openrouter' | 'ollama' | 'lmstudio' | 'custom'

export interface LlmSettings {
  preset: LlmPresetId
  /** OpenAI-compatible base URL including /v1, e.g. https://api.openai.com/v1 */
  baseUrl: string
  /** Empty for local runners that need no key. */
  apiKey: string
  model: string
}

export interface CloudSettings {
  falKey: string
  llm: LlmSettings | null
  /** Ask before every paid generation, even small ones. */
  alwaysConfirmPaid: boolean
  /** Ask before a batch whose estimate exceeds this many US dollars. */
  confirmAboveUsd: number
  /** Optional monthly reminder threshold in US dollars (0 = off). */
  monthlyReminderUsd: number
  /** 'local' keeps keys after the browser closes; 'session' forgets them when the tab closes. */
  persistence: 'local' | 'session'
}

export const DEFAULT_CLOUD_SETTINGS: CloudSettings = {
  falKey: '',
  llm: null,
  alwaysConfirmPaid: false,
  confirmAboveUsd: 1,
  monthlyReminderUsd: 0,
  persistence: 'local',
}

/** User-facing explanation shown next to key fields in Settings. */
export const KEY_STORAGE_NOTICE =
  'Your keys stay in this browser. MV Studio has no server: keys are saved on this device only and sent ' +
  'directly to the provider they belong to (fal.ai or your LLM endpoint) when you use a cloud feature. ' +
  'Anyone with access to this browser profile can read them, so remove them on shared computers.'

export const SESSION_ONLY_NOTICE = 'Forget my keys when I close this tab.'

/** Minimal Storage subset so tests and non-browser contexts can supply their own. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class MemoryStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

const STORAGE_KEY = 'mv-studio.cloud.v1'

function safeStorage(kind: 'localStorage' | 'sessionStorage'): KeyValueStorage | undefined {
  try {
    const s = (globalThis as unknown as Record<string, KeyValueStorage | undefined>)[kind]
    if (!s) return undefined
    const probe = `${STORAGE_KEY}.probe`
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return undefined
  }
}

function parseSettings(raw: string | null): Partial<CloudSettings> | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null ? (value as Partial<CloudSettings>) : undefined
  } catch {
    return undefined
  }
}

export class CloudSettingsStore {
  private settings: CloudSettings
  private readonly listeners = new Set<() => void>()
  private readonly local?: KeyValueStorage
  private readonly session?: KeyValueStorage

  constructor(options: { local?: KeyValueStorage; session?: KeyValueStorage } = {}) {
    this.local = options.local ?? safeStorage('localStorage')
    this.session = options.session ?? safeStorage('sessionStorage')
    const saved =
      parseSettings(this.session?.getItem(STORAGE_KEY) ?? null) ??
      parseSettings(this.local?.getItem(STORAGE_KEY) ?? null) ??
      {}
    this.settings = { ...DEFAULT_CLOUD_SETTINGS, ...saved }
  }

  get = (): CloudSettings => this.settings

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(patch: Partial<CloudSettings>): void {
    this.settings = { ...this.settings, ...patch }
    this.persist()
    for (const l of this.listeners) l()
  }

  setFalKey(key: string): void {
    this.update({ falKey: key.trim() })
  }

  setLlm(llm: LlmSettings | null): void {
    this.update({ llm: llm ? { ...llm, baseUrl: llm.baseUrl.trim(), apiKey: llm.apiKey.trim() } : null })
  }

  /** Removes every stored key and LLM endpoint (Settings › "Remove all keys"). */
  clearKeys(): void {
    this.update({ falKey: '', llm: null })
  }

  hasFal(): boolean {
    return this.settings.falKey.length > 0
  }

  hasLlm(): boolean {
    const llm = this.settings.llm
    return !!llm && llm.baseUrl.length > 0 && llm.model.length > 0
  }

  private persist() {
    const json = JSON.stringify(this.settings)
    try {
      if (this.settings.persistence === 'session') {
        this.session?.setItem(STORAGE_KEY, json)
        this.local?.removeItem(STORAGE_KEY)
      } else {
        this.local?.setItem(STORAGE_KEY, json)
        this.session?.removeItem(STORAGE_KEY)
      }
    } catch {
      // Storage can be full or disabled; settings still work for this page load.
    }
  }
}
