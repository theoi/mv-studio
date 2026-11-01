import { describe, expect, it } from 'vitest'
import { CloudError, cloudErrorInfo, nestSteps, redactSecrets } from '../../../src/cloud/errors.ts'
import { CloudSettingsStore, MemoryStorage } from '../../../src/cloud/keys.ts'
import { extractJson } from '../../../src/cloud/llm/json.ts'
import { formatEstimate, formatUsd, needsSpendConfirmation, sumCosts } from '../../../src/cloud/pricing.ts'
import { CloudServices } from '../../../src/cloud/services.ts'
import { SpendLedger } from '../../../src/cloud/spend.ts'
import { JobRunner } from '../../../src/shared/jobs.ts'

describe('cloud settings store', () => {
  it('persists to localStorage by default and moves keys to sessionStorage on request', () => {
    const local = new MemoryStorage()
    const session = new MemoryStorage()
    const store = new CloudSettingsStore({ local, session })
    let notified = 0
    store.subscribe(() => notified++)
    store.setFalKey('  id:secret  ')
    expect(store.get().falKey).toBe('id:secret')
    expect(new CloudSettingsStore({ local, session: new MemoryStorage() }).get().falKey).toBe('id:secret')

    store.update({ persistence: 'session' })
    expect(local.getItem('mv-studio.cloud.v1')).toBeNull()
    expect(new CloudSettingsStore({ local, session }).get().falKey).toBe('id:secret')
    expect(new CloudSettingsStore({ local, session: new MemoryStorage() }).get().falKey).toBe('')

    store.clearKeys()
    expect(store.hasFal()).toBe(false)
    expect(notified).toBe(3)
  })

  it('needs a base URL and a model before the LLM counts as configured', () => {
    const store = new CloudSettingsStore({ local: new MemoryStorage(), session: new MemoryStorage() })
    store.setLlm({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' })
    expect(store.hasLlm()).toBe(false)
    store.setLlm({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5' })
    expect(store.hasLlm()).toBe(true)
  })
})

describe('cloud services', () => {
  it('offers providers only when configured and rebuilds the LLM client when settings change', () => {
    const settings = new CloudSettingsStore({ local: new MemoryStorage(), session: new MemoryStorage() })
    const services = new CloudServices(settings)
    expect(services.status()).toEqual({ generation: 'needs-key', llm: 'needs-setup', llmLocal: false })
    expect(services.generation()).toBeUndefined()
    expect(services.llm()).toBeUndefined()
    expect(services.models().length).toBeGreaterThan(5)

    settings.setFalKey('a:b')
    settings.setLlm({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5' })
    expect(services.generation()?.id).toBe('fal')
    expect(services.transcription()).toBeDefined()
    const first = services.llm()
    expect(services.llm()).toBe(first)
    expect(services.status().llmLocal).toBe(true)
    settings.setLlm({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' })
    expect(services.llm()).not.toBe(first)
    expect(services.llm()?.model).toBe('llama3.1')
  })
})

describe('cloud errors', () => {
  it('scrubs keys and key-shaped strings', () => {
    const fal = '0f8e1c2d-1111-2222-3333-444455556666:0123456789abcdef0123'
    const text = `bad key ${fal}; header Bearer abcdefghijkl; openai sk-proj-AbCdEf123456; custom my-secret-value`
    const out = redactSecrets(text, ['my-secret-value'])
    for (const secret of [fal, 'abcdefghijkl', 'sk-proj-AbCdEf123456', 'my-secret-value'])
      expect(out).not.toContain(secret)
  })

  it('keeps cloud details through a failed job snapshot', async () => {
    const runner = new JobRunner()
    const job = runner.run({
      kind: 'test',
      title: 'Generating',
      run: async () => {
        throw new CloudError({
          kind: 'rate-limit',
          provider: 'fal',
          status: 429,
          title: 'Busy',
          message: 'Wait',
          steps: ['Retry'],
        })
      },
    })
    await job.promise.catch(() => undefined)
    const snapshot = job.snapshot()
    expect(snapshot.error).toMatchObject({ code: 'provider', retryable: true })
    expect(cloudErrorInfo(snapshot.error)).toEqual({
      kind: 'rate-limit',
      provider: 'fal',
      status: 429,
      title: 'Busy',
      steps: ['Retry'],
      helpUrl: undefined,
    })
  })
})

describe('JSON extraction', () => {
  it('finds JSON in fenced, chatty and reasoning output', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('Here you go:\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] })
    expect(extractJson('<think>{"not":"this"} is my plan</think> {"a":"}"} trailing')).toEqual({ a: '}' })
    expect(extractJson('no json here')).toBeUndefined()
  })
})

describe('cost helpers', () => {
  it('formats and sums estimates', () => {
    expect(formatUsd(0.004)).toBe('under $0.01')
    expect(formatUsd(0.27)).toBe('$0.27')
    expect(formatUsd(12.4)).toBe('$12')
    expect(formatEstimate({ usd: 0.27 })).toBe('about $0.27')
    expect(formatEstimate({ usd: 0.004 })).toBe('under $0.01')
    const sum = sumCosts([
      { label: 'a', estimate: { usd: 0.2, approximate: false, breakdown: '', pricesCheckedOn: 'x' } },
      { label: 'b', estimate: { usd: 0.105, approximate: true, breakdown: '', pricesCheckedOn: 'x' } },
    ])
    expect(sum).toMatchObject({ usd: 0.305, count: 2, approximate: true })
  })

  it('asks for confirmation above the threshold or always when set', () => {
    expect(needsSpendConfirmation(0.5, { alwaysConfirmPaid: false, confirmAboveUsd: 1 })).toBe(false)
    expect(needsSpendConfirmation(1.5, { alwaysConfirmPaid: false, confirmAboveUsd: 1 })).toBe(true)
    expect(needsSpendConfirmation(0.01, { alwaysConfirmPaid: true, confirmAboveUsd: 1 })).toBe(true)
    expect(needsSpendConfirmation(0, { alwaysConfirmPaid: true, confirmAboveUsd: 1 })).toBe(false)
  })

  it('totals spend per calendar month and flags crossing the reminder once', () => {
    let now = new Date('2026-10-30T12:00:00Z')
    const storage = new MemoryStorage()
    const ledger = new SpendLedger({ storage, now: () => now })
    ledger.record(3, 'shots')
    ledger.record(1.5, 'more')
    expect(ledger.monthTotal()).toBe(4.5)
    expect(ledger.crossesReminder(1, 5)).toBe(true)
    expect(ledger.crossesReminder(0.2, 5)).toBe(false)
    expect(new SpendLedger({ storage, now: () => now }).monthTotal()).toBe(4.5)
    now = new Date('2026-11-02T12:00:00Z')
    expect(ledger.monthTotal()).toBe(0)
  })
})

describe('error steps', () => {
  it('puts a step that starts with two spaces under the step before it', () => {
    expect(
      nestSteps([
        'Raise it, then try again:',
        '  App: Settings.',
        '  Linux: systemctl.',
        'It uses more memory.',
      ]),
    ).toEqual([
      { text: 'Raise it, then try again:', alternatives: ['App: Settings.', 'Linux: systemctl.'] },
      { text: 'It uses more memory.', alternatives: [] },
    ])
    expect(nestSteps(['  No step before it.'])).toEqual([{ text: 'No step before it.', alternatives: [] }])
  })
})
