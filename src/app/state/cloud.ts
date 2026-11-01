import { create } from 'zustand'
import { CloudError } from '../../cloud/errors.ts'
import {
  CloudSettingsStore,
  type CloudSettings,
  type LlmPresetId,
  type LlmSettings,
} from '../../cloud/keys.ts'
import { llmPreset } from '../../cloud/llm/presets.ts'
import { useCloudSettings } from '../../cloud/react.ts'
import { SpendLedger } from '../../cloud/spend.ts'
import type { CloudServices } from '../../cloud/services.ts'
import type { LlmValidation } from '../../cloud/llm/client.ts'
import type { KeyCheck } from '../../cloud/types.ts'

/*
 * The user's cloud keys and settings (stored only in this browser), the services built from them, and the local
 * record of estimated spend. The fal.ai and LLM clients load on first use, so they stay out of the editor's bundle
 * until a cloud feature runs.
 */

export const cloudSettings = new CloudSettingsStore()
export const spendLedger = new SpendLedger()

export function useCloud(): CloudSettings {
  return useCloudSettings(cloudSettings)
}

let services: Promise<CloudServices> | undefined

/** Providers for the saved settings; they follow later changes to the keys. */
export function cloudServices(): Promise<CloudServices> {
  services ??= import('../../cloud/services.ts').then((m) => new m.CloudServices(cloudSettings))
  return services
}

let falKeyCheckMs: number | undefined

/** Checks a fal.ai key before saving it. Free: fal.ai checks the key without running anything. */
export async function testFalKey(key: string, signal?: AbortSignal): Promise<KeyCheck> {
  const { FalProvider } = await import('../../cloud/fal/provider.ts')
  return new FalProvider({
    getKey: () => key.trim(),
    ...(falKeyCheckMs ? { keyCheckTimeoutMs: falKeyCheckMs } : {}),
  }).validateKey(signal)
}

export function setFalKeyCheckTimeoutForTests(ms: number | undefined): void {
  falKeyCheckMs = ms
}

interface FalKeyEntry {
  /** The key as typed; saved only once fal.ai accepts it. */
  draft: string
  checking: boolean
  /** Why the last check failed. */
  error: CloudError | null
}

/** The fal.ai key typed in Settings and its check, kept in memory outside the dialog so closing Settings keeps them. */
export const useFalKeyEntry = create<FalKeyEntry>(() => ({ draft: '', checking: false, error: null }))

export function typeFalKey(draft: string): void {
  useFalKeyEntry.setState({ draft })
}

/** Checks the typed fal.ai key and saves it once fal.ai accepts it. True when it was saved. */
export async function connectFalKey(): Promise<boolean> {
  const { draft, checking } = useFalKeyEntry.getState()
  if (checking || !draft.trim()) return false
  useFalKeyEntry.setState({ checking: true, error: null })
  const result = await testFalKey(draft).catch((cause: unknown): KeyCheck => ({
    ok: false,
    error: new CloudError({
      kind: 'network',
      provider: 'fal',
      title: 'Couldn’t reach fal.ai',
      message:
        'MV Studio couldn’t load what it needs to check the key. This is usually a connection problem.',
      steps: ['Check your internet connection.', 'Choose Try again.'],
      cause,
    }),
  }))
  // The user typed another key while this one was checked: the result is not about what the field shows.
  if (useFalKeyEntry.getState().draft !== draft) {
    useFalKeyEntry.setState({ checking: false })
    return false
  }
  if (!result.ok) {
    useFalKeyEntry.setState({ checking: false, error: result.error })
    return false
  }
  cloudSettings.setFalKey(draft)
  useFalKeyEntry.setState({ draft: '', checking: false, error: null })
  return true
}

/** Checks an LLM endpoint and lists its models (GET /models, free on every provider). */
export async function testLlm(settings: LlmSettings, signal?: AbortSignal): Promise<LlmValidation> {
  const { OpenAICompatibleClient, llmEndpointFromSettings } = await import('../../cloud/llm/client.ts')
  return new OpenAICompatibleClient(llmEndpointFromSettings(settings)).validate(signal)
}

/** The four choices Settings shows: OpenRouter is "Other" with its URL. */
export type LlmChoice = 'openai' | 'ollama' | 'lmstudio' | 'custom'

export function choiceOf(preset: LlmPresetId): LlmChoice {
  return preset === 'openrouter' ? 'custom' : preset
}

/** The preset to save for a choice: an "Other" endpoint at openrouter.ai is OpenRouter (needs a key, has picks). */
export function presetFor(choice: LlmChoice, baseUrl: string): LlmPresetId {
  if (choice !== 'custom') return choice
  try {
    const host = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).hostname
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai') ? 'openrouter' : 'custom'
  } catch {
    return 'custom'
  }
}

/** A fresh endpoint for a choice, with its default URL. */
export function draftFor(choice: LlmChoice): LlmSettings {
  return { preset: choice, baseUrl: llmPreset(choice).baseUrl, apiKey: '', model: '' }
}

const PROVIDER_NAME: Record<LlmPresetId, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: '',
}

/** "Ollama · qwen2.5:7b" for a saved connection, or undefined when none is set up. */
export function llmLabel(llm: LlmSettings | null): string | undefined {
  if (!llm?.baseUrl || !llm.model) return undefined
  let name = PROVIDER_NAME[llm.preset]
  if (!name) {
    try {
      name = new URL(llm.baseUrl).host
    } catch {
      name = 'Your endpoint'
    }
  }
  return `${name} · ${llm.model}`
}
