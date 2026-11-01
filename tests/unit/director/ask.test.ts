import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAICompatibleClient,
  resetLlmCapabilities,
  type ToolCallRequest,
  type ToolCallResult,
} from '../../../src/cloud/llm/client.ts'
import { browserFetch, PAGE_ORIGIN } from '../cloud/mocks/browser.ts'
import { MockLlmServer } from '../cloud/mocks/llm-server.ts'
import { CloudError } from '../../../src/cloud/errors.ts'
import {
  ASK_TOOLS,
  AskSession,
  compilePlan,
  buildPlannerInput,
  interpretRequest,
  planLocally,
  summarizeProject,
  type LlmToolClient,
} from '../../../src/director/index.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { Project, TextClip } from '../../../src/model/types.ts'
import { JobError, JobRunner } from '../../../src/shared/jobs.ts'
import { CLIPS, makeProject as clipsProject } from '../vision/autocut/fixtures.ts'
import { LYRICS, makeProject, testCtx } from './fixtures.ts'

type Reply = { name: string; args: unknown } | { text: string }

/** Replays tool calls in order and records every request, like an LLM endpoint would see them. */
function scriptedClient(...replies: Reply[]): LlmToolClient & { requests: ToolCallRequest[] } {
  const requests: ToolCallRequest[] = []
  return {
    requests,
    async callTools(request) {
      requests.push(structuredClone({ ...request, signal: undefined, onLoadingModel: undefined }))
      const reply = replies.shift()
      if (!reply) throw new Error('no scripted reply left')
      if ('text' in reply) {
        return {
          calls: [],
          text: reply.text,
          mode: 'tools',
          assistant: { role: 'assistant', content: reply.text },
        }
      }
      const id = `call_${requests.length}`
      const result: ToolCallResult = {
        calls: [{ id, name: reply.name, args: reply.args }],
        text: '',
        mode: 'tools',
        assistant: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.args) } },
          ],
        },
      }
      return result
    },
  }
}

/** A lyric draft with fewer text clips than a large edit has, so editing every text applies without review. */
async function draft(): Promise<Project> {
  const base = makeProject({ lyrics: LYRICS.slice(0, 4) })
  const plan = await planLocally(await buildPlannerInput(base, { kind: 'lyric', seed: 1 }))
  const editor = new ProjectEditor(base)
  editor.dispatch(compilePlan(plan, base).commands)
  return editor.getProject()
}

const texts = (p: Project) => Object.values(p.clips).filter((c): c is TextClip => c.type === 'text')
const bigger = {
  name: 'edit_project',
  args: {
    summary: 'Made the lyrics bigger',
    operations: [{ op: 'set', clips: { type: 'text' }, property: 'fontSize', value: 150 }],
  },
}

