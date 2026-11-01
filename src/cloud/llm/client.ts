/**
 * OpenAI-compatible chat client (OpenAI, OpenRouter, Ollama, LM Studio, or any compatible server), called directly
 * from the browser with the user's key. callTools() gets structured output from any of them: native tool calling
 * where the endpoint supports it, otherwise JSON mode, otherwise a JSON reply parsed out of plain text.
 */
import type { LlmPresetId, LlmSettings } from '../keys.ts'
import {
  browserOffline,
  cancelledError,
  CloudError,
  isFetchFailure,
  redactSecrets,
  type CloudErrorKind,
} from '../errors.ts'
import { extractJson, stripReasoning } from './json.ts'
import {
  contextLengthSteps,
  guessLocalRunner,
  isLocalEndpoint,
  isLoopbackHost,
  llmPreset,
  llmTimeoutSeconds,
  localSetupSteps,
  raiseContextLength,
  pageOrigin,
} from './presets.ts'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>
}

export type ToolChoice = 'auto' | 'required' | { name: string }

export interface ToolCallRequest {
  messages: ChatMessage[]
  tools: ToolDefinition[]
  toolChoice?: ToolChoice
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ParsedToolCall {
  id: string
  name: string
  args: unknown
  /** Set when the arguments were not valid JSON. */
  error?: string
}

/** How structured output was obtained from this endpoint. */
export type StructuredMode = 'tools' | 'json-object' | 'json-schema' | 'prompt'

export interface ToolCallResult {
  calls: ParsedToolCall[]
  /** The model's plain-language reply (may be empty). */
  text: string
  mode: StructuredMode
  /** Append to the conversation for a follow-up turn; works in every mode. */
  assistant: Extract<ChatMessage, { role: 'assistant' }>
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface LlmEndpoint {
  baseUrl: string
  apiKey?: string
  model?: string
  preset?: LlmPresetId
}

export interface LlmClientOptions {
  fetch?: typeof fetch
  /** Per-request timeout; defaults to llmTimeoutSeconds() for the endpoint. */
  timeoutMs?: number
  /** Overrides for tests; default to the current page. */
  pageOrigin?: string
  pageProtocol?: string
}

export type LlmValidation =
  { ok: true; models: string[]; baseUrl: string; message: string } | { ok: false; error: CloudError }

const MODES: StructuredMode[] = ['tools', 'json-object', 'json-schema', 'prompt']

/**
 * Ollama cuts a prompt longer than its context length without an error (it keeps the end) and counts only the kept
 * tokens in usage.prompt_tokens, so the model answers without its instructions. 4 characters per token is more than
 * tokenizers average on these JSON-heavy requests (Qwen 2.5: about 3.4), so the estimate errs low, and a count under
 * 60% of it means a cut, not a different tokenizer.
 */
const PROMPT_CUT = { charsPerToken: 4, ratio: 0.6, minTokens: 1000 } as const

const capabilityCache = new Map<string, StructuredMode>()

/** Forgets which structured-output mode each endpoint supports (for tests and after settings change). */
export function resetLlmCapabilities(): void {
  capabilityCache.clear()
}

const NON_CHAT_MODEL =
  /embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|search|sora|davinci|babbage/i

/** Cleans up a pasted base URL: adds a scheme, drops a pasted /chat/completions, adds /v1 for local runners. */
export function normalizeBaseUrl(raw: string, preset?: LlmPresetId): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (!url) return url
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const host = url.split(/[/:]/)[0] ?? ''
    url = `${isLoopbackHost(host) ? 'http' : 'https'}://${url}`
  }
  url = url.replace(/\/(chat\/completions|completions|models)$/i, '')
  try {
    const parsed = new URL(url)
    if (
      (preset === 'ollama' || preset === 'lmstudio') &&
      (parsed.pathname === '/' || parsed.pathname === '')
    ) {
      url = `${url}/v1`
    }
  } catch {
    // validated later
  }
  return url
}

