import { beforeEach, describe, expect, it } from 'vitest'
import { CloudError } from '../../../src/cloud/errors.ts'
import {
  normalizeBaseUrl,
  OpenAICompatibleClient,
  resetLlmCapabilities,
  type LlmEndpoint,
  type ToolDefinition,
} from '../../../src/cloud/llm/client.ts'
import { pickDefaultModel } from '../../../src/cloud/llm/presets.ts'
import { browserFetch, PAGE_ORIGIN, type MockHandler } from './mocks/browser.ts'
import { MockLlmServer } from './mocks/llm-server.ts'

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
    expect(pickDefaultModel(result.ok ? result.models : [], 'openai')).toBe('gpt-5-mini')
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
    expect(
      (await failure(slow.llm.callTools({ messages: [{ role: 'user', content: 'x' }], tools }))).kind,
    ).toBe('timeout')

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