describe('interpretRequest', () => {
  it('sends a compact project with short ids and turns the answer into a change preview', async () => {
    const project = await draft()
    const client = scriptedClient(bigger)
    const turn = await interpretRequest({
      client,
      project,
      ctx: testCtx(),
      request: 'make the lyrics bigger',
    })
    if (turn.outcome.kind !== 'changes') throw new Error(turn.outcome.kind)
    expect(turn.outcome.summary).toBe('Made the lyrics bigger')
    expect(turn.outcome.changes).toBe(`Changes ${texts(project).length} clips.`)
    expect(turn.outcome.items.flatMap((i) => i.details)).toContain('text size 150 (was 100)')
    const sent = client.requests[0]!.messages[1]!.content as string
    expect(sent).toContain('Request: make the lyrics bigger')
    for (const id of Object.keys(project.clips)) expect(sent).not.toContain(id)
    expect(sent).toMatch(/"id":"c1"/)
    expect(client.requests[0]!.toolChoice).toBe('required')
    const editor = new ProjectEditor(project)
    editor.dispatch(turn.outcome.commands)
    expect(texts(editor.getProject()).every((t) => t.style.fontSize === 150)).toBe(true)
  })

  it('sends validation errors back to the model and uses the corrected answer', async () => {
    const project = await draft()
    const client = scriptedClient(
      {
        name: 'edit_project',
        args: { summary: 'Removed it', operations: [{ op: 'remove', clips: ['c999'] }] },
      },
      bigger,
    )
    const turn = await interpretRequest({
      client,
      project,
      ctx: testCtx(),
      request: 'make the lyrics bigger',
    })
    expect(turn.outcome.kind).toBe('changes')
    const repair = client.requests[1]!.messages.at(-1)!
    expect(repair).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect((repair as { content: string }).content).toContain('Operation 1 (remove): clip c999 doesn’t exist')
  })

  it('gives up with a clear error after repeated invalid answers', async () => {
    const project = await draft()
    const bad = { name: 'edit_project', args: { summary: 'x', operations: [{ op: 'explode' }] } }
    const client = scriptedClient(bad, bad, bad)
    const error = await interpretRequest({ client, project, ctx: testCtx(), request: 'do it' }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(JobError)
    expect((error as JobError).message).toMatch(/couldn’t turn that into a valid edit/)
    expect(client.requests).toHaveLength(3)
  })

  it('accepts an edit without a summary and labels it with the request', async () => {
    const client = scriptedClient({ name: 'edit_project', args: { operations: bigger.args.operations } })
    const turn = await interpretRequest({
      client,
      project: await draft(),
      ctx: testCtx(),
      request: 'make the lyrics bigger',
    })
    if (turn.outcome.kind !== 'changes') throw new Error(turn.outcome.kind)
    expect(turn.outcome.summary).toBe('Make the lyrics bigger')
    expect(client.requests).toHaveLength(1)
  })

  it.each([
    ['', 'Make the lyrics bigger'],
    ['  \n ', 'Make the lyrics bigger'],
    ['Made\n the lyrics\tbigger ', 'Made the lyrics bigger'],
  ])('labels an edit whose summary is %j as %j', async (summary, expected) => {
    const client = scriptedClient({ name: 'edit_project', args: { ...bigger.args, summary } })
    const turn = await interpretRequest({
      client,
      project: await draft(),
      ctx: testCtx(),
      request: 'make the lyrics bigger',
    })
    if (turn.outcome.kind !== 'changes') throw new Error(turn.outcome.kind)
    expect(turn.outcome.summary).toBe(expected)
    expect(client.requests).toHaveLength(1)
  })

  it('shortens a long summary instead of rejecting the edit', async () => {
    const long = `Made the lyrics bigger ${'and bolder '.repeat(30)}`
    const client = scriptedClient({ name: 'edit_project', args: { ...bigger.args, summary: long } })
    const turn = await interpretRequest({
      client,
      project: await draft(),
      ctx: testCtx(),
      request: 'make the lyrics bigger',
    })
    if (turn.outcome.kind !== 'changes') throw new Error(turn.outcome.kind)
    expect(turn.outcome.summary.length).toBeLessThanOrEqual(160)
    expect(turn.outcome.summary).toMatch(/^Made the lyrics bigger and bolder .*\S…$/)
    expect(client.requests).toHaveLength(1)
  })

  it('still sends an edit without a summary back when its operations are invalid', async () => {
    const client = scriptedClient({ name: 'edit_project', args: { operations: [{ op: 'explode' }] } }, bigger)
    const turn = await interpretRequest({
      client,
      project: await draft(),
      ctx: testCtx(),
      request: 'make the lyrics bigger',
    })
    expect(turn.outcome.kind).toBe('changes')
    const repair = client.requests[1]!.messages.at(-1) as { role: string; content: string }
    expect(repair.role).toBe('tool')
    expect(repair.content).toMatch(/^Error: operations\.0/)
    expect(repair.content).not.toMatch(/summary/)
  })

  it('still asks the model for a summary', () => {
    const edit = ASK_TOOLS.find((t) => t.name === 'edit_project')!
    expect(edit.parameters.required).toContain('summary')
  })

  it('asks a clarifying question and continues the same conversation with the answer', async () => {
    const project = await draft()
    const client = scriptedClient(
      { name: 'ask_clarification', args: { question: 'Which text?', choices: ['Lyrics', 'Title'] } },
      bigger,
    )
    const first = await interpretRequest({ client, project, ctx: testCtx(), request: 'make the text bigger' })
    expect(first.outcome).toEqual({ kind: 'question', question: 'Which text?', choices: ['Lyrics', 'Title'] })
    const second = await interpretRequest({
      client,
      project,
      ctx: testCtx(),
      request: 'Lyrics',
      previous: first,
    })
    expect(second.outcome.kind).toBe('changes')
    expect(client.requests[1]!.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'The user answered: Lyrics',
    })
  })

  it('passes a plain reply through', async () => {
    const client = scriptedClient({
      name: 'reply',
      args: { message: 'Use the Director to re-cut the chorus.' },
    })
    const turn = await interpretRequest({
      client,
      project: await draft(),
      ctx: testCtx(),
      request: 'recut it',
    })
    expect(turn.outcome).toEqual({ kind: 'reply', message: 'Use the Director to re-cut the chorus.' })
  })

  it('marks the media that shows nothing', () => {
    const project = clipsProject({ clips: CLIPS.map((c) => ({ ...c, blank: c.id === 'city' })) })
    const summary = summarizeProject(project)
    const media = summary.json.media as { id: string; showsNothing?: boolean }[]
    const blank = media.filter((m) => m.showsNothing).map((m) => summary.ids.toReal.get(m.id))
    expect(blank).toEqual(['city'])
  })

  it('keeps big projects compact around the playhead and the selection', async () => {
    const project = await draft()
    const all = Object.values(project.clips)
    const selected = all.sort((a, b) => b.start - a.start)[0]!
    const summary = summarizeProject(project, { maxClips: 5, playhead: 10, selection: [selected.id] })
    const clips = summary.json.clips as { id: string; start: number; end: number }[]
    expect(clips).toHaveLength(5)
    expect(summary.omittedClips).toBe(all.length - 5)
    expect(clips.map((c) => summary.ids.toReal.get(c.id))).toContain(selected.id)
    expect(summary.json.selection).toEqual([summary.ids.toShort.get(selected.id)])
  })
})

