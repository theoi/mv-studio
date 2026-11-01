import { beforeEach, describe, expect, it } from 'vitest'
import { CloudError } from '../../../src/cloud/errors.ts'
import {
  normalizeBaseUrl,
  OpenAICompatibleClient,
  resetLlmCapabilities,
  type LlmEndpoint,
  type ToolDefinition,
} from '../../../src/cloud/llm/client.ts'
import {
  contextFor,
  ESTIMATE_MARGIN,
  estimateTokens,
  LLM_TIMEOUT,
  llmTimeoutSeconds,
  modelHint,
  modelSizeBillions,
  pickDefaultModel,
} from '../../../src/cloud/llm/presets.ts'
import { browserFetch, json, PAGE_ORIGIN, type BrowserFetch, type MockHandler } from './mocks/browser.ts'
import { MockLlmServer, type MockLlmOptions } from './mocks/llm-server.ts'

const OPENAI = 'https://api.openai.com'
const OLLAMA = 'http://localhost:11434'
const LMSTUDIO = 'http://localhost:1234'
const KEY = 'sk-test-0123456789abcdefABCDEF'

const tools: ToolDefinition[] = [
  {
    name: 'set_opacity',
    description: 'Set clip opacity',
    parameters: {
      type: 'object',
      properties: { clip: { type: 'string' }, value: { type: 'number' } },
      required: ['clip', 'value'],
    },
  },
  {
    name: 'ask_clarification',
    description: 'Ask the user a question',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
]

function client(servers: Record<string, MockHandler>, endpoint: LlmEndpoint, timeoutMs?: number) {
  const net = browserFetch(servers)
  return {
    net,
    llm: new OpenAICompatibleClient(endpoint, {
      fetch: net.fetch,
      pageOrigin: PAGE_ORIGIN,
      pageProtocol: 'https:',
      timeoutMs,
    }),
  }
}

async function failure(promise: Promise<unknown>): Promise<CloudError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CloudError)
  return error as CloudError
}

beforeEach(() => resetLlmCapabilities())

