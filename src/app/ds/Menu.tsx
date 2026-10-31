import { ContextMenu as RContext, DropdownMenu as RMenu } from 'radix-ui'
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { Kbd } from './Kbd.tsx'
import styles from './Menu.module.css'

export const Menu = RMenu.Root
export const MenuTrigger = RMenu.Trigger

export function MenuContent({
  children,
  align = 'start',
  side = 'bottom',
  width,
  id,
  onCloseAutoFocus,
}: {
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  width?: number
  /** For a trigger of its own that points at the menu with aria-controls. */
  id?: string
  /** Call event.preventDefault() when an item moved focus elsewhere (e.g. into a rename field). */
  onCloseAutoFocus?: (event: Event) => void
}) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        id={id}
        className={styles.content}
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
        style={{ minWidth: width }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  )
}

interface ItemProps {
  icon?: ReactNode
  shortcut?: string
  description?: string
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}

function ItemBody({
  icon,
  shortcut,
  description,
  children,
}: Omit<ItemProps, 'onSelect' | 'disabled' | 'danger'>) {
  return (
    <>
      <span className={styles.itemIcon}>{icon}</span>
      <span className={styles.itemText}>
        <span>{children}</span>
        {description && <span className={styles.itemDesc}>{description}</span>}
      </span>
      {shortcut && <Kbd keys={shortcut} />}
    </>
  )
}

export function MenuItem({ onSelect, disabled, danger, ...body }: ItemProps) {
  return (
    <RMenu.Item
      className={[styles.item, danger && styles.danger].filter(Boolean).join(' ')}
      onSelect={onSelect}
      disabled={disabled}
    >
      <ItemBody {...body} />
    </RMenu.Item>
  )
}

export function MenuCheckItem({
  checked,
  onCheckedChange,
  children,
  shortcut,
  description,
  disabled,
}: {
  checked: boolean
  onCheckedChange?: (v: boolean) => void
  children: ReactNode
  shortcut?: string
  /** A second line, e.g. why the item is disabled. */
  description?: string
  disabled?: boolean
}) {
  return (
    <RMenu.CheckboxItem
      className={styles.item}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
    >
      <span className={styles.itemIcon}>{checked && <Check />}</span>
      <span className={styles.itemText}>
        <span>{children}</span>
        {description && <span className={styles.itemDesc}>{description}</span>}
      </span>
      {shortcut && <Kbd keys={shortcut} />}
    </RMenu.CheckboxItem>
  )
}

export function MenuSeparator() {
  return <RMenu.Separator className={styles.separator} />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className={styles.label}>{children}</RMenu.Label>
}

export const ContextMenu = RContext.Root
export const ContextMenuTrigger = RContext.Trigger

export function ContextMenuContent({
  children,
  onCloseAutoFocus,
}: {
  children: ReactNode
  /** Call preventDefault() to put focus somewhere else when the menu closes. */
  onCloseAutoFocus?: (e: Event) => void
}) {
  return (
    <RContext.Portal>
      <RContext.Content className={styles.content} collisionPadding={8} onCloseAutoFocus={onCloseAutoFocus}>
        {children}
      </RContext.Content>
    </RContext.Portal>
  )
}

export function ContextMenuItem({ onSelect, disabled, danger, ...body }: ItemProps) {
  return (
    <RContext.Item
      className={[styles.item, danger && styles.danger].filter(Boolean).join(' ')}
      onSelect={onSelect}
      disabled={disabled}
    >
      <ItemBody {...body} />
    </RContext.Item>
  )
}

export function ContextMenuSeparator() {
  return <RContext.Separator className={styles.separator} />
}

const CloseSub = createContext<() => void>(() => undefined)

/** A submenu. Esc in it closes only the submenu, back to its trigger, as Left does; the next Esc closes the menu. */
export function ContextMenuSub({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <CloseSub.Provider value={() => setOpen(false)}>
      <RContext.Sub open={open} onOpenChange={setOpen}>
        {children}
      </RContext.Sub>
    </CloseSub.Provider>
  )
}

export function ContextMenuSubTrigger({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <RContext.SubTrigger className={styles.item}>
      <ItemBody icon={icon}>{children}</ItemBody>
      <ChevronRight className={styles.subArrow} />
    </RContext.SubTrigger>
  )
}

export function ContextMenuSubContent({ children }: { children: ReactNode }) {
  const close = useContext(CloseSub)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <RContext.Portal>
      <RContext.SubContent
        ref={ref}
        className={styles.content}
        sideOffset={4}
        alignOffset={-4}
        collisionPadding={8}
        onEscapeKeyDown={(e) => {
          // Radix closes the whole menu on Esc; preventing that keeps the menu open, with focus back on the trigger.
          e.preventDefault()
          const trigger = ref.current?.getAttribute('aria-labelledby')
          close()
          if (trigger) document.getElementById(trigger)?.focus()
        }}
      >
        {children}
      </RContext.SubContent>
    </RContext.Portal>
  )
}
