import { useState } from 'react'
import { ArrowUp, Check, Cpu, Eye, Undo2 } from 'lucide-react'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { Spinner } from '../../../ds/Feedback.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { set } from '../../../state/ui.ts'
import styles from './Assist.module.css'

export function AskBox() {
  const [value, setValue] = useState('')
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'done'>('idle')
  const [asked, setAsked] = useState('')
  const submit = () => {
    if (!value.trim()) return
    setAsked(value.trim())
    setValue('')
    setPhase('thinking')
    window.setTimeout(() => setPhase('done'), 1400)
  }
  return (
    <div className={styles.ask}>
      <div className={styles.askBox}>
        <textarea
          className={styles.askInput}
          rows={2}
          value={value}
          placeholder="Ask for a change, like “make the chorus more intense”"
          aria-label="Ask Assist for a change"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className={styles.askFoot}>
          <Tooltip
            label="Plain-language edits use your LLM"
            description="Ollama on this computer. Change it in Settings › AI and cloud."
          >
            <span className={styles.askModel}>
              <Cpu /> Ollama · llama3.2
            </span>
          </Tooltip>
          <IconButton
            label="Send"
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
      {phase === 'thinking' && (
        <div className={styles.askResult}>
          <div className={styles.askQ}>“{asked}”</div>
          <div className={styles.thinking}>
            <Spinner size={12} /> Planning changes…
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className={styles.askResult}>
          <div className={styles.askQ}>“{asked}”</div>
          <div className={styles.changed}>
            <Check /> Changed 3 things in both choruses
          </div>
          <ul className={styles.changes}>
            <li>Cuts every beat instead of every bar (32 clips)</li>
            <li>Contrast +15% and Glow on the Video track</li>
            <li>Zoom pulse follows the kick drum</li>
          </ul>
          <div className={styles.rowActions}>
            <Button
              size="sm"
              variant="subtle"
              icon={<Eye />}
              onClick={() => set({ selection: { type: 'section', id: 's-c1' }, rightTab: 'assist' })}
            >
              Show changes
            </Button>
            <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => setPhase('idle')}>
              Undo
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
