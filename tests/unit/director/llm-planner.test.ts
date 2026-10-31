import { beforeEach, describe, expect, it } from 'vitest'
import { CloudError } from '../../../src/cloud/errors.ts'
import { OpenAICompatibleClient, resetLlmCapabilities } from '../../../src/cloud/llm/client.ts'
import {
  briefRequest,
  buildPlannerInput,
  createDirectorPlanner,
  generationOptionsFor,
  normalizeBrief,
  ruleBrief,
  shotsToGenerate,
  type LlmToolClient,
} from '../../../src/director/index.ts'
import { JobError } from '../../../src/shared/jobs.ts'
import { browserFetch, PAGE_ORIGIN } from '../cloud/mocks/browser.ts'
import { MockLlmServer } from '../cloud/mocks/llm-server.ts'
import { fakeProvider, makeProject, SECTIONS, testCtx, type FixtureOptions } from './fixtures.ts'

function brief(
  sectionCount: number,
  extra: Record<string, unknown> = {},
  section: Record<string, unknown> = {},
) {
  return {
    title: 'Neon Run',
    concept: 'A runner crosses a neon city at night.',
    lookId: 'neon',
    visual: 'footage',
    sections: Array.from({ length: sectionCount }, (_, i) => ({
      sectionId: `s${i + 1}`,
      mood: `mood ${i + 1}`,
      intensity: 0.5,
      pace: 'medium',
      ...section,
    })),
    ...extra,
  }
}

function toolClient(...answers: unknown[]): LlmToolClient & { calls: number; lastMessages: unknown[] } {
  const client = {
    calls: 0,
    lastMessages: [] as unknown[],
    async callTools(request: Parameters<LlmToolClient['callTools']>[0]) {
      client.calls++
      client.lastMessages = [...request.messages]
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      const id = `call_${client.calls}`
      return {
        calls: answer === undefined ? [] : [{ id, name: 'make_brief', args: answer }],
        text: '',
        mode: 'tools' as const,
        assistant: { role: 'assistant' as const, content: null },
      }
    },
  }
  return client
}

async function input(kind: 'beat-cut' | 'ai' = 'beat-cut', fixture: FixtureOptions = {}, extra: object = {}) {
  return buildPlannerInput(makeProject(fixture), { kind, seed: 3, ...extra })
}

