import { useState } from 'react'
import { AlertTriangle, ArrowUp, Check, Cpu, Eye, Undo2, X } from 'lucide-react'
import { isLocalEndpoint } from '../../../../cloud/llm/presets.ts'
import type { AskState, ChangeItem, ReviewReason } from '../../../../director/index.ts'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { Spinner } from '../../../ds/Feedback.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { plural } from '../../../format.ts'
import {
  acceptAsk,
  answerAsk,
  ask,
  cancelAsk,
  rejectAsk,
  resetAsk,
  showChanges,
  undoAsk,
  useAsk,
} from '../../../state/ask.ts'
import { llmLabel, useCloud } from '../../../state/cloud.ts'
import { set } from '../../../state/ui.ts'
import { Elapsed } from './ToolView.tsx'
import styles from './Assist.module.css'

type StateOf<S extends AskState['status']> = Extract<AskState, { status: S }>

const SHOWN_ITEMS = 5

const REVIEW_NOTE: Record<ReviewReason, string | undefined> = {
  deletes: 'This removes content, so it waits for you to apply it.',
  large: 'This changes a lot at once, so it waits for you to apply it.',
  'small-model': 'Small models sometimes misplace edits, so their changes wait for you to check them.',
  setting: undefined,
}

function openAiSettings() {
  set({ dialog: 'settings', settingsPage: 'ai' })
}

function ModelLabel() {
  const llm = useCloud().llm
  const label = llmLabel(llm)
  return (
    <Tooltip
      label="Plain-language edits use your AI model"
      description={
        !llm || !label
          ? 'Set one up in Settings › AI and cloud.'
          : isLocalEndpoint(llm)
            ? 'It runs on this computer. Change it in Settings › AI and cloud.'
            : 'Billed to your key by the provider. Change it in Settings › AI and cloud.'
      }
    >
      <span className={styles.askModel}>
        <Cpu /> {label ?? 'No AI model yet'}
      </span>
    </Tooltip>
  )
}