describe('OpenAI-compatible client: connection test', () => {
  it('lists chat models from GET /v1/models and hides non-chat OpenAI models', async () => {
    const server = new MockLlmServer({
      flavor: 'openai',
      apiKey: KEY,
      models: ['gpt-4.1-mini', 'text-embedding-3-small', 'whisper-1', 'gpt-5-mini'],
    })
    const { llm, net } = client(
      { [OPENAI]: server.handler() },
      { baseUrl: `${OPENAI}/v1`, apiKey: KEY, preset: 'openai' },
    )
    const result = await llm.validate()
    expect(result).toMatchObject({ ok: true, models: ['gpt-4.1-mini', 'gpt-5-mini'] })
    expect(net.requests[0]).toMatchObject({ method: 'GET', url: `${OPENAI}/v1/models` })
    expect(net.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(pickDefaultModel(result.ok ? result.models : [], 'openai')).toBe('gpt-4.1-mini')
  })

  it('reports a wrong key from the readable /models 401 without echoing the key', async () => {
    const server = new MockLlmServer({ flavor: 'openai', apiKey: KEY })
    const wrong = 'sk-wrong-9999999999999999'
    const { llm } = client(
      { [OPENAI]: server.handler() },
      { baseUrl: `${OPENAI}/v1`, apiKey: wrong, preset: 'openai' },
    )
    const result = await llm.validate()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('bad-key')
    expect(JSON.stringify(result.error.toJSON())).not.toContain(wrong)
  })

  it('asks for a key before calling a provider that needs one', async () => {
    const { llm, net } = client({}, { baseUrl: `${OPENAI}/v1`, preset: 'openai' })
    const result = await llm.validate()
    expect(result.ok === false && result.error.kind).toBe('missing-key')
    expect(net.requests).toHaveLength(0)
  })

  it('explains OLLAMA_ORIGINS when Ollama is not running or does not allow this site', async () => {
    const stopped = client({}, { baseUrl: `${OLLAMA}/v1`, preset: 'ollama', model: 'llama3.1' })
    const notRunning = await stopped.llm.validate()
    expect(notRunning.ok === false && notRunning.error.kind).toBe('local-server')

    const server = new MockLlmServer({ flavor: 'ollama', allowedOrigins: ['http://localhost'] })
    const blocked = client({ [OLLAMA]: server.handler() }, { baseUrl: `${OLLAMA}/v1`, preset: 'ollama' })
    const result = await blocked.llm.validate()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('local-server')
    expect(result.error.steps.join('\n')).toContain(`OLLAMA_ORIGINS`)
    expect(result.error.steps.join('\n')).toContain(PAGE_ORIGIN)

    server.options.allowedOrigins = [PAGE_ORIGIN]
    await expect(blocked.llm.validate()).resolves.toMatchObject({ ok: true })
  })

  it('tells LM Studio users to enable CORS', async () => {
    const server = new MockLlmServer({ flavor: 'lmstudio', corsEnabled: false })
    const { llm } = client({ [LMSTUDIO]: server.handler() }, { baseUrl: LMSTUDIO, preset: 'lmstudio' })
    expect(llm.baseUrl).toBe(`${LMSTUDIO}/v1`)
    const result = await llm.validate()
    expect(result.ok === false && result.error.steps.join(' ')).toContain('Enable CORS')
  })

  it('blocks plain-http endpoints on other machines before any request', async () => {
    const { llm, net } = client({}, { baseUrl: 'http://192.168.1.20:11434/v1', preset: 'custom', model: 'm' })
    const result = await llm.validate()
    expect(result.ok === false && result.error.kind).toBe('insecure-endpoint')
    expect(net.requests).toHaveLength(0)
  })

  it('finds the API under /v1 when the base URL leaves it out', async () => {
    const server = new MockLlmServer({ flavor: 'lmstudio' })
    const { llm } = client({ [LMSTUDIO]: server.handler() }, { baseUrl: LMSTUDIO, preset: 'custom' })
    await expect(llm.validate()).resolves.toMatchObject({ ok: true, baseUrl: `${LMSTUDIO}/v1` })
  })

  it('normalizes pasted base URLs', () => {
    expect(normalizeBaseUrl('api.openai.com/v1/chat/completions/')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('localhost:11434', 'ollama')).toBe('http://localhost:11434/v1')
  })
})

describe('OpenAI-compatible client: structured calls', () => {
  it('uses native tool calling when available', async () => {
    const server = new MockLlmServer({ flavor: 'openai', apiKey: KEY, models: ['gpt-test'] }).reply({
      content: 'Dimming it.',
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'set_opacity', arguments: '{"clip":"c1","value":0.5}' },
        },
      ],
    })
    const { llm } = client(
      { [OPENAI]: server.handler() },
      { baseUrl: `${OPENAI}/v1`, apiKey: KEY, model: 'gpt-test', preset: 'openai' },
    )
    const result = await llm.callTools({ messages: [{ role: 'user', content: 'dim clip 1' }], tools })
    expect(result.mode).toBe('tools')
    expect(result.calls).toEqual([{ id: 'call_a', name: 'set_opacity', args: { clip: 'c1', value: 0.5 } }])
    expect(result.text).toBe('Dimming it.')
    const body = server.chatBodies[0] as {
      tools: { type: string; function: { name: string } }[]
      model: string
    }
    expect(body.model).toBe('gpt-test')
    expect(body.tools.map((t) => t.function.name)).toEqual(['set_opacity', 'ask_clarification'])
  })

  it('forces a named tool, as `required` when it is the only tool (llama.cpp ignores the object form)', async () => {
    const call = {
      id: 'call_q',
      type: 'function' as const,
      function: { name: 'ask_clarification', arguments: '{"question":"Which one?"}' },
    }
    const server = new MockLlmServer({ flavor: 'openai', apiKey: KEY, models: ['gpt-test'] }).reply(
      { content: '', tool_calls: [call] },
      { content: '', tool_calls: [call] },
    )
    const { llm } = client(
      { [OPENAI]: server.handler() },
      { baseUrl: `${OPENAI}/v1`, apiKey: KEY, model: 'gpt-test', preset: 'openai' },
    )
    const messages = [{ role: 'user' as const, content: 'x' }]
    await llm.callTools({ messages, tools, toolChoice: { name: 'ask_clarification' } })
    await llm.callTools({ messages, tools: [tools[1]!], toolChoice: { name: 'ask_clarification' } })
    expect(server.chatBodies.map((b) => b.tool_choice)).toEqual([
      { type: 'function', function: { name: 'ask_clarification' } },
      'required',
    ])
  })

  it('falls back to JSON mode when the model has no tool support, and remembers it', async () => {
    const server = new MockLlmServer({
      flavor: 'ollama',
      allowedOrigins: [PAGE_ORIGIN],
      models: ['gemma:2b'],
      supportsTools: false,
    }).reply(
      { content: '{"message":"Done","calls":[{"tool":"set_opacity","args":{"clip":"c2","value":0.2}}]}' },
      {
        content:
          '{"message":"Which clip?","calls":[{"tool":"ask_clarification","args":{"question":"Which clip?"}}]}',
      },
    )
    const { llm } = client(
      { [OLLAMA]: server.handler() },
      { baseUrl: `${OLLAMA}/v1`, model: 'gemma:2b', preset: 'ollama' },
    )
    const first = await llm.callTools({
      messages: [
        { role: 'system', content: 'You edit videos.' },
        { role: 'user', content: 'fade it' },
      ],
      tools,
    })
    expect(first.mode).toBe('json-object')
    expect(first.calls[0]).toMatchObject({ name: 'set_opacity', args: { clip: 'c2', value: 0.2 } })
    expect(first.text).toBe('Done')
    const fallbackBody = server.chatBodies[1] as {
      response_format: unknown
      messages: { role: string; content: string }[]
    }
    expect(fallbackBody.response_format).toEqual({ type: 'json_object' })
    expect(fallbackBody.messages[0]?.content).toContain('set_opacity')

    const second = await llm.callTools({ messages: [{ role: 'user', content: 'again' }], tools })
    expect(second.calls[0]?.name).toBe('ask_clarification')
    expect(server.chatBodies).toHaveLength(3)
    expect((server.chatBodies[2] as { tools?: unknown }).tools).toBeUndefined()
  })

  it('moves on to json_schema when json_object is rejected (LM Studio)', async () => {
    const server = new MockLlmServer({
      flavor: 'lmstudio',
      models: ['qwen'],
      supportsTools: false,
      supportsJsonObject: false,
    }).reply({
      content: '{"message":"","calls":[{"tool":"set_opacity","args":{"clip":"c1","value":1}}]}',
    })
    const { llm } = client(
      { [LMSTUDIO]: server.handler() },
      { baseUrl: `${LMSTUDIO}/v1`, model: 'qwen', preset: 'lmstudio' },
    )
    const result = await llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools })
    expect(result.mode).toBe('json-schema')
    expect(result.calls).toHaveLength(1)
    const format = (
      server.chatBodies[2] as {
        response_format: { type: string; json_schema: { schema: { required: string[] } } }
      }
    ).response_format
    expect(format.type).toBe('json_schema')
    expect(format.json_schema.schema.required).toEqual(['message', 'calls'])
  })

  it('reads JSON out of plain text with reasoning and code fences as a last resort', async () => {
    const server = new MockLlmServer({
      flavor: 'lmstudio',
      models: ['r1'],
      supportsTools: false,
      supportsJsonObject: false,
      supportsJsonSchema: false,
    }).reply({
      content:
        '<think>the user wants half opacity</think>\nSure!\n```json\n{"message":"ok","calls":[{"tool":"set_opacity","args":{"clip":"c3","value":0.5}}]}\n```',
    })
    const { llm } = client(
      { [LMSTUDIO]: server.handler() },
      { baseUrl: `${LMSTUDIO}/v1`, model: 'r1', preset: 'lmstudio' },
    )
    const result = await llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools })
    expect(result.mode).toBe('prompt')
    expect(result.calls[0]?.args).toEqual({ clip: 'c3', value: 0.5 })
  })

  it('returns the arguments object directly for a forced tool in JSON mode', async () => {
    const server = new MockLlmServer({
      flavor: 'ollama',
      allowedOrigins: [PAGE_ORIGIN],
      models: ['m'],
      supportsTools: false,
    }).reply({
      content: '{"question":"Verse or chorus?"}',
    })
    const { llm } = client(
      { [OLLAMA]: server.handler() },
      { baseUrl: `${OLLAMA}/v1`, model: 'm', preset: 'ollama' },
    )
    const result = await llm.callTools({
      messages: [{ role: 'user', content: 'x' }],
      tools,
      toolChoice: { name: 'ask_clarification' },
    })
    expect(result.calls).toEqual([
      { id: 'call_0', name: 'ask_clarification', args: { question: 'Verse or chorus?' } },
    ])
  })

  it('parses tool calls a local model wrote as text instead of tool_calls', async () => {
    const server = new MockLlmServer({
      flavor: 'ollama',
      allowedOrigins: [PAGE_ORIGIN],
      models: ['m'],
    }).reply({
      content: '<tool_call>{"name":"set_opacity","arguments":{"clip":"c9","value":0}}</tool_call>',
    })
    const { llm } = client(
      { [OLLAMA]: server.handler() },
      { baseUrl: `${OLLAMA}/v1`, model: 'm', preset: 'ollama' },
    )
    const result = await llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools })
    expect(result.mode).toBe('tools')
    expect(result.calls[0]).toMatchObject({ name: 'set_opacity', args: { clip: 'c9', value: 0 } })
  })

  it('turns an OpenAI chat 401 without CORS headers into a bad-key error by checking /models', async () => {
    const server = new MockLlmServer({ flavor: 'openai', apiKey: KEY, models: ['gpt-test'] })
    const { llm } = client(
      { [OPENAI]: server.handler() },
      { baseUrl: `${OPENAI}/v1`, apiKey: 'sk-revoked-1234567890', model: 'gpt-test', preset: 'openai' },
    )
    const error = await failure(llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools }))
    expect(error.kind).toBe('bad-key')
  })

  it('maps quota, rate-limit, missing-model and context errors', async () => {
    const make = (chatError: { status: number; body: unknown }) => {
      const server = new MockLlmServer({ flavor: 'lmstudio', models: ['m'], chatError })
      return client(
        { [LMSTUDIO]: server.handler() },
        { baseUrl: `${LMSTUDIO}/v1`, model: 'm', preset: 'custom' },
      ).llm
    }
    const call = (llm: OpenAICompatibleClient) =>
      llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools })
    expect(
      (
        await failure(
          call(
            make({
              status: 429,
              body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } },
            }),
          ),
        )
      ).kind,
    ).toBe('insufficient-credit')
    expect(
      (await failure(call(make({ status: 429, body: { error: { message: 'Rate limit reached' } } })))).kind,
    ).toBe('rate-limit')
    expect(
      (
        await failure(
          call(
            make({
              status: 400,
              body: { error: { message: "This model's maximum context length is 8192 tokens" } },
            }),
          ),
        )
      ).kind,
    ).toBe('invalid-request')
    expect(
      (await failure(call(make({ status: 500, body: { error: 'model requires more system memory' } })))).kind,
    ).toBe('server')

    const ollama = new MockLlmServer({ flavor: 'ollama', allowedOrigins: [PAGE_ORIGIN], models: ['other'] })
    const { llm } = client(
      { [OLLAMA]: ollama.handler() },
      { baseUrl: `${OLLAMA}/v1`, model: 'llama3.1', preset: 'ollama' },
    )
    const missing = await failure(call(llm))
    expect(missing.kind).toBe('model-not-found')
    expect(missing.steps[0]).toContain('ollama pull llama3.1')
  })

  it('says what to check by where the model runs: no CORS or memory steps for a hosted provider', async () => {
    const hosted = await failure(
      client({}, { baseUrl: `${OPENAI}/v1`, apiKey: KEY, model: 'gpt-test', preset: 'openai' }).llm.callTools(
        {
          messages: [{ role: 'user', content: 'x' }],
          tools,
        },
      ),
    )
    expect(hosted.kind).toBe('network')
    expect(hosted.steps.join(' ')).not.toMatch(/CORS|base URL/)
    const own = await failure(
      client({}, { baseUrl: `${LMSTUDIO}/v1`, model: 'm', preset: 'custom' }).llm.callTools({
        messages: [{ role: 'user', content: 'x' }],
        tools,
      }),
    )
    expect(own.steps.join(' ')).toMatch(/CORS/)

    const chatError = { status: 500, body: { error: { message: 'Internal error' } } }
    // A readable 500: OpenAI's own chat errors have no CORS headers, the mock's LM Studio ones do.
    const openai = new MockLlmServer({ flavor: 'lmstudio', models: ['gpt-test'], chatError })
    const busy = await failure(
      client(
        { [OPENAI]: openai.handler() },
        { baseUrl: `${OPENAI}/v1`, apiKey: KEY, model: 'gpt-test', preset: 'openai' },
      ).llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools }),
    )
    expect(busy.kind).toBe('server')
    expect(busy.steps).toEqual(['Try again in a moment.'])
    const local = new MockLlmServer({ flavor: 'lmstudio', models: ['m'], chatError })
    const memory = await failure(
      client(
        { [LMSTUDIO]: local.handler() },
        { baseUrl: `${LMSTUDIO}/v1`, model: 'm', preset: 'lmstudio' },
      ).llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools }),
    )
    expect(memory.steps.join(' ')).toMatch(/enough memory/)
  })
  it('times out slow models and honors cancellation', async () => {
    const hang: MockHandler = (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      )
    const slow = client(
      { [LMSTUDIO]: hang },
      { baseUrl: `${LMSTUDIO}/v1`, model: 'm', preset: 'lmstudio' },
      20,
    )
    const timedOut = await failure(slow.llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools }))
    expect(timedOut.kind).toBe('timeout')
    expect(timedOut.steps.join(' ')).toMatch(/answer time limit in Settings/)

    const controller = new AbortController()
    const cancellable = client(
      { [LMSTUDIO]: hang },
      { baseUrl: `${LMSTUDIO}/v1`, model: 'm', preset: 'lmstudio' },
    )
    const pending = cancellable.llm.callTools({
      messages: [{ role: 'user', content: 'x' }],
      tools,
      signal: controller.signal,
    })
    controller.abort()
    const error = await failure(pending)
    expect(error.kind).toBe('cancelled')
    expect(error.code).toBe('cancelled')
  })

  it('converts tool-call history to plain messages in JSON mode', async () => {
    const server = new MockLlmServer({
      flavor: 'ollama',
      allowedOrigins: [PAGE_ORIGIN],
      models: ['m'],
      supportsTools: false,
    }).reply({
      content: '{"message":"fixed","calls":[]}',
    })
    const { llm } = client(
      { [OLLAMA]: server.handler() },
      { baseUrl: `${OLLAMA}/v1`, model: 'm', preset: 'ollama' },
    )
    await llm.callTools({
      tools,
      messages: [
        { role: 'user', content: 'dim it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'set_opacity', arguments: '{"clip":"zz","value":1}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'Error: no clip zz' },
      ],
    })
    const sent = (server.chatBodies[1] as { messages: { role: string; content: string }[] }).messages
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(JSON.parse(sent[2]?.content ?? '{}')).toMatchObject({
      calls: [{ tool: 'set_opacity', args: { clip: 'zz' } }],
    })
    expect(sent[3]?.content).toContain('Error: no clip zz')
  })
})