function session(client: LlmToolClient | undefined, project: Project, reviewFirst = false) {
  const editor = new ProjectEditor(project)
  return {
    editor,
    ask: new AskSession({
      editor,
      jobs: new JobRunner(),
      client: () => client,
      reviewFirst: () => reviewFirst,
    }),
  }
}

describe('AskSession', () => {
  it('applies the edit as one undo step and undoes it', async () => {
    const project = await draft()
    const { editor, ask } = session(scriptedClient(bigger), project)
    const state = await ask.ask('make the lyrics bigger')
    expect(state.status).toBe('applied')
    expect(editor.undoLabel()).toBe('Ask: Made the lyrics bigger')
    expect(texts(editor.getProject()).every((t) => t.style.fontSize === 150)).toBe(true)
    expect(ask.undo()).toBe(true)
    expect(editor.getProject()).toEqual(project)
  })

  it('undoes the last edit from its toast after the result was dismissed', async () => {
    const project = await draft()
    const { editor, ask } = session(scriptedClient(bigger), project)
    await ask.ask('make the lyrics bigger')
    ask.reset()
    expect(ask.undo()).toBe(true)
    expect(editor.getProject()).toEqual(project)
    expect(ask.undo()).toBe(false)
  })

  it('tells the model which song section is selected', async () => {
    const project = await draft()
    const client = scriptedClient(bigger)
    const { ask } = session(client, project)
    const section = project.analysis.audio[project.songAssetId!]!.sections![2]!
    await ask.ask('make this section brighter', { section: section.id })
    const sent = JSON.parse(String(client.requests[0]!.messages[1]!.content).split('\n\nRequest:')[0]!) as {
      selectedSection?: string
    }
    expect(sent.selectedSection).toBe(summarizeProject(project).ids.toShort.get(section.id))
  })

  it('waits for Apply or Discard when review comes first', async () => {
    const project = await draft()
    const { editor, ask } = session(scriptedClient(bigger, bigger), project, true)
    expect((await ask.ask('bigger')).status).toBe('review')
    expect(editor.getProject()).toBe(project)
    expect(ask.reject().status).toBe('idle')
    expect(editor.getProject()).toBe(project)
    await ask.ask('bigger')
    expect(ask.accept().status).toBe('applied')
    expect(editor.canUndo()).toBe(true)
  })

  it('always asks before deleting several clips', async () => {
    const project = await draft()
    const removeAll = {
      name: 'edit_project',
      args: { summary: 'Removed the lyrics', operations: [{ op: 'remove', clips: { type: 'text' } }] },
    }
    const { editor, ask } = session(scriptedClient(removeAll), project)
    const state = await ask.ask('remove the lyrics')
    expect(state.status).toBe('review')
    expect(editor.getProject()).toBe(project)
  })

  it('rebuilds a reviewed edit on a project that changed meanwhile', async () => {
    const project = await draft()
    const { editor, ask } = session(scriptedClient(bigger), project, true)
    await ask.ask('bigger')
    editor.dispatch({ type: 'project.rename', name: 'Changed' })
    expect(ask.accept().status).toBe('applied')
    expect(editor.getProject().name).toBe('Changed')
    expect(texts(editor.getProject()).every((t) => t.style.fontSize === 150)).toBe(true)
  })

  it('refuses a reviewed edit whose clips were deleted meanwhile', async () => {
    const project = await draft()
    const target = texts(project)[0]!
    const short = summarizeProject(project).ids.toShort.get(target.id)!
    const edit = {
      name: 'edit_project',
      args: {
        summary: 'Made it red',
        operations: [{ op: 'set', clips: [short], property: 'color', value: '#ff0000' }],
      },
    }
    const { editor, ask } = session(scriptedClient(edit), project, true)
    await ask.ask('make that red')
    editor.dispatch({ type: 'clip.remove', clipIds: [target.id] })
    const state = ask.accept()
    if (state.status !== 'error') throw new Error(state.status)
    expect(state.title).toBe('The project changed')
    expect(editor.undoLabel()).not.toMatch(/^Ask:/)
  })

  it('answers a question and then applies', async () => {
    const project = await draft()
    const client = scriptedClient({ name: 'ask_clarification', args: { question: 'Which text?' } }, bigger)
    const { ask } = session(client, project)
    expect((await ask.ask('make the text bigger')).status).toBe('question')
    expect((await ask.answer('the lyrics')).status).toBe('applied')
  })

  it('labels an edit without a summary with the request it started from, not the answer to its question', async () => {
    const client = scriptedClient(
      { name: 'ask_clarification', args: { question: 'Which text?' } },
      { name: 'edit_project', args: { operations: bigger.args.operations } },
    )
    const { editor, ask } = session(client, await draft())
    await ask.ask('make the text bigger')
    const state = await ask.answer('the lyrics')
    if (state.status !== 'applied') throw new Error(state.status)
    expect(state.summary).toBe('Make the text bigger')
    expect(editor.undoLabel()).toBe('Ask: Make the text bigger')
  })

  it('points to Settings when no model is set up', async () => {
    const { ask } = session(undefined, await draft())
    const state = await ask.ask('bigger')
    if (state.status !== 'error') throw new Error(state.status)
    expect(state.needsSetup).toBe(true)
    expect(state.title).toBe('Ask needs an AI model')
    expect(state.message).toMatch(/^Add one in Settings › AI and cloud\./)
    expect(state.message).not.toMatch(/OpenAI/)
  })

  it('shows the endpoint error in place', async () => {
    const client: LlmToolClient = {
      callTools: () =>
        Promise.reject(
          new CloudError({
            kind: 'local-server',
            provider: 'llm',
            title: 'Can’t reach Ollama',
            message: 'Failed to fetch',
            steps: ['Start Ollama.'],
          }),
        ),
    }
    const { ask } = session(client, await draft())
    const state = await ask.ask('bigger')
    if (state.status !== 'error') throw new Error(state.status)
    expect(state.title).toBe('Can’t reach Ollama')
    expect(state.steps).toEqual(['Start Ollama.'])
  })
})

