/**
 * In-process mock of an OpenAI-compatible server (OpenAI, Ollama or LM Studio flavor) following the documented
 * /v1/models and /v1/chat/completions shapes, including each flavor's CORS and error quirks.
 */
import { json, PAGE_ORIGIN, type MockHandler } from './browser.ts'

export interface ScriptedReply {
  content?: string | null
  tool_calls?: { id?: string; type?: 'function'; function: { name: string; arguments: string } }[]
}

export interface MockLlmOptions {
  flavor: 'openai' | 'ollama' | 'lmstudio'
  apiKey?: string
  models?: string[]
  supportsTools?: boolean
  supportsJsonObject?: boolean
  supportsJsonSchema?: boolean
  /** Ollama: origins allowed by OLLAMA_ORIGINS. LM Studio: whether "Enable CORS" is on. */
  allowedOrigins?: string[]
  corsEnabled?: boolean
  /** Force an error on chat: status and OpenAI-style body. */
  chatError?: { status: number; body: unknown }
  /** Reject chat bodies that contain one of these parameters with a 400 and the given message. */
  rejectParams?: Record<string, string>
  /** The context length. A longer prompt is cut without an error and only the kept tokens are counted, as Ollama does. */
  contextTokens?: number
  /**
   * Ollama's own API next to /v1: /api/ps lists the loaded model with its context length (left out with
   * `contextLength: false`, as before Ollama 0.6), and /api/generate with only a model loads it. Without this option
   * both answer 404, as a server without them does.
   */
  ollamaApi?: { loaded: boolean; contextLength?: boolean; loadFails?: boolean; loadGate?: Promise<void> }
}

export class MockLlmServer {
  readonly options: MockLlmOptions
  readonly chatBodies: Record<string, unknown>[] = []
  readonly loadBodies: Record<string, unknown>[] = []
  private replies: ScriptedReply[] = []
  private loaded: boolean

  constructor(options: MockLlmOptions) {
    this.options = {
      models: ['model-a', 'model-b'],
      supportsTools: true,
      supportsJsonObject: true,
      supportsJsonSchema: true,
      corsEnabled: true,
      ...options,
    }
    this.loaded = options.ollamaApi?.loaded ?? false
  }

  reply(...replies: ScriptedReply[]): this {
    this.replies.push(...replies)
    return this
  }

  handler(): MockHandler {
    return (request) => this.handle(request)
  }

  private corsHeaders(request: Request, isError: boolean): Record<string, string> {
    const origin = request.headers.get('origin') ?? PAGE_ORIGIN
    const { flavor } = this.options
    if (flavor === 'openai') {
      // OpenAI omits CORS headers on chat errors for a wrong key (seen in the pilot), but sends them elsewhere.
      if (isError && new URL(request.url).pathname.endsWith('/chat/completions')) return {}
      return { 'access-control-allow-origin': '*' }
    }
    if (flavor === 'ollama') {
      const allowed = this.options.allowedOrigins ?? []
      return allowed.includes(origin) || allowed.includes('*')
        ? { 'access-control-allow-origin': origin }
        : {}
    }
    return this.options.corsEnabled ? { 'access-control-allow-origin': '*' } : {}
  }

  private error(request: Request, status: number, body: unknown): Response {
    return json(body, status, this.corsHeaders(request, true))
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const { apiKey, flavor } = this.options
    if (apiKey && request.headers.get('authorization') !== `Bearer ${apiKey}`) {
      const shown = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')
      return this.error(request, 401, {
        error: {
          message: `Incorrect API key provided: ${shown}. You can find your API key at https://platform.openai.com/account/api-keys.`,
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      })
    }
    const api = flavor === 'ollama' ? this.options.ollamaApi : undefined
    if (api && request.method === 'GET' && path === '/api/ps') {
      const name = this.options.models?.[0] ?? 'model'
      const context =
        api.contextLength === false ? {} : { context_length: this.options.contextTokens ?? 4096 }
      const models = this.loaded ? [{ name, model: name, size_vram: 0, ...context }] : []
      return json({ models }, 200, this.corsHeaders(request, false))
    }
    if (api && request.method === 'POST' && path === '/api/generate') {
      const body = (await request.json()) as Record<string, unknown>
      this.loadBodies.push(body)
      if (api.loadFails) return this.error(request, 500, { error: 'model requires more system memory' })
      await api.loadGate
      this.loaded = true
      return json(
        { model: body.model, response: '', done: true, done_reason: 'load' },
        200,
        this.corsHeaders(request, false),
      )
    }
    if (request.method === 'GET' && path === '/v1/models') {
      const data = (this.options.models ?? []).map((id) => ({ id, object: 'model', owned_by: flavor }))
      return json({ object: 'list', data }, 200, this.corsHeaders(request, false))
    }
    if (request.method === 'POST' && path === '/v1/chat/completions') {
      const body = (await request.json()) as Record<string, unknown>
      this.chatBodies.push(body)
      if (this.options.chatError)
        return this.error(request, this.options.chatError.status, this.options.chatError.body)
      for (const [param, message] of Object.entries(this.options.rejectParams ?? {})) {
        if (param in body) {
          return this.error(request, 400, { error: { message, type: 'invalid_request_error', param } })
        }
      }
      if (!(this.options.models ?? []).includes(String(body.model))) {
        return this.error(request, 404, {
          error: { message: `model "${String(body.model)}" not found, try pulling it first` },
        })
      }
      if (body.tools && !this.options.supportsTools) {
        return this.error(request, 400, {
          error: {
            message: `registry.ollama.ai/library/${String(body.model)} does not support tools`,
            type: 'api_error',
          },
        })
      }
      const format = (body.response_format as { type?: string } | undefined)?.type
      if (format === 'json_object' && !this.options.supportsJsonObject) {
        return this.error(request, 400, { error: "'response_format.type' must be 'json_schema' or 'text'" })
      }
      if (format === 'json_schema' && !this.options.supportsJsonSchema) {
        return this.error(request, 400, {
          error: { message: 'response_format json_schema is not supported' },
        })
      }
      const reply = this.replies.shift() ?? { content: '' }
      // Qwen 2.5 reads these requests at about 3.4 characters per token.
      const promptTokens = Math.ceil(JSON.stringify(body).length / 3.4)
      const context = this.options.contextTokens
      // Ollama 0.40 at 4,096 tokens logged "truncating input prompt limit=2050".
      const read = context && promptTokens > context ? Math.floor(context / 2) + 2 : promptTokens
      return json(
        {
          id: 'chatcmpl-1',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: reply.tool_calls ? 'tool_calls' : 'stop',
              message: {
                role: 'assistant',
                content: reply.content ?? null,
                ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}),
              },
            },
          ],
          usage: { prompt_tokens: read, completion_tokens: 20, total_tokens: read + 20 },
        },
        200,
        this.corsHeaders(request, false),
      )
    }
    return this.error(request, 404, { error: { message: `Not found: ${path}` } })
  }
}
