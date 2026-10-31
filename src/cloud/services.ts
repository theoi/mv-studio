/**
 * Entry point for cloud features: builds providers from the saved settings and keeps them in sync when keys change.
 * Providers are pluggable: registerGenerationProvider() adds another image/video provider next to fal.ai.
 */
import { FalProvider } from './fal/provider.ts'
import type { CloudSettings, CloudSettingsStore } from './keys.ts'
import { llmEndpointFromSettings, OpenAICompatibleClient } from './llm/client.ts'
import { llmPreset, llmTimeoutSeconds } from './llm/presets.ts'
import type { GenerationModel, MediaGenerationProvider, TranscriptionProvider } from './types.ts'

export interface ProviderDeps {
  fetch?: typeof fetch
}

export interface GenerationProviderFactory {
  id: string
  name: string
  /** Returns a provider when the settings hold what it needs (usually a key), else undefined. */
  create(
    getSettings: () => CloudSettings,
    deps: ProviderDeps,
  ): (MediaGenerationProvider & Partial<TranscriptionProvider>) | undefined
  isConfigured(settings: CloudSettings): boolean
}

const factories: GenerationProviderFactory[] = [
  {
    id: 'fal',
    name: 'fal.ai',
    create: (getSettings, deps) => new FalProvider({ getKey: () => getSettings().falKey, fetch: deps.fetch }),
    isConfigured: (s) => s.falKey.length > 0,
  },
]

export function registerGenerationProvider(factory: GenerationProviderFactory): void {
  const i = factories.findIndex((f) => f.id === factory.id)
  if (i >= 0) factories[i] = factory
  else factories.push(factory)
}

export interface CloudStatus {
  generation: 'ready' | 'needs-key'
  llm: 'ready' | 'needs-setup'
  /** True when the LLM runs on this computer (Ollama, LM Studio). */
  llmLocal: boolean
}

export class CloudServices {
  readonly settings: CloudSettingsStore
  private readonly deps: ProviderDeps
  private readonly providers = new Map<string, MediaGenerationProvider & Partial<TranscriptionProvider>>()
  private llmClient?: { signature: string; client: OpenAICompatibleClient }

  constructor(settings: CloudSettingsStore, deps: ProviderDeps = {}) {
    this.settings = settings
    this.deps = deps
  }

  status(): CloudStatus {
    const s = this.settings.get()
    return {
      generation: factories.some((f) => f.isConfigured(s)) ? 'ready' : 'needs-key',
      llm: this.settings.hasLlm() ? 'ready' : 'needs-setup',
      llmLocal: !!s.llm && llmPreset(s.llm.preset).local,
    }
  }

  /** Every provider, configured or not (for model pickers that show "needs a key"). */
  allGenerationProviders(): MediaGenerationProvider[] {
    return factories.map((f) => this.provider(f)).filter((p): p is MediaGenerationProvider => !!p)
  }

  /** The first provider with a key, or undefined when none is configured. */
  generation(): MediaGenerationProvider | undefined {
    const s = this.settings.get()
    const factory = factories.find((f) => f.isConfigured(s))
    return factory ? this.provider(factory) : undefined
  }

  transcription(): TranscriptionProvider | undefined {
    const s = this.settings.get()
    for (const f of factories) {
      if (!f.isConfigured(s)) continue
      const p = this.provider(f)
      if (p?.transcribe && p.estimateTranscription) return p as TranscriptionProvider
    }
    return undefined
  }

  models(): GenerationModel[] {
    return this.allGenerationProviders().flatMap((p) => [...p.models])
  }

  /** A client for the configured LLM endpoint, or undefined when none is set up. */
  llm(): OpenAICompatibleClient | undefined {
    const s = this.settings.get().llm
    if (!s || !this.settings.hasLlm()) return undefined
    const signature = JSON.stringify(s)
    if (this.llmClient?.signature !== signature) {
      this.llmClient = {
        signature,
        client: new OpenAICompatibleClient(llmEndpointFromSettings(s), {
          fetch: this.deps.fetch,
          timeoutMs: llmTimeoutSeconds(s) * 1000,
        }),
      }
    }
    return this.llmClient.client
  }

  private provider(factory: GenerationProviderFactory) {
    let p = this.providers.get(factory.id)
    if (!p) {
      p = factory.create(() => this.settings.get(), this.deps)
      if (p) this.providers.set(factory.id, p)
    }
    return p
  }
}