export function llmEndpointFromSettings(settings: LlmSettings): LlmEndpoint {
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    preset: settings.preset,
  }
}

export class OpenAICompatibleClient {
  readonly baseUrl: string
  private readonly endpoint: LlmEndpoint
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number
  private readonly origin: string
  private readonly protocol: string

  constructor(endpoint: LlmEndpoint, options: LlmClientOptions = {}) {
    this.endpoint = endpoint
    this.baseUrl = normalizeBaseUrl(endpoint.baseUrl, endpoint.preset)
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? llmTimeoutSeconds(endpoint) * 1000
    this.origin = options.pageOrigin ?? pageOrigin()
    this.protocol =
      options.pageProtocol ??
      (globalThis as { location?: { protocol?: string } }).location?.protocol ??
      'https:'
  }

  get model(): string | undefined {
    return this.endpoint.model
  }

  /** Lists model ids (GET /models). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const json = (await this.send('/models', { method: 'GET', signal })) as { data?: unknown }
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
    const ids = (data as { id?: unknown }[])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string')
    const filtered = this.endpoint.preset === 'openai' ? ids.filter((id) => !NON_CHAT_MODEL.test(id)) : ids
    return [...new Set(filtered)].sort((a, b) => a.localeCompare(b))
  }

  /** "Test connection": checks the URL, key and CORS with GET /models, which is free on every provider. */
  async validate(signal?: AbortSignal): Promise<LlmValidation> {
    const preset = llmPreset(this.endpoint.preset ?? 'custom')
    if (preset.needsKey && !this.endpoint.apiKey) {
      return {
        ok: false,
        error: this.error('missing-key', {
          title: `Add your ${preset.name} key`,
          message: `${preset.name} needs an API key.`,
          steps: [
            preset.keyUrl ? `Create a key at ${preset.keyUrl}.` : 'Create an API key.',
            'Paste it and choose Test connection.',
          ],
        }),
      }
    }
    try {
      const models = await this.listModels(signal)
      return {
        ok: true,
        models,
        baseUrl: this.baseUrl,
        message: `Connected. ${models.length} models available.`,
      }
    } catch (error) {
      const cloud = error instanceof CloudError ? error : this.unknown(error)
      if (cloud.status === 404 && !/\/v1$/.test(this.baseUrl)) {
        const alt = new OpenAICompatibleClient(
          { ...this.endpoint, baseUrl: `${this.baseUrl}/v1` },
          {
            fetch: this.doFetch,
            timeoutMs: this.timeoutMs,
            pageOrigin: this.origin,
            pageProtocol: this.protocol,
          },
        )
        try {
          const models = await alt.listModels(signal)
          return { ok: true, models, baseUrl: alt.baseUrl, message: `Connected (using ${alt.baseUrl}).` }
        } catch {
          // report the original error
        }
      }
      return { ok: false, error: cloud }
    }
  }

