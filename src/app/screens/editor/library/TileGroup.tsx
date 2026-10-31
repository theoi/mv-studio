import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '../../../ds/Button.tsx'
import { GROUP_ROWS, toggleLibraryGroup } from '../../../state/library.ts'
import { useUi } from '../../../state/ui.ts'
import styles from '../Library.module.css'

/** The number of columns a tile grid resolves to at its current width. */
function useColumns() {
  const [columns, setColumns] = useState(2)
  const ref = useCallback((grid: HTMLDivElement | null) => {
    if (!grid) return
    const measure = () =>
      setColumns(Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])
  return [ref, columns] as const
}

/**
 * A titled grid of tiles that shows its first rows, with "Show all N" to expand it for the session, when that hides
 * at least two tiles (a button that reveals one tile isn't worth its row). While searching, every match shows and
 * there is no button. The item `keep` (the chosen look) always shows, in the last slot when it is past the first
 * rows.
 */
export function TileGroup<T extends { id: string }>({
  group,
  name,
  items,
  searching = false,
  keep,
  tile,
}: {
  group: string
  name: string
  items: T[]
  searching?: boolean
  keep?: string
  tile: (item: T) => ReactNode
}) {
  const expanded = useUi((s) => s.libraryExpanded.includes(group))
  const [gridRef, columns] = useColumns()
  if (!items.length) return null
  const limit = GROUP_ROWS * columns
  const collapsible = !searching && items.length >= limit + 2
  let shown = items
  if (collapsible && !expanded) {
    const kept = items.findIndex((i) => i.id === keep)
    shown = kept >= limit ? [...items.slice(0, limit - 1), items[kept]!] : items.slice(0, limit)
  }
  const gridId = `library-group-${group}`
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const button = e.currentTarget
    const top = button.getBoundingClientRect().top
    flushSync(() => toggleLibraryGroup(group))
    if (!expanded) return
    // Collapsing moves the focused button up by the hidden rows; scroll so it stays where it was on screen.
    const scroller = button.closest(`.${styles.scroller}`)
    if (scroller) scroller.scrollTop += button.getBoundingClientRect().top - top
    button.scrollIntoView({ block: 'nearest' })
  }
  return (
    <>
      <div className={styles.groupLabel}>
        {name} · {items.length}
      </div>
      <div ref={gridRef} id={gridId} className={styles.tiles} role="group" aria-label={name}>
        {shown.map(tile)}
      </div>
      {collapsible && (
        <div className={styles.groupMore}>
          <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={gridId} onClick={toggle}>
            {expanded ? 'Show fewer' : `Show all ${items.length}`}
          </Button>
        </div>
      )}
    </>
  )
}