function Changes({ items }: { items: ChangeItem[] }) {
  if (!items.length) return null
  const shown = items.slice(0, SHOWN_ITEMS)
  return (
    <ul className={styles.changes}>
      {shown.map((item, i) => (
        <li key={`${item.id ?? item.label}-${i}`}>
          {item.label}
          {item.details.length > 0 && `: ${item.details.join(', ')}`}
        </li>
      ))}
      {items.length > shown.length && <li>and {plural(items.length - shown.length, 'more change')}</li>}
    </ul>
  )
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null
  return (
    <ul className={styles.changes}>
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}

function Thinking({ state }: { state: StateOf<'thinking'> }) {
  const llm = useCloud().llm
  return (
    <>
      <div className={styles.thinking}>
        <Spinner size={12} />
        {state.slow ? (
          <span>
            Still working… <Elapsed since={state.startedAt} />
          </span>
        ) : (
          <span>{state.message}…</span>
        )}
      </div>
      {state.slow && (
        <div className={styles.muted}>
          {state.message !== 'Thinking' && `${state.message}. `}
          {llm && isLocalEndpoint(llm)
            ? 'Models on this computer can take a minute or more.'
            : 'This is taking longer than usual.'}
        </div>
      )}
      <div className={styles.rowActions}>
        <Button size="sm" variant="ghost" icon={<X />} onClick={cancelAsk}>
          Cancel
        </Button>
      </div>
    </>
  )
}

function Question({ state }: { state: StateOf<'question'> }) {
  return (
    <>
      <div className={styles.changed}>{state.question}</div>
      <div className={styles.rowActions}>
        <div className={styles.linkRow}>
          {state.choices.map((choice) => (
            <Button key={choice} size="sm" variant="subtle" onClick={() => void answerAsk(choice)}>
              {choice}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={resetAsk}>
            Never mind
          </Button>
        </div>
      </div>
    </>
  )
}

function Review({ state }: { state: StateOf<'review'> }) {
  const note = REVIEW_NOTE[state.reason]
  return (
    <>
      <div className={`${styles.changed} ${styles.askPending}`}>
        <Eye /> Ready to apply · {state.changes}
      </div>
      <div className={styles.lede}>{state.summary}</div>
      {note && <div className={styles.muted}>{note}</div>}
      <Changes items={state.items} />
      <Notes notes={state.warnings} />
      <div className={styles.rowActions}>
        <Button size="sm" variant="primary" icon={<Check />} onClick={() => void acceptAsk()}>
          Apply
        </Button>
        <Button size="sm" variant="subtle" icon={<Eye />} onClick={() => showChanges(state.items)}>
          Show where
        </Button>
        <Button size="sm" variant="ghost" onClick={rejectAsk}>
          Discard
        </Button>
      </div>
    </>
  )
}

function Applied({ state }: { state: StateOf<'applied'> }) {
  return (
    <>
      <div className={styles.changed}>
        <Check /> {state.summary}
      </div>
      <Changes items={state.items} />
      <Notes notes={state.warnings} />
      <div className={styles.rowActions}>
        <Button size="sm" variant="subtle" icon={<Eye />} onClick={() => showChanges(state.items)}>
          Show changes
        </Button>
        <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => void undoAsk()}>
          Undo
        </Button>
      </div>
    </>
  )
}

function Failed({ state }: { state: StateOf<'error'> }) {
  return (
    <>
      <div className={`${styles.thinking} ${styles.askFailed}`}>
        <AlertTriangle size={14} />
        <span>{state.title}</span>
      </div>
      <div className={styles.muted}>{state.message}</div>
      <Notes notes={state.steps} />
      <div className={styles.rowActions}>
        {state.needsSetup ? (
          <Button size="sm" variant="subtle" onClick={openAiSettings}>
            Open Settings
          </Button>
        ) : (
          <Button size="sm" variant="subtle" onClick={() => void ask(state.request)}>
            Try again
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={resetAsk}>
          Dismiss
        </Button>
      </div>
    </>
  )
}

/** A short line for screen readers; the result itself holds a ticking timer and would be read out every second. */
function statusText(state: AskState): string {
  switch (state.status) {
    case 'thinking':
      return 'Thinking'
    case 'question':
      return `Assist has a question: ${state.question}`
    case 'review':
      return 'Waiting for you to apply the change'
    case 'applied':
      return `Applied: ${state.summary}`
    case 'reply':
      return 'Assist answered'
    case 'error':
      return `Failed: ${state.title}`
    default:
      return ''
  }
}

function Result({ state }: { state: AskState }) {
  if (state.status === 'idle') return null
  return (
    <div className={styles.askResult}>
      <div className={styles.askQ}>“{state.request}”</div>
      {state.status === 'thinking' && <Thinking state={state} />}
      {state.status === 'question' && <Question state={state} />}
      {state.status === 'review' && <Review state={state} />}
      {state.status === 'applied' && <Applied state={state} />}
      {state.status === 'reply' && (
        <>
          <div className={styles.thinking}>{state.message}</div>
          <div className={styles.rowActions}>
            <Button size="sm" variant="ghost" onClick={resetAsk}>
              Dismiss
            </Button>
          </div>
        </>
      )}
      {state.status === 'error' && <Failed state={state} />}
    </div>
  )
}

export function AskBox() {
  const [value, setValue] = useState('')
  const state = useAsk((s) => s.state)
  const answering = state.status === 'question'
  const noModel = !llmLabel(useCloud().llm)
  const submit = () => {
    const text = value.trim()
    if (!text) return
    setValue('')
    void (answering ? answerAsk(text) : ask(text))
  }
  return (
    <div className={styles.ask}>
      <div className={styles.askBox}>
        <textarea
          className={styles.askInput}
          rows={2}
          value={value}
          placeholder={
            answering
              ? 'Type your answer, or pick one below'
              : state.status === 'review'
                ? 'Apply or discard the change above, or ask for something else'
                : noModel
                  ? 'Set up an AI model in Settings to ask for changes'
                  : 'Ask for a change, like “make the chorus more intense”'
          }
          aria-label={answering ? 'Answer Assist’s question' : 'Ask Assist for a change'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className={styles.askFoot}>
          <ModelLabel />
          <IconButton
            label={answering ? 'Answer' : 'Send'}
            shortcut="Enter"
            size="sm"
            variant="secondary"
            onClick={submit}
            disabled={!value.trim()}
          >
            <ArrowUp />
          </IconButton>
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {statusText(state)}
      </div>
      <Result state={state} />
    </div>
  )
}