  /** One raw chat completion call. Adapts or drops sampling parameters the model rejects. */
  async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const model = this.requireModel()
    let payload: Record<string, unknown> = { model, ...adaptForModel(body, model, this.isOpenAi()) }
    for (let attempt = 0; ; attempt++) {
      let response: Record<string, unknown>
      try {
        response = (await this.send('/chat/completions', {
          method: 'POST',
          body: payload,
          signal,
        })) as Record<string, unknown>
      } catch (error) {
        const next = attempt < 3 ? withoutRejectedParam(payload, error) : undefined
        if (!next) throw error
        payload = next
        continue
      }
      const cut = this.promptCut(payload, response)
      if (cut) throw cut
      return response
    }
  }

  /** An error when the server answered a prompt it cut short (see PROMPT_CUT). */
  private promptCut(
    payload: Record<string, unknown>,
    response: Record<string, unknown>,
  ): CloudError | undefined {
    // Only servers the user runs can be given a longer context, and cloud APIs reject a request that is too long.
    const runner = guessLocalRunner(this.baseUrl, this.endpoint.preset)
    if (runner === 'other' && !isLocalEndpoint({ preset: this.endpoint.preset, baseUrl: this.baseUrl }))
      return undefined
    const read = (response.usage as { prompt_tokens?: unknown } | undefined)?.prompt_tokens
    if (typeof read !== 'number' || !(read > 0)) return undefined
    const sent = JSON.stringify(payload).length / PROMPT_CUT.charsPerToken
    if (sent < PROMPT_CUT.minTokens || read >= sent * PROMPT_CUT.ratio) return undefined
    const name = runner === 'ollama' ? 'Ollama' : runner === 'lmstudio' ? 'LM Studio' : 'The model'
    const count = (n: number) => n.toLocaleString('en-US')
    return this.error('prompt-cut', {
      title: `${name} read only part of the request`,
      message:
        `Its context length is too small (it read ${count(read)} of about ${count(Math.round(sent / 1000) * 1000)} ` +
        'tokens). Nothing was changed, since an answer to part of the request would be wrong.',
      steps: contextLengthSteps(runner, this.endpoint.model),
      action: raiseContextLength(runner),
    })
  }

  private isOpenAi(): boolean {
    return this.endpoint.preset === 'openai' || /^https:\/\/api\.openai\.com\//.test(this.baseUrl)
  }

  /**
   * Asks the model to call tools. Tries native tool calling, then JSON mode, then a plain-text JSON reply, and
   * remembers which one worked for this endpoint and model.
   */
  async callTools(request: ToolCallRequest): Promise<ToolCallResult> {
    const key = `${this.baseUrl}|${this.requireModel()}`
    const cached = capabilityCache.get(key)
    const order = cached ? MODES.slice(MODES.indexOf(cached)) : MODES
    let lastUnsupported: CloudError | undefined
    for (const mode of order) {
      try {
        const result = await this.attempt(mode, request)
        capabilityCache.set(key, mode)
        return result
      } catch (error) {
        if (error instanceof CloudError && error.kind === 'unsupported') {
          lastUnsupported = error
          continue
        }
        throw error
      }
    }
    throw (
      lastUnsupported ??
      this.error('unsupported', {
        title: "This model can't give structured answers",
        message: 'The model did not return usable JSON.',
        steps: ['Pick a larger or newer model and try again.'],
      })
    )
  }

  private async attempt(mode: StructuredMode, request: ToolCallRequest): Promise<ToolCallResult> {
    const choice = request.toolChoice ?? 'auto'
    const common: Record<string, unknown> = {
      temperature: request.temperature ?? 0.4,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    }
    if (mode === 'tools') {
      const body: Record<string, unknown> = {
        ...common,
        messages: toWire(request.messages, 'tools'),
        tools: request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: wireToolChoice(choice, request.tools.length),
      }
      let response: Record<string, unknown>
      try {
        response = await this.chat(body, request.signal)
      } catch (error) {
        if (
          error instanceof CloudError &&
          error.kind === 'unsupported' &&
          /tool_choice/i.test(error.message)
        ) {
          response = await this.chat({ ...body, tool_choice: 'auto' }, request.signal)
        } else {
          throw error
        }
      }
      const message = firstMessage(response)
      const text = stripReasoning(typeof message.content === 'string' ? message.content : '').trim()
      let calls = parseNativeCalls(message.tool_calls)
      if (calls.length === 0 && text) calls = parseCallsFromText(text, request.tools, choice)
      if (calls.length === 0 && choice !== 'auto') {
        throw this.error('unsupported', {
          title: "This model didn't call a tool",
          message: 'Tool calling returned no call.',
        })
      }
      return finish(calls, calls.length > 0 && !message.tool_calls ? '' : text, mode, response)
    }

    const messages = withJsonInstructions(request.messages, request.tools, choice)
    const body: Record<string, unknown> = { ...common, messages: toWire(messages, mode) }
    if (mode === 'json-object') body.response_format = { type: 'json_object' }
    if (mode === 'json-schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', schema: envelopeSchema(request.tools, choice), strict: false },
      }
    }
    const response = await this.chat(body, request.signal)
    const message = firstMessage(response)
    const content = typeof message.content === 'string' ? message.content : ''
    const json = extractJson(content)
    if (json === undefined) {
      if (choice === 'auto' && mode === 'prompt')
        return finish([], stripReasoning(content).trim(), mode, response)
      throw this.error(mode === 'prompt' ? 'bad-response' : 'unsupported', {
        title: 'The model did not answer in JSON',
        message: 'The reply could not be read as JSON.',
        steps: ['Try again, or pick a larger model.'],
      })
    }
    const { calls, text } = parseEnvelope(json, request.tools, choice)
    if (calls.length === 0 && choice !== 'auto') {
      throw this.error(mode === 'prompt' ? 'bad-response' : 'unsupported', {
        title: 'The model returned no plan',
        message: 'The reply did not contain the requested data.',
        steps: ['Try again, or pick a larger model.'],
      })
    }
    return finish(calls, text, mode, response)
  }

  private requireModel(): string {
    const model = this.endpoint.model?.trim()
    if (!model) {
      throw this.error('invalid-request', {
        title: 'Choose a model',
        message: 'No model is selected for the LLM endpoint.',
        steps: ['Open Settings › AI and cloud, choose Test connection, then pick a model.'],
      })
    }
    return model
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {}
    if (hasBody) headers['Content-Type'] = 'application/json'
    if (this.endpoint.apiKey) headers.Authorization = `Bearer ${this.endpoint.apiKey}`
    if (this.endpoint.preset === 'openrouter') {
      headers['X-Title'] = 'MV Studio'
      headers['HTTP-Referer'] = this.origin
    }
    return headers
  }

  private checkUrl(): URL {
    let url: URL
    try {
      url = new URL(this.baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme')
    } catch {
      throw this.error('invalid-request', {
        title: "That base URL isn't valid",
        message:
          'Enter the endpoint address, for example https://api.openai.com/v1 or http://localhost:11434/v1.',
        steps: ['Check the base URL in Settings › AI and cloud.'],
      })
    }
    if (this.protocol === 'https:' && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      throw this.error('insecure-endpoint', {
        title: 'The browser blocks this address',
        message: `This page is served over https, so the browser blocks plain-http requests to ${url.host}. Only http://localhost is allowed.`,
        steps: [
          'Use an https address for the server, or',
          'run the model on this computer and use http://localhost, or',
          'forward the remote server to localhost (for example with an SSH tunnel).',
        ],
      })
    }
    return url
  }

  private async send(
    path: string,
    o: { method: 'GET' | 'POST'; body?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<unknown> {
    const base = this.checkUrl()
    const url = `${this.baseUrl}${path}`
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.doFetch(url, {
        method: o.method,
        headers: this.headers(!!o.body),
        body: o.body ? JSON.stringify(o.body) : undefined,
        signal,
        credentials: 'omit',
      })
    } catch (error) {
      if (o.signal?.aborted) throw cancelledError('llm', error)
      if (timeout.aborted) throw this.timeoutError(error)
      if (isFetchFailure(error)) throw await this.unreachable(base, path, error, o.signal)
      throw this.unknown(error)
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (o.signal?.aborted) throw cancelledError('llm', error)
      if (timeout.aborted) throw this.timeoutError(error)
      throw this.unknown(error)
    }
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (!response.ok) throw this.httpError(response.status, json, text)
    if (json === undefined) {
      throw this.error('bad-response', {
        title: "The endpoint didn't answer like an OpenAI-compatible API",
        message: 'The reply was not JSON. The base URL may point to a web page instead of the API.',
        steps: ['Check that the base URL ends with /v1.'],
      })
    }
    return json
  }

  private async unreachable(
    base: URL,
    path: string,
    cause: unknown,
    signal?: AbortSignal,
  ): Promise<CloudError> {
    if (isLoopbackHost(base.hostname)) {
      const runner = guessLocalRunner(this.baseUrl, this.endpoint.preset)
      const name = runner === 'ollama' ? 'Ollama' : runner === 'lmstudio' ? 'LM Studio' : 'the local server'
      return this.error('local-server', {
        title: `Couldn't connect to ${name} on this computer`,
        message: `No answer from ${this.baseUrl}. Either ${name} isn't running, or it doesn't allow requests from this site yet.`,
        steps: localSetupSteps(runner, this.origin),
        cause,
      })
    }
    if (browserOffline()) {
      return this.error('network', {
        title: "You're offline",
        message: 'LLM features need a connection to your endpoint.',
        steps: ['Reconnect, then try again.'],
        cause,
      })
    }
    // Some providers (OpenAI among them) send a wrong-key error on chat without CORS headers, which the browser
    // reports as a generic network failure. The model list does send them, so ask it what is wrong.
    if (path !== '/models' && this.endpoint.apiKey) {
      try {
        await this.send('/models', { method: 'GET', signal })
        return this.error('network', {
          title: `${this.providerName()} blocked the request`,
          message:
            'The key works, but the chat request was blocked before it reached the page. This is usually a temporary network problem or a browser extension.',
          steps: ['Try again.', 'Allow the endpoint in any ad or content blocker.'],
          cause,
        })
      } catch (error) {
        if (error instanceof CloudError && error.kind !== 'network') return error
      }
    }
    // A hosted provider's base URL comes with its preset, and its CORS is not the user's to change.
    const hosted = this.endpoint.preset === 'openai' || this.endpoint.preset === 'openrouter'
    return this.error('network', {
      title: `Couldn't reach ${this.providerName()}`,
      message: `The request to ${base.host} did not get through.`,
      steps: hosted
        ? ['Check your internet connection.', 'Allow the endpoint in any ad or content blocker.']
        : [
            'Check your internet connection and the base URL.',
            `If you run this server yourself, allow requests from ${this.origin} (CORS).`,
            'Allow the endpoint in any ad or content blocker.',
          ],
      cause,
    })
  }

  private timeoutError(cause: unknown): CloudError {
    const local = guessLocalRunner(this.baseUrl, this.endpoint.preset) !== 'other' || this.isLoopback()
    return this.error('timeout', {
      title: 'The model took too long to answer',
      message: `No answer after ${Math.round(this.timeoutMs / 1000)} s, so MV Studio stopped waiting.`,
      steps: [
        local
          ? 'Local models are slowest the first time they load, so try again. A smaller or faster model answers sooner.'
          : 'Try again, or pick a faster model.',
        'To wait longer, raise the answer time limit in Settings › AI and cloud.',
      ],
      cause,
    })
  }

  private isLoopback(): boolean {
    try {
      return isLoopbackHost(new URL(this.baseUrl).hostname)
    } catch {
      return false
    }
  }

  private httpError(status: number, json: unknown, text: string): CloudError {
    const err = (json as { error?: unknown })?.error
    const raw =
      (typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : err) ??
      (json as { message?: unknown })?.message ??
      (json as { detail?: unknown })?.detail ??
      text.slice(0, 300)
    const message = redactSecrets(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''), [
      this.endpoint.apiKey,
    ])
    const code =
      typeof err === 'object' && err !== null
        ? String((err as { code?: unknown; type?: unknown }).code ?? (err as { type?: unknown }).type ?? '')
        : ''
    const name = this.providerName()
    const preset = llmPreset(this.endpoint.preset ?? 'custom')
    const keySteps = [
      preset.keyUrl ? `Check the key at ${preset.keyUrl}.` : 'Check the API key.',
      'Paste it in Settings › AI and cloud and choose Test connection.',
    ]
    if (status === 401) {
      return this.error('bad-key', {
        status,
        title: `${name} rejected the key`,
        message: message || 'The API key was not accepted.',
        steps: keySteps,
      })
    }
    if (
      status === 402 ||
      (status === 429 && (code === 'insufficient_quota' || /quota|billing|credit/i.test(message)))
    ) {
      return this.error('insufficient-credit', {
        status,
        title: `Your ${name} account is out of credit`,
        message: message || 'The provider will not run requests until you add credit.',
        steps: ['Add credit or raise your limit with the provider, then try again.'],
      })
    }
    if (status === 403) {
      return this.error('bad-key', {
        status,
        title: `${name} refused the request`,
        message: message || 'The key is not allowed to use this model.',
        steps: ['Check the key’s permissions, or pick another model.', ...keySteps.slice(1)],
      })
    }
    if (status === 429) {
      return this.error('rate-limit', {
        status,
        title: `${name} is rate-limiting requests`,
        message: message || 'Too many requests in a short time.',
        steps: ['Wait a moment and try again.'],
      })
    }
    if (status === 404) {
      if (/model/i.test(message)) {
        const model = this.endpoint.model ?? ''
        return this.error('model-not-found', {
          status,
          title: `Model "${model}" isn't available`,
          message,
          steps:
            guessLocalRunner(this.baseUrl, this.endpoint.preset) === 'ollama'
              ? [`Download it first: ollama pull ${model}`, 'Or pick another model in Settings.']
              : ['Pick another model in Settings › AI and cloud.'],
        })
      }
      return this.error('invalid-request', {
        status,
        title: 'Endpoint not found',
        message: message || `Nothing answered at ${this.baseUrl}.`,
        steps: ['Check that the base URL ends with /v1.'],
      })
    }
    if (status === 400 || status === 422) {
      if (/tool|function/i.test(message)) {
        return this.error('unsupported', {
          status,
          title: "This model doesn't support tool calling",
          message,
        })
      }
      if (/response_format|json_schema|json_object|json mode|structured output/i.test(message)) {
        return this.error('unsupported', {
          status,
          title: "This endpoint doesn't support JSON mode",
          message,
        })
      }
      if (/context|too long|maximum.*tokens|token limit|too many tokens/i.test(message)) {
        return this.error('invalid-request', {
          status,
          title: 'The request is too long for this model',
          message,
          steps: ['Select fewer clips or a shorter range, or pick a model with a larger context window.'],
        })
      }
      return this.error('invalid-request', {
        status,
        title: `${name} rejected the request`,
        message,
        steps: ['Try again, or pick another model.'],
      })
    }
    if (status >= 500) {
      return this.error('server', {
        status,
        title: `${name} had a problem`,
        message: message || `Server error ${status}.`,
        steps: [
          guessLocalRunner(this.baseUrl, this.endpoint.preset) !== 'other' || this.isLoopback()
            ? 'Try again in a moment. For local models, check that there is enough memory for the model.'
            : 'Try again in a moment.',
        ],
      })
    }
    return this.error('bad-response', {
      status,
      title: `Unexpected answer from ${name}`,
      message: message || `Status ${status}.`,
      steps: ['Try again.'],
    })
  }

  private providerName(): string {
    const preset = this.endpoint.preset
    if (preset && preset !== 'custom') return llmPreset(preset).name.replace(/ \(.*\)$/, '')
    try {
      return new URL(this.baseUrl).host
    } catch {
      return 'the LLM endpoint'
    }
  }

  private unknown(error: unknown): CloudError {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [
      this.endpoint.apiKey,
    ])
    return this.error('bad-response', {
      title: 'Something went wrong with the LLM request',
      message,
      steps: ['Try again.'],
      cause: error,
    })
  }

  private error(
    kind: CloudErrorKind,
    o: {
      title: string
      message: string
      steps?: string[]
      status?: number
      cause?: unknown
      action?: string
    },
  ): CloudError {
    return new CloudError({ kind, provider: 'llm', ...o })
  }
}

