import { Command } from 'cmdk'
import { Dialog as RDialog } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { Check, Search, Sparkles } from 'lucide-react'
import type { Asset } from '../../../model/index.ts'
import { useReturnFocus } from '../../ds/focus.ts'
import { Kbd } from '../../ds/Kbd.tsx'
import { ask } from '../../state/ask.ts'
import { keysOf } from '../../state/keymap.ts'
import { ASK_SCORE, isSentence, paletteScore } from '../../state/paletteScore.ts'
import { useThumbnail } from '../../state/thumbs.ts'
import { openAssist, set, useUi } from '../../state/ui.ts'
import {
  actionScore,
  actionsById,
  groupActions,
  GROUPS,
  groupScore,
  labelOf,
  TIE_ORDER,
  type Action,
  type Group,
} from './actions.tsx'
import { itemIcon, PAGES, type PageItem, type PageState } from './pages.tsx'
import styles from './CommandPalette.module.css'

const ASK_VALUE = 'ask-assist'

/** Actions are found by their id; the items of a page carry their name as the first keyword. */
function rank(value: string, search: string, keywords?: string[]): number {
  if (value === ASK_VALUE) return ASK_SCORE
  const action = actionsById.get(value)
  if (action) return actionScore(action, search)
  return paletteScore(keywords?.[0] ?? value, keywords?.slice(1) ?? [], search)
}

const ASK_GROUP = 'ask'

type Section = Group | typeof ASK_GROUP

/**
 * The groups in the order to show: as listed, or best match first while searching, with "Ask Assist" for a sentence
 * ranked by ASK_SCORE. Ordered here because cmdk leaves groups in the order they render.
 */
