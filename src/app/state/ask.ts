import { create } from 'zustand'
import { modelHint } from '../../cloud/llm/presets.ts'
import type { AskSession, AskState, ChangeItem } from '../../director/index.ts'
import { pluginRegistry } from '../../engine/registry.ts'
import { jobs } from '../../shared/jobs.ts'
import { cloudServices, cloudSettings } from './cloud.ts'
import { editor } from './project.ts'
import { get as getUi, set, toast } from './ui.ts'

/*
 * The Ask box in Assist: one AskSession for the app, loaded on first use. Small edits apply right away with Undo;
 * deletions, large edits and edits from small models wait for Apply.
 */

export const useAsk = create<{ state: AskState }>(() => ({ state: { status: 'idle' } }))

let session: Promise<AskSession> | undefined

function askSession(): Promise<AskSession> {
  session ??= Promise.all([import('../../director/index.ts'), cloudServices()]).then(([d, cloud]) => {
    const s = new d.AskSession({
      editor,
      jobs,
      client: () => cloud.llm(),
      catalog: () => d.catalogFromPlugins(pluginRegistry.catalog()),
      smallModel: () => !!modelHint(cloudSettings.get().llm),
    })
    s.subscribe(() => useAsk.setState({ state: s.getState() }))
    return s
  })
  return session
}

function toastApplied(state: AskState) {
  if (state.status !== 'applied') return
  toast(state.summary, { label: 'Undo', run: () => void undoAsk() })
}

/** Sends a request with the selected clip and the playhead as context. */
export async function ask(request: string): Promise<void> {
  const s = await askSession()
  const { selection, playhead } = getUi()
  toastApplied(
    await s.ask(request, {
      ...(selection.type === 'clip' ? { selection: [selection.id] } : {}),
      playhead,
    }),
  )
}

export async function answerAsk(text: string): Promise<void> {
  const s = await askSession()
  toastApplied(await s.answer(text))
}

export async function acceptAsk(): Promise<void> {
  const s = await askSession()
  toastApplied(s.accept())
}

export function rejectAsk(): void {
  void askSession().then((s) => s.reject())
}

/** Undoes the last applied request while it is still the latest change. */
export async function undoAsk(): Promise<void> {
  const s = await askSession()
  if (s.undo()) toast('Change undone')
  else if (s.getState().status === 'applied')
    toast('The project has changed since. Use Undo in the top bar to step back.')
}

export function cancelAsk(): void {
  void askSession().then((s) => s.cancel())
}

export function resetAsk(): void {
  void askSession().then((s) => s.reset())
}

/** Moves the playhead to the first change and selects the first changed clip still in the project. */
export function showChanges(items: ChangeItem[]): void {
  const starts = items.flatMap((i) => (i.range ? [i.range.start] : []))
  const clips = editor.getProject().clips
  const clip = items.find((i) => i.target === 'clip' && i.id && clips[i.id])
  set({
    ...(starts.length ? { playhead: Math.min(...starts) } : {}),
    ...(clip?.id ? { selection: { type: 'clip' as const, id: clip.id } } : {}),
  })
}