/** llama.cpp's server ignores an object tool choice (it only reads strings); with one tool, `required` forces the same call. */
function wireToolChoice(choice: ToolChoice, toolCount: number): unknown {
  if (typeof choice !== 'object') return choice
  return toolCount === 1 ? 'required' : { type: 'function', function: { name: choice.name } }
}

/** OpenAI reasoning models (o-series, GPT-5 except the chat variants) reject max_tokens and custom temperatures. */
const OPENAI_REASONING = /^(o\d|gpt-5)(?!.*chat)/i

function adaptForModel(
  body: Record<string, unknown>,
  model: string,
  openai: boolean,
): Record<string, unknown> {
  if (!openai) return body
  const { max_tokens: maxTokens, ...out } = body
  if (maxTokens !== undefined) out.max_completion_tokens = maxTokens
  if (OPENAI_REASONING.test(model)) {
    delete out.temperature
    out.reasoning_effort = 'low'
  }
  return out
}

/** The body without the parameter a 400 error names, or undefined when the error is about something else. */
function withoutRejectedParam(
  body: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> | undefined {
  if (!(error instanceof CloudError) || (error.status !== 400 && error.status !== 422)) return undefined
  const key = ['max_tokens', 'temperature', 'reasoning_effort', 'max_completion_tokens'].find(
    (k) => k in body && new RegExp(`\\b${k}\\b`).test(error.message),
  )
  if (!key) return undefined
  const { [key]: value, ...rest } = body
  return key === 'max_tokens' && /max_completion_tokens/.test(error.message)
    ? { ...rest, max_completion_tokens: value }
    : rest
}

function firstMessage(response: Record<string, unknown>): { content?: unknown; tool_calls?: unknown } {
  const choices = response.choices
  const first = Array.isArray(choices) ? (choices[0] as { message?: unknown } | undefined) : undefined
  const message = first?.message
  return typeof message === 'object' && message !== null
    ? (message as { content?: unknown; tool_calls?: unknown })
    : {}
}

function parseArgs(raw: unknown): { args: unknown; error?: string } {
  if (typeof raw !== 'string') return { args: raw ?? {} }
  if (!raw.trim()) return { args: {} }
  try {
    return { args: JSON.parse(raw) }
  } catch {
    const extracted = extractJson(raw)
    return extracted === undefined
      ? { args: {}, error: 'Arguments were not valid JSON' }
      : { args: extracted }
  }
}

function parseNativeCalls(toolCalls: unknown): ParsedToolCall[] {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls
    .map((c, i): ParsedToolCall | undefined => {
      const call = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const name = call?.function?.name
      if (typeof name !== 'string') return undefined
      const { args, error } = parseArgs(call.function?.arguments)
      return {
        id: typeof call.id === 'string' && call.id ? call.id : `call_${i}`,
        name,
        args,
        ...(error ? { error } : {}),
      }
    })
    .filter((c): c is ParsedToolCall => c !== undefined)
}

/** Some local models write tool calls as text (`<tool_call>{…}</tool_call>` or bare JSON) instead of tool_calls. */
function parseCallsFromText(text: string, tools: ToolDefinition[], choice: ToolChoice): ParsedToolCall[] {
  const tagged = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)].map((m) =>
    extractJson(m[1] ?? ''),
  )
  const candidates = tagged.length > 0 ? tagged : [extractJson(text)]
  const calls: ParsedToolCall[] = []
  for (const json of candidates) {
    if (json === undefined) continue
    calls.push(...parseEnvelope(json, tools, choice).calls)
  }
  return calls.map((c, i) => ({ ...c, id: `call_${i}` }))
}

