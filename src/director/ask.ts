/**
 * Plain-language edits ("make the chorus more intense"): the user's LLM reads a compact project summary and answers
 * with edit operations, a clarifying question, or a short reply. Operations are validated and dry-run first; errors
 * go back to the model to fix (twice at most). The result applies as one undo step. AskSession is the headless state
 * behind the Assist "Ask" box: useSyncExternalStore(ask.subscribe, ask.getState).
 */
import { z } from 'zod'
import { cloudErrorInfo } from '../cloud/errors.ts'
import type { ChatMessage, ParsedToolCall, ToolDefinition } from '../cloud/llm/client.ts'
import type { EditCommand } from '../model/commands.ts'
import type { ProjectEditor } from '../model/editor.ts'
import type { Id, Project, Seconds } from '../model/types.ts'
import {
  JobError,
  type JobContext,
  type JobHandle,
  type JobRunner,
  type SerializedJobError,
} from '../shared/jobs.ts'
import { compileOperations, OperationError, operationSchema, type Operation } from './ask-ops.ts'
import { DEFAULT_CATALOG, type DirectorCatalog } from './catalog.ts'
import { describeChanges, summarizeChanges, type ChangeItem } from './diff.ts'
import type { LlmToolClient } from './llm-planner.ts'
import { summarizeProject, type IdMap } from './project-summary.ts'

const EDIT_TOOL = 'edit_project'
const ASK_TOOL = 'ask_clarification'
const REPLY_TOOL = 'reply'

export const editArgsSchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(160)
    .describe('one short sentence for the user, e.g. "Made the chorus lyrics bigger"'),
  operations: z.array(operationSchema).min(1).max(40),
})

const askArgsSchema = z.object({
  question: z.string().min(1).max(300),
  choices: z.array(z.string().max(80)).max(4).optional().describe('short answers the user can tap'),
})

const replyArgsSchema = z.object({ message: z.string().min(1).max(600) })

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

export const ASK_TOOLS: ToolDefinition[] = [
  {
    name: EDIT_TOOL,
    description: 'Change the project with one or more operations, applied in order as one undoable step.',
    parameters: jsonSchema(editArgsSchema),
  },
  {
    name: ASK_TOOL,
    description:
      'Ask one short question when the request could mean very different things or refers to something that is not in the project.',
    parameters: jsonSchema(askArgsSchema),
  },
  {
    name: REPLY_TOOL,
    description:
      "Answer without editing, e.g. to explain why something can't be done or to answer a question.",
    parameters: jsonSchema(replyArgsSchema),
  },
]

export const ASK_SYSTEM_PROMPT = [
  'You edit music-video projects in MV Studio. The user message holds the project as JSON and a request.',
  `Call exactly one tool: ${EDIT_TOOL} to make changes, ${ASK_TOOL} to ask a question, or ${REPLY_TOOL} to answer.`,
  'Project facts:',
  '- Times are seconds on the timeline. Tracks are listed top layer first. Song sections (s1, s2, ...) give the song structure.',
  '- x and y are canvas positions from 0 to 1 (0.5 is the center, y grows downward: the top is about y 0.12, the bottom about y 0.88). scale 1 is the fitted size. opacity is 0 to 1.',
  '- Color adjustments (exposure, brightness, contrast, saturation, temperature, tint, hue) go from -1 to 1, 0 is neutral.',
  '- Use ids exactly as given. Clips you add get ids n1, n2, ... in order, and later operations may use them.',
  '- To change many clips, use a selector such as {"type":"text","section":"s3"} instead of listing ids.',
  '- Effects, transitions, visualizers and text animations must come from the catalog.',
  'Guidelines:',
  '- Do what was asked and nothing more. Keep existing content unless asked to remove it.',
  '- When a request is vague but reasonable ("make the chorus more intense"), choose sensible concrete edits rather than asking: e.g. add a beat-reactive scale pulse, raise contrast and saturation, add glow driven by the bass.',
  '- "selected" or "this" means the clips in selection; "here" or "now" means the playhead time.',
  '- Lyrics and titles are text clips: target them with {"type":"text"}; their size is fontSize. Footage is type video or image.',
  '- Write the summary in plain words for a non-expert.',
  'Examples of operations:',
  '- "make the lyrics bigger": {"op":"set","clips":{"type":"text"},"property":"fontSize","value":110}',
  '- "make the chorus text red", when the chorus sections are s3 and s5: {"op":"set","clips":{"type":"text","section":"s3"},"property":"color","value":"#ff0000"} and the same with "section":"s5"',
  '- "fade out the last clip": {"op":"fade","clips":["c9"],"direction":"out"}',
  '- "slowly zoom in on the first clip": {"op":"animate","clips":["c2"],"property":"scale","keyframes":[{"time":0,"value":1},{"time":4,"value":1.2}]}',
  '- "pulse the footage on the beat": {"op":"react","clips":{"type":"video"},"property":"scale","source":"beat","amount":0.08}',
].join('\n')