describe('Ask against OpenAI-compatible endpoints', () => {
  beforeEach(() => resetLlmCapabilities())

  it('edits through native tool calls (LM Studio)', async () => {
    const server = new MockLlmServer({ flavor: 'lmstudio' }).reply({
      content: null,
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'edit_project', arguments: JSON.stringify(bigger.args) },
        },
      ],
    })
    const client = new OpenAICompatibleClient(
      { baseUrl: 'http://localhost:1234/v1', model: 'model-a', preset: 'lmstudio' },
      {
        fetch: browserFetch({ 'http://localhost:1234': server.handler() }).fetch,
        pageOrigin: PAGE_ORIGIN,
        pageProtocol: 'https:',
      },
    )
    const { editor, ask } = session(client, await draft())
    expect((await ask.ask('make the lyrics bigger')).status).toBe('applied')
    expect(texts(editor.getProject()).every((t) => t.style.fontSize === 150)).toBe(true)
    expect(server.chatBodies[0]!.tool_choice).toBe('required')
  })

  it('edits through a JSON reply when the model has no tool calling (Ollama)', async () => {
    const server = new MockLlmServer({ flavor: 'ollama', allowedOrigins: ['*'], supportsTools: false }).reply(
      {
        content: JSON.stringify({ message: '', calls: [{ tool: 'edit_project', args: bigger.args }] }),
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
    const { editor, ask } = session(client, await draft())
    expect((await ask.ask('make the lyrics bigger')).status).toBe('applied')
    expect(texts(editor.getProject()).every((t) => t.style.fontSize === 150)).toBe(true)
  })

  it('stops when Ollama cut the request short, without a repair round, and says how to fix it', async () => {
    const server = new MockLlmServer({ flavor: 'ollama', allowedOrigins: ['*'], contextTokens: 4096 }).reply({
      content: null,
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'edit_project', arguments: JSON.stringify(bigger.args) },
        },
      ],
    })
    const client = new OpenAICompatibleClient(
      { baseUrl: 'http://localhost:11434/v1', model: 'model-a', preset: 'ollama' },
      {
        fetch: browserFetch({ 'http://localhost:11434': server.handler() }).fetch,
        pageOrigin: PAGE_ORIGIN,
        pageProtocol: 'https:',
      },
    )
    const project = await draft()
    const { editor, ask } = session(client, project)
    const state = await ask.ask('make the lyrics bigger')
    if (state.status !== 'error') throw new Error(state.status)
    expect(state.title).toBe('Ollama read only part of the request')
    expect(state.message).toMatch(
      /^Its context length is too small \(it read 2,050 of about [\d,]+ tokens\)\. Nothing was changed/,
    )
    expect(state.steps[0]).toBe('Raise Ollama’s context length to 16k, then try again:')
    expect(server.chatBodies).toHaveLength(1)
    expect(editor.getProject()).toBe(project)
  })
})