function parseEnvelope(
  json: unknown,
  tools: ToolDefinition[],
  choice: ToolChoice,
): { calls: ParsedToolCall[]; text: string } {
  const names = new Set(tools.map((t) => t.name))
  const toCall = (item: unknown, i: number): ParsedToolCall | undefined => {
    if (typeof item !== 'object' || item === null) return undefined
    const o = item as Record<string, unknown>
    const fn = (o.function as Record<string, unknown> | undefined) ?? o
    const name = fn.tool ?? fn.name
    if (typeof name !== 'string' || !names.has(name)) return undefined
    const { args, error } = parseArgs(fn.args ?? fn.arguments ?? fn.parameters ?? {})
    return { id: `call_${i}`, name, args, ...(error ? { error } : {}) }
  }
  const collect = (list: unknown[]) => list.map(toCall).filter((c): c is ParsedToolCall => c !== undefined)
  if (Array.isArray(json)) return { calls: collect(json), text: '' }
  if (typeof json !== 'object' || json === null) return { calls: [], text: '' }
  const o = json as Record<string, unknown>
  const text = typeof o.message === 'string' ? o.message : typeof o.reply === 'string' ? o.reply : ''
  const list = o.calls ?? o.tool_calls ?? o.actions
  if (Array.isArray(list)) return { calls: collect(list), text }
  const single = toCall(o, 0)
  if (single) return { calls: [single], text }
  if (typeof choice === 'object') return { calls: [{ id: 'call_0', name: choice.name, args: o }], text: '' }
  return { calls: [], text }
}

