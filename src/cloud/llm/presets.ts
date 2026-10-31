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
    preferredModels: [/^gpt-5(\.\d+)?-mini$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-5/, /^gpt-4/],
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
      /gpt-5(\.\d+)?-mini/,
      /gpt-4\.1-mini/,
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