describe('LLM planner', () => {
  it('expands the model brief: moods, look, preferred clips and section ids mapped back', async () => {
    const inp = await input()
    const answer = brief(SECTIONS.length, {}, { assetIds: ['m2'] })
    const plan = await createDirectorPlanner({ client: () => toolClient(answer), model: () => 'gpt-test' })(
      inp,
      testCtx(),
    )
    expect(plan.planner).toBe('llm')
    expect(plan.model).toBe('gpt-test')
    expect(plan.title).toBe('Neon Run')
    expect(plan.look?.id).toBe('neon')
    expect(plan.sections.map((s) => s.mood)).toEqual(SECTIONS.map((_, i) => `mood ${i + 1}`))
    expect(plan.sections.map((s) => s.id)).toEqual(SECTIONS.map((s) => s.id))
    // m2 is the second media item; the brief prefers it, so it appears in every section.
    const preferred = inp.media[1]!.assetId
    for (const section of SECTIONS) {
      const ids = plan.shots
        .filter((s) => s.sectionId === section.id)
        .map((s) => (s.source.type === 'media' ? s.source.assetId : ''))
      expect(ids).toContain(preferred)
    }
    expect(plan.warnings).toEqual([])
  })

  it('uses the model generation prompts with the look style', async () => {
    const provider = fakeProvider()
    const generation = generationOptionsFor(provider, { mode: 'images', tier: 'draft' })!
    const inp = await input('ai', { videos: 0 }, { generation })
    const answer = brief(
      SECTIONS.length,
      { visual: 'generated', promptStyle: 'teal and orange' },
      { prompts: ['a runner under neon signs'] },
    )
    const plan = await createDirectorPlanner({ client: () => toolClient(answer) })(inp, testCtx())
    const prompts = shotsToGenerate(plan).map((s) => s.source.prompt)
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.every((p) => p === 'a runner under neon signs, teal and orange')).toBe(true)
  })

  it('tells the model which section labels were guessed from the audio alone', async () => {
    const project = makeProject()
    project.analysis.audio.song!.sections = SECTIONS.map((s) => ({
      ...s,
      confidence: s.id === 's-chorus2' ? 0.8 : 0.4,
    }))
    const { payload } = briefRequest(await buildPlannerInput(project, { kind: 'beat-cut', seed: 1 }))
    const sections = (payload.song as { sections: { label: string; labelGuessed?: boolean }[] }).sections
    expect(sections.map((s) => !!s.labelGuessed)).toEqual(SECTIONS.map((s) => s.id !== 's-chorus2'))
  })

  it('applies section moods for an unanalyzed song too', async () => {
    const inp = await input('beat-cut', { analyzed: false })
    const { payload } = briefRequest(inp)
    const count = (payload.song as { sections: unknown[] }).sections.length
    const plan = await createDirectorPlanner({ client: () => toolClient(brief(count)) })(inp, testCtx())
    expect(plan.sections.map((s) => s.mood)).toEqual(Array.from({ length: count }, (_, i) => `mood ${i + 1}`))
  })

  it('repairs a sloppy brief instead of discarding it', async () => {
    const inp = await input()
    const rules = ruleBrief(inp)
    const { ids } = briefRequest(inp)
    const result = normalizeBrief(
      {
        visual: 'cartoon',
        title: 'x'.repeat(200),
        adjustments: { contrast: 3, sparkle: 1 },
        sections: [
          {
            sectionId: 's1',
            mood: 'calm',
            intensity: 1.7,
            pace: 'Very Fast',
            assetIds: ['m1', 'm99'],
            motion: 'spin',
          },
          { sectionId: 'nope', mood: 'lost' },
        ],
      },
      ids,
      rules,
    )!
    expect(result.visual).toBe(rules.visual)
    expect(result.title).toHaveLength(80)
    expect(result.adjustments).toEqual({ contrast: 1 })
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]).toMatchObject({
      sectionId: SECTIONS[0]!.id,
      intensity: 1,
      pace: 'very-fast',
      assetIds: [inp.media[0]!.assetId],
    })
    expect(result.sections[0]!.motion).toBeUndefined()
  })

  it('asks again once when the answer is unusable, then falls back to the built-in planner', async () => {
    const client = toolClient({ sections: [] }, 'not an object')
    const plan = await createDirectorPlanner({ client: () => client })(await input(), testCtx())
    expect(client.calls).toBe(2)
    expect(client.lastMessages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(plan.planner).toBe('local')
    expect(plan.warnings[0]).toBe(
      "Your AI model's answer couldn't be used, so the built-in planner made this draft.",
    )
  })

  it('falls back with the reason when the model cannot be reached', async () => {
    const offline = new CloudError({
      kind: 'local-server',
      provider: 'llm',
      title: "Can't reach Ollama",
      message: 'Failed to fetch',
    })
    const plan = await createDirectorPlanner({ client: () => toolClient(offline) })(await input(), testCtx())
    expect(plan.planner).toBe('local')
    expect(plan.warnings[0]).toBe(
      "Your AI model couldn't help (Can't reach Ollama), so the built-in planner made this draft.",
    )
    expect(plan.shots.length).toBeGreaterThan(0)
  })

  it('stops when the user cancels instead of falling back', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancelled = new JobError('cancelled', 'Cancelled')
    const error = await createDirectorPlanner({ client: () => toolClient(cancelled) })(
      await input(),
      testCtx(controller.signal),
    ).catch((e: unknown) => e)
    expect((error as JobError).code).toBe('cancelled')
  })

  it('plans locally without warnings when no model is set up', async () => {
    const plan = await createDirectorPlanner({ client: () => undefined })(await input(), testCtx())
    expect(plan.planner).toBe('local')
    expect(plan.warnings).toEqual([])
  })
})

describe('LLM planner against OpenAI-compatible endpoints', () => {
  beforeEach(() => resetLlmCapabilities())

  it('works with native tool calling (OpenAI)', async () => {
    const server = new MockLlmServer({ flavor: 'openai', apiKey: 'sk-test' }).reply({
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'make_brief', arguments: JSON.stringify(brief(SECTIONS.length)) },
        },
      ],
    })
    const client = new OpenAICompatibleClient(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'model-a', preset: 'openai' },
      {
        fetch: browserFetch({ 'https://api.openai.com': server.handler() }).fetch,
        pageOrigin: PAGE_ORIGIN,
        pageProtocol: 'https:',
      },
    )
    const plan = await createDirectorPlanner({ client: () => client, model: () => 'model-a' })(
      await input(),
      testCtx(),
    )
    expect(plan.warnings).toEqual([])
    expect(plan.planner).toBe('llm')
    const body = server.chatBodies[0]!
    expect(body.tool_choice).toBe('required')
    expect((body.tools as unknown[]).length).toBe(1)
    const tools = body.tools as { function: { parameters: Record<string, unknown> } }[]
    expect(tools[0]!.function.parameters.$schema).toBeUndefined()
  })

  it('works with a local model without tool support through JSON mode (Ollama)', async () => {
    const server = new MockLlmServer({ flavor: 'ollama', allowedOrigins: ['*'], supportsTools: false }).reply(
      {
        content: JSON.stringify(brief(SECTIONS.length)),
      },
    )
    const client = new OpenAICompatibleClient(
      { baseUrl: 'http://localhost:11434/v1', model: 'model-a', preset: 'ollama' },
      {
        fetch: browserFetch({ 'http://localhost:11434': server.handler() }).fetch,
        pageOrigin: PAGE_ORIGIN,
        pageProtocol: 'https:',
      },
    )
    const plan = await createDirectorPlanner({ client: () => client })(await input(), testCtx())
    expect(plan.planner).toBe('llm')
    expect(plan.sections[0]!.mood).toBe('mood 1')
  })
})
