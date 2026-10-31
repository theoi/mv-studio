import { describe, expect, it } from 'vitest'
import { llmLabel } from '../../../src/app/state/cloud.ts'

describe('llmLabel', () => {
  it('names the provider, or the host of a custom endpoint, with the model', () => {
    expect(
      llmLabel({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' }),
    ).toBe('Ollama · qwen2.5:7b')
    expect(
      llmLabel({ preset: 'custom', baseUrl: 'http://box.lan:8080/v1', apiKey: '', model: 'mistral' }),
    ).toBe('box.lan:8080 · mistral')
  })

  it('is undefined until a model is chosen', () => {
    expect(
      llmLabel({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' }),
    ).toBeUndefined()
    expect(llmLabel(null)).toBeUndefined()
  })
})
