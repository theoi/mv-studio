/** OpenAI-compatible endpoint presets, including local runners, with setup help for each. */
import type { LlmPresetId } from '../keys.ts'

export interface LlmPreset {
  id: LlmPresetId
  name: string
  baseUrl: string
  needsKey: boolean
  local: boolean
  keyUrl?: string
  /** One line under the preset in Settings. */
  description: string
  /** Patterns used to preselect a sensible model after the model list loads (first match wins). */
  preferredModels: RegExp[]
}

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    local: false,
    keyUrl: 'https://platform.openai.com/api-keys',
    description: 'Uses your OpenAI API key. Billed by OpenAI per request.',
    preferredModels: [/^gpt-4\.1-mini$/, /^gpt-5(\.\d+)?-mini$/, /^gpt-4o-mini$/, /^gpt-5/, /^gpt-4/],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    local: false,
    keyUrl: 'https://openrouter.ai/keys',
    description: 'One key for many models. Billed by OpenRouter per request.',
    preferredModels: [
      /gpt-4\.1-mini/,
      /gpt-5(\.\d+)?-mini/,
      /gpt-4o-mini/,
      /claude.*(sonnet|haiku)/,
      /gemini.*flash/,
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (on this computer)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    local: true,
    description:
      'Runs models on your own computer for free. Needs a one-time setting so this site may connect.',
    preferredModels: [/qwen3/, /qwen2\.5/, /llama3\.[1-9]/, /mistral/, /gemma3/],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (on this computer)',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    local: true,
    description: 'Runs models on your own computer for free. Turn on CORS in its server settings.',
    preferredModels: [/qwen3/, /qwen2\.5/, /llama-3\.[1-9]/, /mistral/, /gemma-3/],
  },
  {
    id: 'custom',
    name: 'Other OpenAI-compatible endpoint',
    baseUrl: '',
    needsKey: false,
    local: false,
    description: 'Any server that speaks the OpenAI chat completions API.',
    preferredModels: [],
  },
]

export function llmPreset(id: LlmPresetId): LlmPreset {
  return LLM_PRESETS.find((p) => p.id === id) ?? (LLM_PRESETS[LLM_PRESETS.length - 1] as LlmPreset)
}

/** Picks the model to preselect after the list loads: the first preferred match, else the first model. */
export function pickDefaultModel(models: string[], presetId: LlmPresetId): string | undefined {
  for (const pattern of llmPreset(presetId).preferredModels) {
    const match = models.find((m) => pattern.test(m))
    if (match) return match
  }
  return models[0]
}

/** The page origin local runners must allow, e.g. https://theoi.github.io. */
export function pageOrigin(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin && origin !== 'null' ? origin : 'https://theoi.github.io'
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
}

/** Which local runner a base URL most likely points to, from the preset or the default port. */
export function guessLocalRunner(baseUrl: string, presetId?: LlmPresetId): 'ollama' | 'lmstudio' | 'other' {
  if (presetId === 'ollama' || presetId === 'lmstudio') return presetId
  try {
    const port = new URL(baseUrl).port
    if (port === '11434') return 'ollama'
    if (port === '1234') return 'lmstudio'
  } catch {
    // fall through
  }
  return 'other'
}

/** Step-by-step instructions for letting this site reach a local runner. */
export function localSetupSteps(runner: 'ollama' | 'lmstudio' | 'other', origin = pageOrigin()): string[] {
  const lna =
    'If Chrome or Edge asks to let this site access devices on your local network, choose Allow. ' +
    'If you blocked it earlier, allow it again from the site settings (lock icon in the address bar).'
  if (runner === 'ollama') {
    return [
      'Make sure Ollama is running and has a model (for example: ollama pull qwen2.5:7b).',
      `Allow this site: set OLLAMA_ORIGINS to ${origin} and restart Ollama.`,
      `  macOS: run launchctl setenv OLLAMA_ORIGINS "${origin}", then quit and reopen Ollama.`,
      `  Windows: add a user environment variable OLLAMA_ORIGINS = ${origin}, then quit Ollama from the tray and start it again.`,
      `  Linux: run sudo systemctl edit ollama, add Environment="OLLAMA_ORIGINS=${origin}" under [Service], then sudo systemctl restart ollama.`,
      lna,
      'Choose Test connection again.',
    ]
  }
  if (runner === 'lmstudio') {
    return [
      'Open LM Studio, go to the Developer tab and start the local server.',
      'In the server settings, turn on "Enable CORS".',
      'Load a model in LM Studio.',
      lna,
      'Choose Test connection again.',
    ]
  }
  return [
    'Make sure the server is running and the base URL ends with /v1.',
    `Allow requests from ${origin} in the server's CORS settings.`,
    lna,
    'Choose Test connection again.',
  ]
}