export interface AskContext {
  selection?: Id[]
  playhead?: Seconds
}

export type AskOutcome =
  | {
      kind: 'changes'
      summary: string
      operations: Operation[]
      commands: EditCommand[]
      items: ChangeItem[]
      /** e.g. "Changes 6 clips." */
      changes: string
      warnings: string[]
    }
  | { kind: 'question'; question: string; choices: string[] }
  | { kind: 'reply'; message: string }

export interface AskTurn {
  outcome: AskOutcome
  /** The conversation so far, to continue after a clarifying question. */
  messages: ChatMessage[]
  /** Set when the outcome is a question: the call to answer. */
  pendingCall?: ParsedToolCall
  /** Short ids the model saw; answers to a question keep using them. */
  ids: IdMap
}

export interface InterpretOptions {
  client: LlmToolClient
  project: Project
  catalog?: DirectorCatalog
  ctx: JobContext
  /** A new request, or the answer to the pending question in `previous`. */
  request: string
  context?: AskContext
  previous?: AskTurn
  /** Repair rounds after an invalid answer (default 2). */
  maxRepairs?: number
}

function userMessage(project: Project, request: string, context: AskContext, catalog: DirectorCatalog) {
  const summary = summarizeProject(project, { ...context, catalog })
  return {
    summary,
    message: { role: 'user' as const, content: `${JSON.stringify(summary.json)}\n\nRequest: ${request}` },
  }
}

function zodProblem(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
    .join('; ')
}

/** One request through the model, with validation and repair rounds. Throws CloudError for endpoint problems. */
export async function interpretRequest(o: InterpretOptions): Promise<AskTurn> {
  const catalog = o.catalog ?? DEFAULT_CATALOG
  const context = o.context ?? {}
  const { summary, message } = userMessage(o.project, o.request, context, catalog)
  let messages: ChatMessage[]
  if (o.previous?.pendingCall) {
    // Answering a question: refresh the project in case it changed, then answer the pending call.
    messages = [
      ...o.previous.messages,
      { role: 'tool', tool_call_id: o.previous.pendingCall.id, content: `The user answered: ${o.request}` },
    ]
  } else {
    messages = [{ role: 'system', content: ASK_SYSTEM_PROMPT }, message]
  }
  const ids = o.previous?.pendingCall ? o.previous.ids : summary.ids
  const maxRepairs = o.maxRepairs ?? 2
  for (let attempt = 0; ; attempt++) {
    o.ctx.progress({ stage: 'llm', message: attempt === 0 ? 'Thinking' : 'Fixing the edit' })
    const result = await o.client.callTools({
      messages,
      tools: ASK_TOOLS,
      toolChoice: 'required',
      temperature: 0.2,
      maxTokens: 3000,
      signal: o.ctx.signal,
    })
    o.ctx.throwIfCancelled()
    messages = [...messages, result.assistant]
    const call = result.calls[0]
    let problem: string
    if (!call) {
      if (result.text)
        return { outcome: { kind: 'reply', message: result.text.slice(0, 600) }, messages, ids }
      problem = `Call one of the tools: ${EDIT_TOOL}, ${ASK_TOOL} or ${REPLY_TOOL}.`
    } else if (call.error) {
      problem = `The arguments were not valid JSON (${call.error}).`
    } else if (call.name === ASK_TOOL) {
      const args = askArgsSchema.safeParse(call.args)
      if (args.success) {
        return {
          outcome: { kind: 'question', question: args.data.question, choices: args.data.choices ?? [] },
          messages,
          pendingCall: call,
          ids,
        }
      }
      problem = zodProblem(args.error)
    } else if (call.name === REPLY_TOOL) {
      const args = replyArgsSchema.safeParse(call.args)
      if (args.success) return { outcome: { kind: 'reply', message: args.data.message }, messages, ids }
      problem = zodProblem(args.error)
    } else if (call.name === EDIT_TOOL) {
      const args = editArgsSchema.safeParse(call.args)
      if (!args.success) {
        problem = zodProblem(args.error)
      } else {
        try {
          const compiled = compileOperations(args.data.operations, o.project, ids, catalog)
          const items = describeChanges(o.project, compiled.project)
          if (items.length === 0) {
            problem = 'Those operations change nothing. Check the ids and values, or reply instead.'
          } else {
            return {
              outcome: {
                kind: 'changes',
                summary: args.data.summary,
                operations: args.data.operations,
                commands: compiled.commands,
                items,
                changes: summarizeChanges(items).summary,
                warnings: compiled.warnings,
              },
              messages,
              ids,
            }
          }
        } catch (error) {
          if (!(error instanceof OperationError)) throw error
          problem = error.message
        }
      }
    } else {
      problem = `There is no tool named ${call.name}.`
    }
    if (attempt >= maxRepairs) {
      throw new JobError(
        'provider',
        "Your AI model couldn't turn that into a valid edit. Try rephrasing it.",
        {
          details: { ask: 'invalid-edit', problem },
        },
      )
    }
    messages.push(
      call
        ? { role: 'tool', tool_call_id: call.id, content: `Error: ${problem} Fix it and call a tool again.` }
        : { role: 'user', content: problem },
    )
  }
}