function sections(search: string, sentence: boolean): Section[] {
  const query = search.trim()
  const all: Section[] = sentence ? [ASK_GROUP, ...GROUPS] : [...GROUPS]
  if (!query) return all
  const best = (g: Section) => (g === ASK_GROUP ? ASK_SCORE : groupScore(g, query))
  const tie = (g: Section) => (g === ASK_GROUP ? -1 : TIE_ORDER.indexOf(g))
  return all.sort((a, b) => best(b) - best(a) || tie(a) - tie(b))
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

function ActionItem({ action, onPick }: { action: Action; onPick: (a: Action) => void }) {
  const reason = action.unavailable?.()
  const detail = reason ? undefined : action.detail?.()
  return (
    <Command.Item
      value={action.id}
      className={classes(styles.item, reason && styles.unavailable)}
      onSelect={() => {
        if (!reason) onPick(action)
      }}
    >
      <span className={styles.itemIcon}>{action.icon}</span>
      <span className={styles.itemLabel}>{labelOf(action)}</span>
      {reason ? (
        <span className={styles.reason}>{reason}</span>
      ) : (
        <>
          {detail && <span className={styles.detail}>{detail}</span>}
          {action.shortcut && <Kbd keys={keysOf(action.shortcut)} />}
        </>
      )}
    </Command.Item>
  )
}

/** A media row's frame, its kind's icon until the frame is made; the footage in use now has a check on it. */
function MediaThumb({ asset, icon, current }: { asset: Asset; icon: ReactNode; current: boolean }) {
  const url = useThumbnail(asset)
  return (
    <span className={styles.thumb}>
      {url ? <img src={url} alt="" draggable={false} /> : icon}
      {current && (
        <span className={styles.thumbCheck}>
          <Check />
        </span>
      )}
    </span>
  )
}

function PageRow({ item, onPick }: { item: PageItem; onPick: (item: PageItem) => void }) {
  return (
    <Command.Item
      value={item.value}
      keywords={item.keywords ?? [item.label]}
      className={classes(styles.item, item.unavailable && styles.unavailable)}
      onSelect={() => {
        if (!item.unavailable) onPick(item)
      }}
    >
      <span className={styles.itemIcon}>
        {item.thumb ? (
          <MediaThumb asset={item.thumb} icon={item.icon} current={!!item.current} />
        ) : (
          itemIcon(item)
        )}
      </span>
      <span className={styles.itemLabel}>{item.label}</span>
      {item.unavailable ? (
        <span className={styles.reason}>{item.unavailable}</span>
      ) : (
        item.detail && <span className={styles.detail}>{item.detail}</span>
      )}
    </Command.Item>
  )
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  /** The list the palette was opened on, as from the clip menu; Esc there closes the palette. */
  const start = useUi((s) => s.palettePage)
  const returnFocus = useReturnFocus()
  const [search, setSearch] = useState('')
  const [pages, setPages] = useState<PageState[]>([])
  /** A list was opened or left since the palette opened, so the new list's search takes focus. */
  const [moved, setMoved] = useState(false)
  const page = pages.at(-1) ?? (start ? { id: start } : undefined)
  const close = () => {
    set({ paletteOpen: false, palettePage: null })
    setSearch('')
    setPages([])
    setMoved(false)
  }
  const run = (fn: () => void) => {
    close()
    fn()
  }
  const openPage = (next: PageState) => {
    setPages((list) => [...list, next])
    setSearch('')
    setMoved(true)
  }
  const back = () => {
    if (pages.length) setPages((list) => list.slice(0, -1))
    else set({ palettePage: null })
    setSearch('')
    setMoved(true)
  }
  const pickAction = (a: Action) => {
    if (a.page) openPage({ id: a.page })
    else if (a.run) run(a.run)
  }
  const pickItem = (item: PageItem) => {
    if (item.open) openPage(item.open)
    else if (item.run) run(item.run)
  }
  const sentence = !page && isSentence(search)
  const def = page && PAGES[page.id]

  return (
    <RDialog.Root open={open} onOpenChange={(o) => (o ? set({ paletteOpen: true }) : close())}>
      <RDialog.Portal>
        <RDialog.Overlay className={styles.overlay} />
        <RDialog.Content
          className={styles.content}
          aria-describedby={undefined}
          {...returnFocus}
          onEscapeKeyDown={(e) => {
            if (!pages.length) return
            e.preventDefault()
            back()
          }}
        >
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          {/* Keyed by page, so a list starts at its top with its first item selected. */}
          <Command
            key={[
              start ?? '',
              ...pages.map((p) => ('property' in p ? `${p.id}:${p.property.path.join('.')}` : p.id)),
            ].join('/')}
            label="Command palette"
            className={styles.command}
            loop
            filter={rank}
            onKeyDown={(e) => {
              if (page && e.key === 'Backspace' && !search) {
                e.preventDefault()
                back()
              }
            }}
          >
            <div className={styles.inputRow}>
              <Search className={styles.inputIcon} />
              {/*
               * Only after a list change: on opening, Radix focuses the search after noting what had focus, which
               * gets it back on closing.
               */}
              <Command.Input
                autoFocus={moved}
                value={search}
                onValueChange={setSearch}
                placeholder={
                  def ? def.placeholder : 'Search actions, tools and settings, or describe a change'
                }
                className={styles.input}
              />
              <Kbd keys="Esc" />
            </div>
            <Command.List className={styles.list}>
              <Command.Empty className={styles.empty}>
                {def ? def.empty : 'No matching action. Try fewer words.'}
              </Command.Empty>
              {page &&
                def?.groups(page).map(
                  (group) =>
                    group.items.length > 0 && (
                      <Command.Group key={group.heading} heading={group.heading} className={styles.group}>
                        {group.items.map((item) => (
                          <PageRow key={item.value} item={item} onPick={pickItem} />
                        ))}
                      </Command.Group>
                    ),
                )}
              {!page &&
                sections(search, sentence).map((g) =>
                  g === ASK_GROUP ? (
                    <Command.Group key={g} heading="Ask Assist" className={styles.group}>
                      <Command.Item
                        value={ASK_VALUE}
                        className={styles.item}
                        onSelect={() =>
                          run(() => {
                            openAssist('home')
                            void ask(search.trim())
                          })
                        }
                      >
                        <span className={classes(styles.itemIcon, styles.askIcon)}>
                          <Sparkles />
                        </span>
                        <span className={styles.itemLabel}>Ask Assist: “{search.trim()}”</span>
                        <Kbd keys="Enter" />
                      </Command.Item>
                    </Command.Group>
                  ) : (
                    <Command.Group key={g} heading={g} className={styles.group}>
                      {groupActions(g, search).map((a) => (
                        <ActionItem key={a.id} action={a} onPick={pickAction} />
                      ))}
                    </Command.Group>
                  ),
                )}
            </Command.List>
            <div className={styles.footer}>
              <span>
                <Kbd keys="↑" /> <Kbd keys="↓" /> to move
              </span>
              <span>
                <Kbd keys="Enter" /> to run
              </span>
              {page ? (
                <span className={styles.footerRight}>
                  <Kbd keys="Esc" /> to {pages.length ? 'go back' : 'close'}
                </span>
              ) : (
                <span className={styles.footerRight}>Type a sentence to ask Assist</span>
              )}
            </div>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