describe('AskSession feedback and review', () => {
  const hanging: LlmToolClient = {
    callTools: (request) =>
      new Promise((_resolve, reject) =>
        request.signal?.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled'))),
      ),
  }

  it('turns slow after a while and returns to idle on Cancel', async () => {
    const editor = new ProjectEditor(await draft())
    const ask = new AskSession({ editor, jobs: new JobRunner(), client: () => hanging, slowAfterMs: 5 })
    const before = Date.now()
    const pending = ask.ask('bigger')
    expect(ask.getState()).toMatchObject({ status: 'thinking', slow: false, message: 'Thinking' })
    const { startedAt } = ask.getState() as { startedAt: number }
    expect(startedAt).toBeGreaterThanOrEqual(before)
    expect(startedAt).toBeLessThanOrEqual(Date.now())
    await vi.waitFor(() =>
      expect(ask.getState()).toMatchObject({ status: 'thinking', slow: true, startedAt }),
    )
    ask.cancel()
    expect((await pending).status).toBe('idle')
  })

  it('shows which repair attempt is running', async () => {
    const project = await draft()
    const bad = {
      name: 'edit_project',
      args: { summary: 'x', operations: [{ op: 'remove', clips: ['c999'] }] },
    }
    const inner = scriptedClient(bad, bigger)
    const seen: string[] = []
    const ask: AskSession = new AskSession({
      editor: new ProjectEditor(project),
      jobs: new JobRunner(),
      client: () => ({
        callTools: (request) => {
          const state = ask.getState()
          if (state.status === 'thinking') seen.push(state.message)
          return inner.callTools(request)
        },
      }),
    })
    expect((await ask.ask('bigger')).status).toBe('applied')
    expect(seen).toEqual(['Thinking', 'Fixing the edit (attempt 2 of 3)'])
  })

  it('says the model is loading while Ollama loads it, then goes back to Thinking', async () => {
    const project = await draft()
    const inner = scriptedClient(bigger)
    const seen: string[] = []
    const note = () => {
      const state = ask.getState()
      if (state.status === 'thinking') seen.push(state.message)
    }
    const ask: AskSession = new AskSession({
      editor: new ProjectEditor(project),
      jobs: new JobRunner(),
      client: () => ({
        callTools: (request) => {
          request.onLoadingModel?.(true)
          note()
          request.onLoadingModel?.(false)
          note()
          return inner.callTools(request)
        },
      }),
    })
    expect((await ask.ask('bigger')).status).toBe('applied')
    expect(seen).toEqual(['Loading the model', 'Thinking'])
  })

  it('waits for Apply on large edits and says why', async () => {
    const project = await draft()
    const dim = {
      name: 'edit_project',
      args: {
        summary: 'Dimmed everything',
        operations: [
          { op: 'set', clips: { type: 'video' }, property: 'opacity', value: 0.8 },
          { op: 'set', clips: { type: 'text' }, property: 'opacity', value: 0.8 },
        ],
      },
    }
    const { editor, ask } = session(scriptedClient(dim), project)
    const state = await ask.ask('dim everything')
    if (state.status !== 'review') throw new Error(state.status)
    expect(state.items.length).toBeGreaterThanOrEqual(8)
    expect(state.reason).toBe('large')
    expect(editor.getProject()).toBe(project)
  })

  it('reviews edits from a small model and suggests a bigger one when an edit fails', async () => {
    const project = await draft()
    const bad = { name: 'edit_project', args: { summary: 'x', operations: [{ op: 'explode' }] } }
    const client = scriptedClient(bigger, bad, bad, bad)
    const ask = new AskSession({
      editor: new ProjectEditor(project),
      jobs: new JobRunner(),
      client: () => client,
      smallModel: () => true,
    })
    const reviewed = await ask.ask('bigger')
    expect(reviewed).toMatchObject({ status: 'review', reason: 'small-model' })
    const failed = await ask.ask('do it')
    if (failed.status !== 'error') throw new Error(failed.status)
    expect(failed.title).toBe('Couldn’t make that edit')
    expect(failed.steps.join(' ')).toMatch(/7B or larger model, or a cloud model/)
  })
})
