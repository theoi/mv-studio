import { create } from 'zustand'
import { plural } from '../format.ts'

/*
 * Leaving a project the Director's draft still needs: one holding AI shots that is not on the timeline yet (after Stop,
 * a failed generation, or Undo draft), or one on the timeline with failed shots waiting for Retry. Leaving drops the
 * draft (see leaveProject() in director.ts); its AI shots stay in Media, but drafting again may mean paying for new
 * ones. So opening another project asks first, and so does closing or reloading the page.
 */

export type HeldDraft =
  | {
      kind: 'unapplied'
      unit: 'shot' | 'clip'
      /** AI shots made for it, which stay in Media. */
      made: number
      /** Its AI shots not made yet: placeholders if it is applied now. */
      missing: number
    }
  | { kind: 'failed'; unit: 'shot' | 'clip'; failed: number }

interface DraftHolder {
  held(): HeldDraft | null
  /** Puts the draft on the timeline without paying for more; true once it is there. */
  apply(): Promise<boolean>
  /** Shows the draft where it can be applied or retried: the editor on Assist › Director. */
  show(): void
}

let holder: DraftHolder | null = null

/** Registered by the Director's state once it loads; before that there is no draft to hold. */
export function holdDrafts(h: DraftHolder): void {
  holder = h
}

export function heldDraft(): HeldDraft | null {
  return holder?.held() ?? null
}

/** Opens the editor on Assist › Director, where the draft can be applied or retried. */
export function showDraft(): void {
  holder?.show()
}

interface Ask {
  held: HeldDraft
  leave: () => void
  stay?: () => void
}

export const useLeaveDraft = create<{ ask: Ask | null; applying: boolean }>(() => ({
  ask: null,
  applying: false,
}))

/** Runs `leave` now when no draft would be lost; otherwise asks first, then runs `leave` or `stay`. */
export function leaveDraftThen(leave: () => void, stay?: () => void): void {
  const held = heldDraft()
  if (!held) {
    leave()
    return
  }
  // A question still open (another link followed meanwhile) is answered with Stay, so whatever waits on it goes on.
  const earlier = useLeaveDraft.getState().ask
  useLeaveDraft.setState({ ask: { held, leave, ...(stay ? { stay } : {}) }, applying: false })
  earlier?.stay?.()
}

/** Whether to go on and open another project: true at once when no draft would be lost. */
export function leaveDraftOk(): Promise<boolean> {
  return new Promise((resolve) =>
    leaveDraftThen(
      () => resolve(true),
      () => resolve(false),
    ),
  )
}

/**
 * `back` returns to the draft (from Home too, where a project never kept has no way back); `stay` (Esc, the close
 * button) only closes the question.
 */
export async function answerLeaveDraft(choice: 'back' | 'stay' | 'leave' | 'apply'): Promise<void> {
  const { ask, applying } = useLeaveDraft.getState()
  if (!ask || applying) return
  if (choice === 'apply') {
    useLeaveDraft.setState({ applying: true })
    const applied = await (holder?.apply() ?? Promise.resolve(false)).catch(() => false)
    // Asked again meanwhile (another link): that question is the one to answer now.
    if (useLeaveDraft.getState().ask !== ask) return
    useLeaveDraft.setState({ ask: null, applying: false })
    if (applied) ask.leave()
    else ask.stay?.()
    return
  }
  useLeaveDraft.setState({ ask: null })
  if (choice === 'leave') {
    ask.leave()
    return
  }
  ask.stay?.()
  if (choice === 'back') holder?.show()
}

/** The question's title and text, and the label of its apply button when the draft can be applied first. */
export function leaveDraftText(held: HeldDraft): { title: string; text: string; apply?: string } {
  const ai = `AI ${held.unit}`
  if (held.kind === 'failed') {
    const one = held.failed === 1
    return {
      title: `${plural(held.failed, ai)} still need${one ? 's' : ''} a retry`,
      text: `If you leave, you can’t retry ${one ? 'it' : 'them'} later: making ${one ? 'it' : 'them'} then means drafting again, which may mean paying for new ${held.unit}s. The ${held.unit}s already made stay on the timeline and in Media.`,
    }
  }
  const placeholders = held.missing
    ? `, with placeholders for the ${plural(held.missing, held.unit)} not made yet`
    : ''
  return {
    title: 'Your draft isn’t on the timeline yet',
    text: `If you leave, the Director’s draft is gone. Its ${plural(held.made, ai)} ${held.made === 1 ? 'stays' : 'stay'} in Media, but drafting again may mean paying for new ones. Apply and leave puts it on the timeline${placeholders}.`,
    apply: 'Apply and leave',
  }
}

/** Why Reload and try again waits for the draft (reloadRetry.ts), in the words of the question above. */
export function reloadDraftNote(held: HeldDraft): string {
  if (held.kind === 'unapplied')
    return 'Your Director draft isn’t on the timeline yet, and a reload would drop it.'
  const one = held.failed === 1
  return `${plural(held.failed, `AI ${held.unit}`)} in your Director draft still need${one ? 's' : ''} a retry, and after a reload you can’t retry ${one ? 'it' : 'them'}.`
}

/** Closing or reloading the page asks first while a draft would be lost. */
export function initLeaveDraft(): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (heldDraft()) e.preventDefault()
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  return () => window.removeEventListener('beforeunload', onBeforeUnload)
}
