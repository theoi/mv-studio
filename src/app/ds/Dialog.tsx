import { Dialog as RDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './Button.tsx'
import styles from './Dialog.module.css'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  width?: number
  height?: number
  children: ReactNode
  footer?: ReactNode
  headerExtra?: ReactNode
  bare?: boolean
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  width = 560,
  height,
  children,
  footer,
  headerExtra,
  bare,
}: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className={styles.overlay} />
        <RDialog.Content
          className={styles.content}
          style={{
            width: `min(${width}px, calc(100vw - 48px))`,
            height: height ? `min(${height}px, calc(100vh - 48px))` : undefined,
          }}
          aria-describedby={description ? undefined : undefined}
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)?.focus()
          }}
          // Toasts sit outside the dialog: pressing a toast's Undo must not close the dialog it undoes in. The check
          // can run after the click removed the toast, so it looks for the toast itself, not the toaster.
          onInteractOutside={(e) => {
            if ((e.target as Element | null)?.closest?.('[data-toast]')) e.preventDefault()
          }}
        >
          {bare ? (
            <RDialog.Title className="sr-only">{title}</RDialog.Title>
          ) : (
            <header className={styles.header}>
              <div className={styles.headerText}>
                <RDialog.Title className={styles.title}>{title}</RDialog.Title>
                {description && (
                  <RDialog.Description className={styles.description}>{description}</RDialog.Description>
                )}
              </div>
              {headerExtra}
              <RDialog.Close asChild>
                <IconButton label="Close" shortcut="Esc" size="sm">
                  <X />
                </IconButton>
              </RDialog.Close>
            </header>
          )}
          <div className={styles.body}>{children}</div>
          {footer && <footer className={styles.footer}>{footer}</footer>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
