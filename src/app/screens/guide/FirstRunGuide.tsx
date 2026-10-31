import { useEffect, useLayoutEffect, useState } from 'react'
import { Button } from '../../ds/Button.tsx'
import { Kbd } from '../../ds/Kbd.tsx'
import { set, useUi } from '../../state/ui.ts'
import styles from './FirstRunGuide.module.css'

const steps = [
  {
    target: 'timeline',
    place: 'top' as const,
    title: 'Your song, mapped',
    body: 'Sections, beats and the energy curve were found automatically. Clips snap to the beat as you drag them.',
  },
  {
    target: 'library',
    place: 'right' as const,
    title: 'Add anything',
    body: 'Drag media, text, visualizers and effects onto the timeline, or hover and press + to add at the playhead.',
  },
  {
    target: 'right',
    place: 'left' as const,
    title: 'Edit what you select',
    body: 'The inspector shows only what applies to your selection. All smart and AI tools live in Assist.',
  },
  {
    target: 'search',
    place: 'bottom' as const,
    title: 'Find any action',
    body: 'Every action, tool and setting is one search away.',
  },
]

export function FirstRunGuide() {
  const step = useUi((s) => s.guideStep)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const current = step === null ? null : steps[step]

  useLayoutEffect(() => {
    if (!current) return
    const measure = () => {
      const el = document.querySelector(`[data-guide="${current.target}"]`)
      setRect(el ? el.getBoundingClientRect() : null)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [current])

  useEffect(() => {
    if (step === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') set({ guideStep: null })
      if (e.key === 'Enter' || e.key === 'ArrowRight')
        set({ guideStep: step + 1 < steps.length ? step + 1 : null })
      if (e.key === 'ArrowLeft' && step > 0) set({ guideStep: step - 1 })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  if (!current || !rect || step === null) return null
  const pad = 4
  const spot = {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
  const cardW = 320
  let cardStyle: React.CSSProperties
  if (current.place === 'top')
    cardStyle = {
      left: Math.min(window.innerWidth - cardW - 16, spot.left + 24),
      top: spot.top - 14,
      transform: 'translateY(-100%)',
    }
  else if (current.place === 'right') cardStyle = { left: spot.left + spot.width + 14, top: spot.top + 40 }
  else if (current.place === 'left') cardStyle = { left: spot.left - cardW - 14, top: spot.top + 40 }
  else cardStyle = { left: spot.left + spot.width / 2 - cardW / 2, top: spot.top + spot.height + 14 }
  const last = step === steps.length - 1

  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-label="Getting started guide">
      <div className={styles.spot} style={spot} />
      <div className={styles.card} style={{ ...cardStyle, width: cardW }} key={step}>
        <div className={styles.count}>
          {step + 1} of {steps.length}
        </div>
        <div className={styles.title}>{current.title}</div>
        <p className={styles.body}>
          {current.body}
          {current.target === 'search' && (
            <>
              {' '}
              Press <Kbd keys="Mod K" /> anytime.
            </>
          )}
        </p>
        <div className={styles.footer}>
          <div className={styles.dots}>
            {steps.map((_, i) => (
              <span key={i} className={i === step ? styles.dotOn : undefined} />
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => set({ guideStep: null })}>
            Skip
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => set({ guideStep: last ? null : step + 1 })}
            autoFocus
          >
            {last ? 'Start editing' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  )
}