/**
 * Answer time limits in seconds. Local models get much longer by default: the first request also loads the model, and
 * a 7B model on a CPU without a GPU needs minutes for a correct answer. Cancel stays visible while waiting.
 */
export const LLM_TIMEOUT = { cloud: 90, local: 300, min: 20, max: 600 } as const

/** True for local runners and other endpoints on this computer. */
export function isLocalEndpoint(endpoint: { preset?: LlmPresetId; baseUrl: string }): boolean {
  if (endpoint.preset && llmPreset(endpoint.preset).local) return true
  try {
    return isLoopbackHost(new URL(endpoint.baseUrl).hostname)
  } catch {
    return false
  }
}

/** How long to wait for one answer: the user's setting (clamped), else the default for the endpoint. */
export function llmTimeoutSeconds(settings: {
  preset?: LlmPresetId
  baseUrl: string
  timeoutSeconds?: number
}): number {
  const t = settings.timeoutSeconds
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
    return Math.min(LLM_TIMEOUT.max, Math.max(LLM_TIMEOUT.min, Math.round(t)))
  }
  return isLocalEndpoint(settings) ? LLM_TIMEOUT.local : LLM_TIMEOUT.cloud
}

export interface ModelRecommendation {
  preset: LlmPresetId
  /** Model id as the provider or runner names it. */
  model: string
  note: string
}

/** Shown in Settings next to the model picker. */
export const RECOMMENDED_MODELS: readonly ModelRecommendation[] = [
  {
    preset: 'openai',
    model: 'gpt-4.1-mini',
    note: 'Recommended. Fast, inexpensive and reliable at edits.',
  },
  {
    preset: 'openrouter',
    model: 'openai/gpt-4.1-mini',
    note: 'Recommended. Fast, inexpensive and reliable at edits.',
  },
  {
    preset: 'ollama',
    model: 'qwen2.5:7b',
    note: 'Good local choice for computers with 8 GB of free memory. Larger models (qwen2.5:14b) make better edits.',
  },
  {
    preset: 'lmstudio',
    model: 'qwen2.5-7b-instruct',
    note: 'Good local choice for computers with 8 GB of free memory. Larger models make better edits.',
  },
]

/** Size in billions of parameters read from a model id ("qwen2.5:3b", "Llama-3.1-8B", "mixtral-8x7b"), if any. */
export function modelSizeBillions(model: string): number | undefined {
  let size: number | undefined
  for (const m of model.toLowerCase().matchAll(/(?:^|[^a-z0-9.])(?:(\d+)x)?(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) {
    const n = Number(m[2]) * (m[1] ? Number(m[1]) : 1)
    if (Number.isFinite(n)) size = Math.max(size ?? 0, n)
  }
  return size
}

/** Below this size, local models often misplace or skip edits. */
export const SMALL_MODEL_BILLIONS = 7

/** A gentle hint for Settings and Ask when the configured local model is small; undefined otherwise. */
export function modelHint(
  settings: { preset?: LlmPresetId; baseUrl: string; model: string } | null | undefined,
): string | undefined {
  if (!settings || !isLocalEndpoint(settings)) return undefined
  const size = modelSizeBillions(settings.model)
  if (size === undefined || size >= SMALL_MODEL_BILLIONS) return undefined
  return (
    `This is a small model (${size}B). It can be slow on long requests and sometimes misplaces edits. ` +
    'For better results, use a 7B or larger model (for example qwen2.5:7b) or a cloud model. ' +
    'Ask shows changes for review before applying them.'
  )
}