export type AskState =
  | { status: 'idle' }
  | { status: 'thinking'; request: string; jobId: string }
  | { status: 'question'; request: string; question: string; choices: string[] }
  | {
      status: 'review'
      request: string
      summary: string
      changes: string
      items: ChangeItem[]
      warnings: string[]
    }
  | {
      status: 'applied'
      request: string
      summary: string
      changes: string
      items: ChangeItem[]
      warnings: string[]
      /** Undo menu label. */
      label: string
    }
  | { status: 'reply'; request: string; message: string }
  | {
      status: 'error'
      request: string
      title: string
      message: string
      steps: string[]
      error: SerializedJobError
      /** True when no LLM is set up; the UI links to Settings. */
      needsSetup: boolean
    }

export interface AskDeps {
  editor: ProjectEditor
  jobs: JobRunner
  client: () => LlmToolClient | undefined
  catalog?: () => DirectorCatalog
  /** Show changes for Apply or Discard before applying (default false: apply, with Undo). */
  reviewFirst?: () => boolean
}

/** Large deletions always wait for Apply, even when changes normally apply right away. */
function needsReview(items: ChangeItem[]): boolean {
  const removedClips = items.filter((i) => i.action === 'remove' && i.target === 'clip').length
  return (
    removedClips >= 4 ||
    items.some((i) => i.action === 'remove' && (i.target === 'track' || i.target === 'asset'))
  )
}

export class AskSession {
  private state: AskState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private readonly deps: AskDeps
  private job?: JobHandle<AskTurn>
  private turn?: AskTurn
  private pending?: {
    operations: Operation[]
    ids: IdMap
    commands: EditCommand[]
    summary: string
    base: Project
  }
  private appliedLabel?: string
  private context: AskContext = {}

  constructor(deps: AskDeps) {
    this.deps = deps
  }

  getState = (): AskState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(state: AskState) {
    this.state = state
    for (const l of this.listeners) l()
  }

  /** Sends a new request. `context` carries the selection and playhead. */
  ask(request: string, context: AskContext = {}): Promise<AskState> {
    this.turn = undefined
    this.context = context
    return this.run(request.trim(), undefined)
  }

  /** Answers the current clarifying question. */
  answer(text: string): Promise<AskState> {
    if (this.state.status !== 'question' || !this.turn) return Promise.resolve(this.state)
    return this.run(text.trim(), this.turn, this.state.request)
  }

