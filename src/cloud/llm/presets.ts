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

/**
 * Picks the model to preselect after the list loads: the recommended one when it is there, else the first preferred
 * match that isn't a small model (below SMALL_MODEL_BILLIONS), else the first preferred match, else the first model.
 */
export function pickDefaultModel(models: string[], presetId: LlmPresetId): string | undefined {
  const recommended = RECOMMENDED_MODELS.find((r) => r.preset === presetId)?.model
  if (recommended && models.includes(recommended)) return recommended
  const big = (m: string) => (modelSizeBillions(m) ?? SMALL_MODEL_BILLIONS) >= SMALL_MODEL_BILLIONS
  const ranked = llmPreset(presetId).preferredModels.flatMap((p) => models.filter((m) => p.test(m)))
  return ranked.find(big) ?? ranked[0] ?? models.find(big) ?? models[0]
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
      'In the server settings, turn on “Enable CORS”.',
      'Load a model in LM Studio.',
      lna,
      'Choose Test connection again.',
    ]
  }
  return [
    'Make sure the server is running and the base URL ends with /v1.',
    `Allow requests from ${origin} in the server’s CORS settings.`,
    lna,
    'Choose Test connection again.',
  ]
}

/**
 * A context length that holds Ask's prompts on most projects: 11,000 to 16,000 tokens on the sample project. A long
 * draft makes them longer (17,700 tokens with 208 shots), and contextFor() then asks for more.
 */
export const LOCAL_CONTEXT_TOKENS = 16384

/** Context lengths the Ollama app offers in Settings › Context length, from LOCAL_CONTEXT_TOKENS up. */
const CONTEXT_SIZES = [LOCAL_CONTEXT_TOKENS, 32768, 65536, 131072] as const

/**
 * A request's tokens as Qwen 2.5 counts them, from its JSON: about 4.4 characters per token for words and JSON, 1.35
 * tokens per digit (Qwen reads each digit as a token of its own, and numbers bring their points and commas), and a
 * token or more for each character outside ASCII (wideTokens()). On the Ask and director requests measured
 * (llm.contract.test.ts) it is 0.3 to 1.8% over Qwen's count, and 1 to 6% under when the clips are UUIDs or short
 * phrases (see ESTIMATE_MARGIN); a flat 4 characters per token was 4% over on director requests and 17 to 20% under on
 * Ask requests after a long draft, whose shots bring thousands of digits. Llama 3 groups digits in threes, so for it
 * this errs high.
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let digits = 0
  let wide = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 48 && c <= 57) digits++
    else if (c > 127) wide += wideTokens(c)
    else ascii++
  }
  return ascii / 4.4 + digits * 1.35 + wide
}

/**
 * Qwen 2.5's tokens for a character outside ASCII, measured on lyric lines. Hangul, Georgian, Armenian and the Indic
 * scripts take more than one (Hangul 1 to 1.36 depending on the syllables, Georgian and Armenian 1.1 to 1.17,
 * Devanagari, Bengali and Tamil 1.2 to 1.32, the other Indic scripts and Sinhala 1.47 to 1.85); Greek, CJK, emoji and
 * typographic quotes about one or less, and Cyrillic, Arabic, Hebrew and Thai about half, which errs high.
 */
function wideTokens(c: number): number {
  if ((c >= 0x0900 && c <= 0x09ff) || (c >= 0x0b80 && c <= 0x0bff)) return 1.35
  if (c >= 0x0a00 && c <= 0x0dff) return 1.9
  if ((c >= 0x0530 && c <= 0x058f) || (c >= 0x10a0 && c <= 0x10ff)) return 1.25
  if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0xac00 && c <= 0xd7af)) return 1.3
  return 1
}

/**
 * How far over its estimate a request may run. Measured requests came out 0.94 to 1.02 of Qwen's count, the lowest a
 * shot list made of short phrases ("label": "Chorus, clip", "mood": "euphoric, peak, neon night drive").
 */
export const ESTIMATE_MARGIN = 1.08

/** The smallest of CONTEXT_SIZES that holds a request estimated at `tokens` with room for the answer. */
export function contextFor(tokens = 0): number {
  const needed = tokens * ESTIMATE_MARGIN + 1024
  return CONTEXT_SIZES.find((n) => n >= needed) ?? 131072
}

const kTokens = (n: number) => `${n / 1024}k`

/** "Raise Ollama’s context length to 16k": the fix for a request of about `tokens` that a local runner cut short. */
export function raiseContextLength(runner: 'ollama' | 'lmstudio' | 'other', tokens?: number): string {
  const owner = runner === 'ollama' ? 'Ollama’s' : runner === 'lmstudio' ? 'LM Studio’s' : 'the model’s'
  return `Raise ${owner} context length to ${kTokens(contextFor(tokens))}`
}

/**
 * Steps for giving a local runner a context length that holds the whole request of about `tokens`. Steps starting
 * with two spaces are alternatives under the step before them (see nestSteps()).
 */
export function contextLengthSteps(
  runner: 'ollama' | 'lmstudio' | 'other',
  model = '',
  tokens?: number,
): string[] {
  const n = contextFor(tokens)
  if (runner === 'ollama') {
    // KV cache over Ollama's 4k default: Qwen2.5 7B 56 KB per token, Llama 3.1 8B and Mistral 7B 128 KB.
    const gb = (perToken: number) => (((n - 4096) * perToken) / 1024 ** 2).toFixed(1)
    return [
      `${raiseContextLength(runner, tokens)}, then try again:`,
      `  Ollama app (macOS, Windows): Settings › Context length › ${kTokens(n)}.`,
      `  Linux: run sudo systemctl edit ollama, add Environment="OLLAMA_CONTEXT_LENGTH=${n}" under [Service], then sudo systemctl restart ollama.`,
      `  From a terminal: OLLAMA_CONTEXT_LENGTH=${n} ollama serve`,
      model.startsWith('qwen2.5:7b')
        ? `A larger context uses more memory: about ${gb(56)} GB more for qwen2.5:7b.`
        : `A larger context uses more memory, up to about ${gb(128)} GB for 7B and 8B models.`,
    ]
  }
  if (runner === 'lmstudio') {
    return [`In LM Studio, load the model again with Context Length set to ${n} or more, then try again.`]
  }
  return [
    `Give the model a context length of at least ${n.toLocaleString('en-US')} tokens in the server’s settings, then try again.`,
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
