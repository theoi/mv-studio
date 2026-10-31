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

/** Checks a fal.ai key before saving it. Free: fal.ai checks the key without running anything. */
export async function testFalKey(key: string, signal?: AbortSignal): Promise<KeyCheck> {
  const { FalProvider } = await import('../../cloud/fal/provider.ts')
  return new FalProvider({ getKey: () => key.trim() }).validateKey(signal)
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