  private async run(text: string, previous: AskTurn | undefined, originalRequest = text): Promise<AskState> {
    this.job?.cancel()
    if (!text) return this.state
    const client = this.deps.client()
    if (!client) {
      this.set({
        status: 'error',
        request: originalRequest,
        title: 'Ask needs an AI model',
        message:
          'Connect an OpenAI-compatible model (cloud, or local with Ollama or LM Studio) to edit by asking.',
        steps: ['Open Settings › AI and cloud and set up a model.'],
        error: new JobError('invalid-input', 'No LLM configured').toJSON(),
        needsSetup: true,
      })
      return this.state
    }
    const project = this.deps.editor.getProject()
    const handle = this.deps.jobs.run({
      kind: 'director.ask',
      title: 'Working on your request',
      run: (ctx) =>
        interpretRequest({
          client,
          project,
          catalog: this.deps.catalog?.(),
          ctx,
          request: text,
          context: this.context,
          previous,
        }),
    })
    this.job = handle
    this.set({ status: 'thinking', request: originalRequest, jobId: handle.id })
    let turn: AskTurn
    try {
      turn = await handle.promise
    } catch (error) {
      if (this.job !== handle) return this.state
      const err = JobError.from(error)
      if (err.code === 'cancelled') {
        this.set({ status: 'idle' })
        return this.state
      }
      const cloud = cloudErrorInfo(err)
      this.set({
        status: 'error',
        request: originalRequest,
        title: cloud?.title ?? "That didn't work",
        message: err.message,
        steps: cloud?.steps ?? [],
        error: err.toJSON(),
        needsSetup: false,
      })
      return this.state
    }
    if (this.job !== handle) return this.state
    this.turn = turn
    const outcome = turn.outcome
    if (outcome.kind === 'question') {
      this.set({
        status: 'question',
        request: originalRequest,
        question: outcome.question,
        choices: outcome.choices,
      })
    } else if (outcome.kind === 'reply') {
      this.set({ status: 'reply', request: originalRequest, message: outcome.message })
    } else {
      this.pending = {
        operations: outcome.operations,
        ids: turn.ids,
        commands: outcome.commands,
        summary: outcome.summary,
        base: project,
      }
      const review = {
        request: originalRequest,
        summary: outcome.summary,
        changes: outcome.changes,
        items: outcome.items,
        warnings: outcome.warnings,
      }
      if (this.deps.reviewFirst?.() || needsReview(outcome.items)) this.set({ status: 'review', ...review })
      else this.commit(review)
    }
    return this.state
  }

  private commit(view: Omit<Extract<AskState, { status: 'review' }>, 'status'>) {
    const pending = this.pending
    if (!pending) return
    const editor = this.deps.editor
    let commands = pending.commands
    const current = editor.getProject()
    if (current !== pending.base) {
      // The user kept editing while the model worked: rebuild the same operations on the current project.
      try {
        const compiled = compileOperations(pending.operations, current, pending.ids, this.deps.catalog?.())
        commands = compiled.commands
        const items = describeChanges(current, compiled.project)
        view = { ...view, items, changes: summarizeChanges(items).summary }
      } catch (error) {
        if (!(error instanceof OperationError)) throw error
        this.set({
          status: 'error',
          request: view.request,
          title: 'The project changed',
          message: `The project changed while this edit was prepared, so it no longer fits (${error.message}). Ask again.`,
          steps: [],
          error: new JobError('invalid-input', error.message).toJSON(),
          needsSetup: false,
        })
        return
      }
    }
    const label = `Ask: ${pending.summary.length > 60 ? `${pending.summary.slice(0, 59)}…` : pending.summary}`
    try {
      editor.dispatch(commands, { label })
    } catch (error) {
      const err = JobError.from(error)
      this.set({
        status: 'error',
        request: view.request,
        title: "That edit couldn't be applied",
        message: err.message,
        steps: [],
        error: err.toJSON(),
        needsSetup: false,
      })
      return
    }
    this.pending = undefined
    this.appliedLabel = label
    this.set({ status: 'applied', ...view, label })
  }

  /** Applies the changes shown for review. */
  accept(): AskState {
    if (this.state.status === 'review') {
      const { status: _status, ...view } = this.state
      this.commit(view)
    }
    return this.state
  }

  /** Discards the changes shown for review. */
  reject(): AskState {
    if (this.state.status === 'review') {
      this.pending = undefined
      this.set({ status: 'idle' })
    }
    return this.state
  }

  /** Undoes the applied edit if it is still the latest change. */
  undo(): boolean {
    if (this.state.status !== 'applied' || this.deps.editor.undoLabel() !== this.appliedLabel) return false
    this.deps.editor.undo()
    this.appliedLabel = undefined
    this.set({ status: 'idle' })
    return true
  }

  cancel(): void {
    this.job?.cancel()
  }

  reset(): void {
    this.job?.cancel()
    this.job = undefined
    this.turn = undefined
    this.pending = undefined
    this.set({ status: 'idle' })
  }
}