describe('OpenAI-compatible client: model parameters and limits', () => {
  const editCall = {
    id: 'call_e',
    type: 'function' as const,
    function: { name: 'set_opacity', arguments: '{"clip":"c1","value":0.5}' },
  }
  const request = {
    messages: [{ role: 'user' as const, content: 'x' }],
    tools,
    temperature: 0.2,
    maxTokens: 300,
  }

  it('sends OpenAI reasoning models max_completion_tokens, no temperature and low reasoning effort', async () => {
    const server = new MockLlmServer({
      flavor: 'openai',
      apiKey: KEY,
      models: ['gpt-5-mini', 'gpt-4.1-mini'],
    }).reply({ tool_calls: [editCall] }, { tool_calls: [editCall] })
    const make = (model: string) =>
      client(
        { [OPENAI]: server.handler() },
        { baseUrl: `${OPENAI}/v1`, apiKey: KEY, model, preset: 'openai' },
      ).llm
    await make('gpt-5-mini').callTools(request)
    await make('gpt-4.1-mini').callTools(request)
    const [reasoning, classic] = server.chatBodies
    expect(reasoning).toMatchObject({ max_completion_tokens: 300, reasoning_effort: 'low' })
    expect(reasoning).not.toHaveProperty('temperature')
    expect(reasoning).not.toHaveProperty('max_tokens')
    expect(classic).toMatchObject({ max_completion_tokens: 300, temperature: 0.2 })
    expect(classic).not.toHaveProperty('reasoning_effort')
  })

  it('retries without the parameters a server rejects', async () => {
    const server = new MockLlmServer({
      flavor: 'lmstudio',
      models: ['m'],
      rejectParams: {
        temperature: "Unsupported value: 'temperature' does not support 0.2 with this model.",
        max_tokens:
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      },
    }).reply({ tool_calls: [editCall] })
    const { llm } = client(
      { [LMSTUDIO]: server.handler() },
      { baseUrl: `${LMSTUDIO}/v1`, model: 'm', preset: 'lmstudio' },
    )
    const result = await llm.callTools(request)
    expect(result.calls[0]?.name).toBe('set_opacity')
    expect(server.chatBodies).toHaveLength(3)
    expect(server.chatBodies[2]).toMatchObject({ max_completion_tokens: 300 })
    expect(server.chatBodies[2]).not.toHaveProperty('temperature')
    expect(server.chatBodies[2]).not.toHaveProperty('max_tokens')
  })

  it('waits longer for local models by default and clamps the user setting', () => {
    expect(llmTimeoutSeconds({ preset: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(
      LLM_TIMEOUT.cloud,
    )
    expect(llmTimeoutSeconds({ preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' })).toBe(
      LLM_TIMEOUT.local,
    )
    expect(llmTimeoutSeconds({ preset: 'ollama', baseUrl: '', timeoutSeconds: 45 })).toBe(45)
    expect(llmTimeoutSeconds({ preset: 'ollama', baseUrl: '', timeoutSeconds: 5 })).toBe(LLM_TIMEOUT.min)
    expect(llmTimeoutSeconds({ preset: 'ollama', baseUrl: '', timeoutSeconds: 9999 })).toBe(LLM_TIMEOUT.max)
    expect(LLM_TIMEOUT.cloud).toBeLessThan(LLM_TIMEOUT.local)
  })

  it.each([
    ['qwen2.5:3b', 3],
    ['qwen2.5-7b-instruct', 7],
    ['Qwen2.5-7B-Instruct-Q4_K_M.gguf', 7],
    ['llama3.2:1b', 1],
    ['phi3:3.8b', 3.8],
    ['qwen3:30b-a3b', 30],
    ['mixtral:8x7b', 56],
    ['gpt-4.1-mini', undefined],
    ['llama3.1', undefined],
  ])('reads the size of %s', (model, size) => {
    expect(modelSizeBillions(model)).toBe(size)
  })

  it('hints only for small local models', () => {
    const local = { preset: 'ollama' as const, baseUrl: 'http://localhost:11434/v1' }
    expect(modelHint({ ...local, model: 'qwen2.5:3b' })).toMatch(/small model \(3B\).*7B or larger/)
    expect(modelHint({ ...local, model: 'qwen2.5:7b' })).toBeUndefined()
    expect(modelHint({ ...local, model: 'llama3.1' })).toBeUndefined()
    expect(
      modelHint({
        preset: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'meta/llama-3.2-3b',
      }),
    ).toBeUndefined()
  })

  it('preselects the recommended model, else a preferred one that is not small', () => {
    expect(pickDefaultModel(['llama3.2:3b', 'qwen2.5:3b', 'qwen2.5:7b'], 'ollama')).toBe('qwen2.5:7b')
    expect(pickDefaultModel(['qwen2.5:3b', 'qwen2.5:14b'], 'ollama')).toBe('qwen2.5:14b')
    expect(pickDefaultModel(['qwen3:4b', 'llama3.1:8b'], 'ollama')).toBe('llama3.1:8b')
    expect(pickDefaultModel(['qwen3:4b', 'phi3:3.8b'], 'ollama')).toBe('qwen3:4b')
    expect(pickDefaultModel(['gpt-4o-mini', 'gpt-5-mini'], 'openai')).toBe('gpt-5-mini')
  })
})

describe('OpenAI-compatible client: prompts cut to fit a small context', () => {
  const editCall = {
    id: 'call_e',
    type: 'function' as const,
    function: { name: 'set_opacity', arguments: '{"clip":"c1","value":0.5}' },
  }
  // About 9,000 tokens, as an Ask request on a small project.
  const long = {
    messages: [{ role: 'user' as const, content: 'Make the chorus brighter. '.repeat(1500) }],
    tools,
    toolChoice: 'required' as const,
  }
  const ollama = { baseUrl: `${OLLAMA}/v1`, model: 'qwen2.5:7b', preset: 'ollama' as const }
  const ollamaServer = (contextTokens: number) =>
    new MockLlmServer({
      flavor: 'ollama',
      allowedOrigins: [PAGE_ORIGIN],
      models: ['qwen2.5:7b'],
      contextTokens,
    }).reply({ tool_calls: [editCall] })
  /** Answers with the tool call and the usage made from the request body. */
  const counting =
    (usage: (body: string) => unknown): MockHandler =>
    async (request) => {
      const reported = usage(await request.text())
      return json(
        {
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [editCall] } }],
          ...(reported ? { usage: reported } : {}),
        },
        200,
        { 'access-control-allow-origin': '*' },
      )
    }

  it('stops at an answer to a prompt Ollama cut short, and says how to raise its context length', async () => {
    const server = ollamaServer(4096)
    const error = await failure(client({ [OLLAMA]: server.handler() }, ollama).llm.callTools(long))
    expect(error.kind).toBe('prompt-cut')
    expect(error.retryable).toBe(false)
    expect(error.title).toBe('Ollama read only part of the request')
    expect(error.message).toBe(
      'Its context length is too small (it read 2,050 of about 9,000 tokens). Nothing was changed, since an answer to part of the request would be wrong.',
    )
    expect(error.steps[0]).toBe('Raise Ollama’s context length to 16k, then try again:')
    expect(error.steps.join('\n')).toContain('Environment="OLLAMA_CONTEXT_LENGTH=16384"')
    expect(error.steps.at(-1)).toBe('A larger context uses more memory: about 0.7 GB more for qwen2.5:7b.')
    // No second try in JSON mode: it would read the same cut prompt.
    expect(server.chatBodies).toHaveLength(1)
  })

  it('accepts the same request when the context holds it', async () => {
    const { llm } = client({ [OLLAMA]: ollamaServer(16384).handler() }, ollama)
    expect((await llm.callTools(long)).calls[0]?.name).toBe('set_opacity')
  })

  it.each([
    [0.65, false],
    [0.55, true],
  ])('takes a count of %f × the request’s estimated tokens as cut: %s', async (share, cut) => {
    const { llm } = client(
      { [OLLAMA]: counting((body) => ({ prompt_tokens: Math.round(share * estimateTokens(body)) })) },
      ollama,
    )
    const result = llm.callTools(long)
    if (cut) expect((await failure(result)).kind).toBe('prompt-cut')
    else expect((await result).calls[0]?.name).toBe('set_opacity')
  })

  it.each([
    ['OpenAI', { baseUrl: `${OPENAI}/v1`, apiKey: KEY, model: 'gpt-test', preset: 'openai' as const }],
    [
      'OpenRouter',
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: KEY,
        model: 'openai/gpt-test',
        preset: 'openrouter' as const,
      },
    ],
    [
      'a cloud API under Other',
      {
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: KEY,
        model: 'llama-test',
        preset: 'custom' as const,
      },
    ],
  ])(
    'leaves %s alone: a cloud API rejects a request that is too long, and its users cannot change it',
    async (_, endpoint) => {
      const host = new URL(endpoint.baseUrl).origin
      const { llm } = client({ [host]: counting(() => ({ prompt_tokens: 100 })) }, endpoint)
      expect((await llm.callTools(long)).calls[0]?.name).toBe('set_opacity')
    },
  )

  it('checks Ollama at its port on another machine, which the user runs', async () => {
    const box = 'https://studio-box.lan:11434'
    const error = await failure(
      client(
        { [box]: counting(() => ({ prompt_tokens: 100 })) },
        { baseUrl: `${box}/v1`, model: 'm', preset: 'custom' },
      ).llm.callTools(long),
    )
    expect(error.kind).toBe('prompt-cut')
    expect(error.title).toBe('Ollama read only part of the request')
    // The memory figure is for qwen2.5:7b; other models get the range.
    expect(error.steps.at(-1)).toBe(
      'A larger context uses more memory, up to about 1.5 GB for 7B and 8B models.',
    )
  })

  it('names LM Studio and other servers, each with its own step', async () => {
    const lm = new MockLlmServer({ flavor: 'lmstudio', models: ['m'], contextTokens: 4096 }).reply({
      tool_calls: [editCall],
    })
    const lmError = await failure(
      client(
        { [LMSTUDIO]: lm.handler() },
        { baseUrl: `${LMSTUDIO}/v1`, model: 'm', preset: 'lmstudio' },
      ).llm.callTools(long),
    )
    expect(lmError.title).toBe('LM Studio read only part of the request')
    expect(lmError.steps).toEqual([
      'In LM Studio, load the model again with Context Length set to 16384 or more, then try again.',
    ])
    expect(lmError.info.action).toBe('Raise LM Studio’s context length to 16k')
    const OTHER = 'http://localhost:8080'
    const other = new MockLlmServer({ flavor: 'lmstudio', models: ['m'], contextTokens: 4096 }).reply({
      tool_calls: [editCall],
    })
    const otherError = await failure(
      client(
        { [OTHER]: other.handler() },
        { baseUrl: `${OTHER}/v1`, model: 'm', preset: 'custom' },
      ).llm.callTools(long),
    )
    expect(otherError.title).toBe('The model read only part of the request')
    expect(otherError.steps).toEqual([
      'Give the model a context length of at least 16,384 tokens in the server’s settings, then try again.',
    ])
    expect(otherError.info.action).toBe('Raise the model’s context length to 16k')
  })

  // About 18,000 tokens, as an Ask request on a long draft (17,700 measured with 208 shots).
  const longer = {
    ...long,
    messages: [{ role: 'user' as const, content: 'Make the chorus brighter. '.repeat(3000) }],
  }

  it('asks for a context that holds the request when 16k already cut it', async () => {
    const error = await failure(
      client({ [OLLAMA]: ollamaServer(16384).handler() }, ollama).llm.callTools(longer),
    )
    expect(error.message).toBe(
      'Its context length is too small (it read 8,194 of about 18,000 tokens). Nothing was changed, since an answer to part of the request would be wrong.',
    )
    expect(error.steps).toEqual([
      'Raise Ollama’s context length to 32k, then try again:',
      '  Ollama app (macOS, Windows): Settings › Context length › 32k.',
      '  Linux: run sudo systemctl edit ollama, add Environment="OLLAMA_CONTEXT_LENGTH=32768" under [Service], then sudo systemctl restart ollama.',
      '  From a terminal: OLLAMA_CONTEXT_LENGTH=32768 ollama serve',
      'A larger context uses more memory: about 1.5 GB more for qwen2.5:7b.',
    ])
    expect(error.info.action).toBe('Raise Ollama’s context length to 32k')
  })

  // Requests as Qwen 2.5 counted them (Ollama's prompt_tokens): an Ask on the sample project, after a long draft, with
  // its clips doubled and tripled or replaced by short ids and times, with Japanese lyrics, with only 3 clips (mostly
  // the tools), and a director plan request.
  it.each([
    ['Ask, sample project', 37664, 2019, 0, 10755],
    ['Ask after a draft', 53582, 3216, 0, 15687],
    ['Ask, clips doubled', 54448, 3736, 0, 16487],
    ['Ask, clips tripled', 71204, 5425, 0, 22191],
    ['Ask, clips as short ids and times', 48215, 4496, 0, 15718],
    ['Ask, Japanese lyrics', 37245, 2019, 405, 10928],
    ['Ask, 3 clips', 22012, 774, 0, 5855],
    ['director plan', 13863, 182, 0, 3331],
  ])(
    'estimates the %s request (%i characters, %i digits, %i outside ASCII) at Qwen’s %i tokens or up to 2% over',
    (_, chars, digits, wide, counted) => {
      const text = 'a'.repeat(chars - digits - wide) + '7'.repeat(digits) + 'é'.repeat(wide)
      const estimate = estimateTokens(text)
      expect(estimate).toBeGreaterThanOrEqual(counted)
      expect(estimate).toBeLessThanOrEqual(counted * 1.02)
    },
  )

  // Requests the estimate puts under Qwen's count: clips with UUIDs, and clips made of short phrases
  // ({"label": "Chorus, clip", "mood": "euphoric, peak, neon night drive"}), 6% under.
  it.each([
    ['clips with UUIDs', 32005, 4617, 12580],
    ['clips as short phrases', 45132, 2293, 13655],
  ])(
    'covers an Ask with %s (%i characters, %i digits, Qwen’s %i tokens) within the margin',
    (_, chars, digits, counted) => {
      const estimate = estimateTokens('a'.repeat(chars - digits) + '7'.repeat(digits))
      expect(estimate).toBeLessThanOrEqual(counted)
      expect(estimate * ESTIMATE_MARGIN).toBeGreaterThanOrEqual(counted)
    },
  )

  // Lyric lines, 8 times each in a message, as Qwen 2.5 counted them: scripts that take more than a token per character.
  // Korean varies most (1 to 1.36 tokens per syllable), and this line is near the top.
  it.each([
    ['Korean', '꿈결 같은 밤, 뜨겁게 타오르는 심장의 떨림', 207],
    ['Hindi', 'रात की रोशनी में तेरा नाम पुकारूँ, शहर की गलियों में हम दौड़ें', 502],
    ['Tamil', 'இரவின் ஒளியில் உன் பெயரை அழைக்கிறேன், நகர வீதிகளில் ஓடுகிறோம்', 558],
    ['Telugu', 'రాత్రి వెలుగులో నీ పేరు పిలుస్తాను, నగర వీధుల్లో పరుగెడతాం', 686],
    ['Georgian', 'ღამის შუქზე შენს სახელს ვეძახი, ქალაქის ქუჩებში ვრბივართ', 463],
    ['Armenian', 'Գիշերային լույսի տակ քո անունն եմ կանչում, քաղաքի փողոցներով վազում ենք', 583],
  ])('estimates %s lyrics within the margin of Qwen’s count, and at most 30% over', (_, line, counted) => {
    const estimate = estimateTokens(JSON.stringify({ role: 'user', content: Array(8).fill(line).join('\n') }))
    expect(estimate * ESTIMATE_MARGIN).toBeGreaterThanOrEqual(counted)
    expect(estimate).toBeLessThanOrEqual(counted * 1.3)
  })

  it.each([
    [0, 16384],
    [14200, 16384],
    [14300, 32768],
    [29300, 32768],
    [29400, 65536],
    [200000, 131072],
  ])('takes a request estimated at %i tokens to need a context of %i', (tokens, context) => {
    expect(contextFor(tokens)).toBe(context)
  })

  it('trusts answers without a token count, and short requests', async () => {
    for (const usage of [undefined, { prompt_tokens: 0, completion_tokens: 0 }]) {
      const { llm } = client({ [OLLAMA]: counting(() => usage) }, ollama)
      expect((await llm.callTools(long)).calls[0]?.name).toBe('set_opacity')
    }
    const short = { ...long, messages: [{ role: 'user' as const, content: 'Make the chorus brighter.' }] }
    const { llm } = client({ [OLLAMA]: ollamaServer(64).handler() }, ollama)
    expect((await llm.callTools(short)).calls[0]?.name).toBe('set_opacity')
  })
  describe('before sending, against the model Ollama has loaded', () => {
    const fitting = (contextTokens: number, ollamaApi?: NonNullable<MockLlmOptions['ollamaApi']>) =>
      new MockLlmServer({
        flavor: 'ollama',
        allowedOrigins: [PAGE_ORIGIN],
        models: ['qwen2.5:7b'],
        contextTokens,
        ...(ollamaApi ? { ollamaApi } : {}),
      }).reply({ tool_calls: [editCall] })
    const paths = (net: BrowserFetch) => net.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)

    it('refuses a request far over the loaded model’s context without sending it', async () => {
      const server = fitting(4096, { loaded: true })
      const { llm, net } = client({ [OLLAMA]: server.handler() }, ollama)
      const error = await failure(llm.callTools(long))
      expect(error.kind).toBe('prompt-cut')
      expect(error.retryable).toBe(false)
      expect(error.title).toBe('Ollama can read only part of this request')
      expect(error.message).toBe(
        'Its context length is 4,096 tokens and this request is about 9,000, so Ollama would drop the start of the request. Nothing was sent or changed.',
      )
      expect(error.steps[0]).toBe('Raise Ollama’s context length to 16k, then try again:')
      expect(error.info.action).toBe('Raise Ollama’s context length to 16k')
      expect(paths(net)).toEqual(['GET /api/ps'])
      expect(server.chatBodies).toHaveLength(0)
    })

    it('asks for the context that holds the request, over the one Ollama has', async () => {
      const server = fitting(16384, { loaded: true })
      const error = await failure(client({ [OLLAMA]: server.handler() }, ollama).llm.callTools(longer))
      expect(error.message).toBe(
        'Its context length is 16,384 tokens and this request is about 18,000, so Ollama would drop the start of the request. Nothing was sent or changed.',
      )
      expect(error.steps[0]).toBe('Raise Ollama’s context length to 32k, then try again:')
      expect(error.info.action).toBe('Raise Ollama’s context length to 32k')
      expect(server.chatBodies).toHaveLength(0)
    })

    it('refuses an Ask request after a long draft that 4 characters per token would put under 16k', async () => {
      // About 55,000 characters, 6.8% of them digits, like the "clips doubled" request above that Qwen counted at 16,487
      // tokens: a long draft's shots bring their times and ids. 4 characters per token, even raised 15%, put such a
      // request under 16k, and Ollama cut the live one.
      const shots = Array.from({ length: 500 }, (_, i) =>
        JSON.stringify({
          id: `c${i}`,
          label: 'Chorus, clip',
          mood: 'euphoric, peak, neon night drive',
          start: Number((i * 1.37).toFixed(2)),
        }),
      )
      const draft = { ...long, messages: [{ role: 'user' as const, content: `[${shots.join(',')}]` }] }
      expect((JSON.stringify(draft).length / 4) * 1.15).toBeLessThan(16384)
      expect(estimateTokens(JSON.stringify(draft))).toBeGreaterThan(16384)
      const server = fitting(16384, { loaded: true })
      const error = await failure(client({ [OLLAMA]: server.handler() }, ollama).llm.callTools(draft))
      expect(error.title).toBe('Ollama can read only part of this request')
      expect(server.chatBodies).toHaveLength(0)
    })

    it('finds a model chosen without its tag under :latest', async () => {
      const server = new MockLlmServer({
        flavor: 'ollama',
        allowedOrigins: [PAGE_ORIGIN],
        models: ['qwen2.5:latest'],
        contextTokens: 4096,
        ollamaApi: { loaded: true },
      })
      const { llm } = client({ [OLLAMA]: server.handler() }, { ...ollama, model: 'qwen2.5' })
      expect((await failure(llm.callTools(long))).title).toBe('Ollama can read only part of this request')
    })

    it('sends a request that fits the loaded model’s context', async () => {
      const server = fitting(16384, { loaded: true })
      const { llm, net } = client({ [OLLAMA]: server.handler() }, ollama)
      expect((await llm.callTools(long)).calls[0]?.name).toBe('set_opacity')
      expect(paths(net)).toEqual(['GET /api/ps', 'POST /v1/chat/completions'])
    })

    it.each([
      [0.92, 1],
      [0.94, 0],
    ])(
      'with an estimate %f × the context, sends the request %i times: a request may run 8% over its estimate',
      async (share, sent) => {
        const probe = fitting(65536, { loaded: true })
        await client({ [OLLAMA]: probe.handler() }, ollama).llm.callTools(long)
        const estimate = estimateTokens(JSON.stringify(probe.chatBodies[0]))
        const server = fitting(Math.round(estimate / share), { loaded: true })
        await client({ [OLLAMA]: server.handler() }, ollama)
          .llm.callTools(long)
          .catch(() => undefined)
        expect(server.chatBodies).toHaveLength(sent)
      },
    )

    it('names a size over the context for a request refused just over it', async () => {
      const probe = fitting(65536, { loaded: true })
      await client({ [OLLAMA]: probe.handler() }, ollama).llm.callTools(long)
      const context = Math.round(estimateTokens(JSON.stringify(probe.chatBodies[0])) / 0.95)
      const server = fitting(context, { loaded: true })
      const error = await failure(client({ [OLLAMA]: server.handler() }, ollama).llm.callTools(long))
      const shown = Number(/this request is about ([\d,]+)/.exec(error.message)?.[1]?.replaceAll(',', ''))
      expect(shown).toBeGreaterThan(context)
      expect(server.chatBodies).toHaveLength(0)
    })

    it('loads the model first when Ollama hasn’t, saying so, then refuses a request over its context', async () => {
      const server = fitting(4096, { loaded: false })
      const { llm, net } = client({ [OLLAMA]: server.handler() }, ollama)
      const loading: boolean[] = []
      const error = await failure(llm.callTools({ ...long, onLoadingModel: (l) => loading.push(l) }))
      expect(error.kind).toBe('prompt-cut')
      expect(loading).toEqual([true, false])
      expect(server.loadBodies).toEqual([{ model: 'qwen2.5:7b', stream: false }])
      expect(paths(net)).toEqual(['GET /api/ps', 'POST /api/generate', 'GET /api/ps'])
      expect(server.chatBodies).toHaveLength(0)
    })

    it('loads the model first, then sends a request that fits', async () => {
      const server = fitting(16384, { loaded: false })
      const { llm, net } = client({ [OLLAMA]: server.handler() }, ollama)
      expect((await llm.callTools(long)).calls[0]?.name).toBe('set_opacity')
      expect(paths(net)).toEqual([
        'GET /api/ps',
        'POST /api/generate',
        'GET /api/ps',
        'POST /v1/chat/completions',
      ])
    })

    it.each([
      ['an Ollama without /api/ps', undefined],
      ['an Ollama that leaves out the context length', { loaded: true, contextLength: false }],
      ['a model that fails to load', { loaded: false, loadFails: true }],
    ])('sends the request to %s, and still stops at the cut answer', async (_, api) => {
      const server = fitting(4096, api)
      const error = await failure(client({ [OLLAMA]: server.handler() }, ollama).llm.callTools(long))
      expect(error.title).toBe('Ollama read only part of the request')
      expect(server.chatBodies).toHaveLength(1)
    })

    it('checks only with the Ollama preset, and only long requests', async () => {
      const other = fitting(4096, { loaded: true })
      const asOther = client({ [OLLAMA]: other.handler() }, { ...ollama, preset: 'custom' })
      await asOther.llm.callTools(long).catch(() => undefined)
      expect(paths(asOther.net)).toEqual(['POST /v1/chat/completions'])
      const short = { ...long, messages: [{ role: 'user' as const, content: 'Make the chorus brighter.' }] }
      const brief = client({ [OLLAMA]: fitting(4096, { loaded: true }).handler() }, ollama)
      expect((await brief.llm.callTools(short)).calls[0]?.name).toBe('set_opacity')
      expect(paths(brief.net)).toEqual(['POST /v1/chat/completions'])
    })

    it('stops at the answer time limit when loading the model takes that long, without sending the request', async () => {
      const server = fitting(16384, { loaded: false, loadGate: new Promise<void>(() => {}) })
      const error = await failure(client({ [OLLAMA]: server.handler() }, ollama, 50).llm.callTools(long))
      expect(error.kind).toBe('timeout')
      expect(server.loadBodies).toHaveLength(1)
      expect(server.chatBodies).toHaveLength(0)
    })

    it('stops loading the model at Cancel', async () => {
      const server = fitting(16384, { loaded: false, loadGate: new Promise<void>(() => {}) })
      const controller = new AbortController()
      const { llm } = client({ [OLLAMA]: server.handler() }, ollama)
      const loading = llm.callTools({
        ...long,
        signal: controller.signal,
        onLoadingModel: (l) => {
          if (l) setTimeout(() => controller.abort(), 0)
        },
      })
      expect((await failure(loading)).kind).toBe('cancelled')
      expect(server.loadBodies).toHaveLength(1)
      expect(server.chatBodies).toHaveLength(0)
    })
  })
})