function finish(
  calls: ParsedToolCall[],
  text: string,
  mode: StructuredMode,
  response: Record<string, unknown>,
): ToolCallResult {
  const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  return {
    calls,
    text,
    mode,
    assistant: {
      role: 'assistant',
      content: text,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          }
        : {}),
    },
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      : undefined,
  }
}

function toWire(messages: ChatMessage[], mode: StructuredMode): Record<string, unknown>[] {
  if (mode === 'tools') {
    return messages.map((m) => (m.role === 'assistant' ? { ...m, content: m.content ?? '' } : { ...m }))
  }
  return messages.map((m) => {
    if (m.role === 'assistant') {
      if (!m.tool_calls?.length) return { role: 'assistant', content: m.content ?? '' }
      return {
        role: 'assistant',
        content: JSON.stringify({
          message: m.content ?? '',
          calls: m.tool_calls.map((c) => ({
            tool: c.function.name,
            args: parseArgs(c.function.arguments).args,
          })),
        }),
      }
    }
    if (m.role === 'tool') return { role: 'user', content: `Result of ${m.tool_call_id}: ${m.content}` }
    return { ...m }
  })
}

function withJsonInstructions(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  choice: ToolChoice,
): ChatMessage[] {
  let instructions: string
  if (typeof choice === 'object') {
    const tool = tools.find((t) => t.name === choice.name)
    instructions =
      `Reply with only one JSON object, no other text. It is the input for "${choice.name}"` +
      (tool
        ? ` (${tool.description}) and must match this JSON Schema:\n${JSON.stringify(tool.parameters)}`
        : '.')
  } else {
    instructions = [
      'You act by replying with only one JSON object and no other text, in this form:',
      '{"message": "<short reply to the user>", "calls": [{"tool": "<tool name>", "args": {...}}]}',
      'Use an empty "calls" list when no tool applies.',
      'Available tools (args must match each JSON Schema):',
      ...tools.map((t) => `- ${t.name}: ${t.description}\n  args: ${JSON.stringify(t.parameters)}`),
    ].join('\n')
  }
  const [first, ...rest] = messages
  if (first?.role === 'system')
    return [{ role: 'system', content: `${first.content}\n\n${instructions}` }, ...rest]
  return [{ role: 'system', content: instructions }, ...messages]
}

function envelopeSchema(tools: ToolDefinition[], choice: ToolChoice): Record<string, unknown> {
  if (typeof choice === 'object') {
    return tools.find((t) => t.name === choice.name)?.parameters ?? { type: 'object' }
  }
  return {
    type: 'object',
    properties: {
      message: { type: 'string' },
      calls: {
        type: 'array',
        items: {
          type: 'object',
          properties: { tool: { type: 'string', enum: tools.map((t) => t.name) }, args: { type: 'object' } },
          required: ['tool', 'args'],
        },
      },
    },
    required: ['message', 'calls'],
  }
}
