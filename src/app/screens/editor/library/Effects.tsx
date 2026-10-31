import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { PluginCatalogEntry } from '../../../../engine/types.ts'
import { Button } from '../../../ds/Button.tsx'
import { EmptyState } from '../../../ds/Feedback.tsx'
import { SearchInput } from '../../../ds/Fields.tsx'
import {
  addEffect,
  addTransition,
  chooseLook,
  chosenLookId,
  effectItems,
  endLibraryDrag,
  GROUP_ROWS,
  lookItems,
  matchesQuery,
  startLibraryDrag,
  toggleLibraryGroup,
  transitionItems,
} from '../../../state/library.ts'
import { useProject } from '../../../state/project.ts'
import { previewHandlers } from '../../../state/tilePreview.ts'
import { useUi } from '../../../state/ui.ts'
import styles from '../Library.module.css'
import { TilePreview } from './TilePreview.tsx'

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
 * A titled grid of tiles that shows its first rows, with "Show all N" to expand it for the session. While searching,
 * every match shows and there is no button. The item `keep` (the chosen look) always shows, in the last slot when
 * it is past the first rows.
 */
function TileGroup<T extends { id: string }>({
  group,
  name,
  items,
  searching,
  keep,
  tile,
}: {
  group: string
  name: string
  items: T[]
  searching: boolean
  keep?: string
  tile: (item: T) => ReactNode
}) {
  const expanded = useUi((s) => s.libraryExpanded.includes(group))
  const [gridRef, columns] = useColumns()
  if (!items.length) return null
  const limit = GROUP_ROWS * columns
  const collapsible = !searching && items.length > limit
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

/** An effect, filter or transition tile: a click adds it, a drag drops it on the timeline. */
function pluginTile(kind: 'effect' | 'transition', onAdd: (id: string) => void) {
  return function PluginTile(item: PluginCatalogEntry) {
    return (
      <button
        key={item.id}
        className={styles.tile}
        draggable
        onDragStart={(e) => startLibraryDrag(e.nativeEvent, { kind, id: item.id })}
        onDragEnd={endLibraryDrag}
        onClick={() => onAdd(item.id)}
        {...previewHandlers({ kind: 'plugin', id: item.id })}
      >
        <span
          className={styles.tileArt}
          style={item.thumbnail ? { backgroundImage: `url(${item.thumbnail})` } : undefined}
        >
          <TilePreview item={{ kind: 'plugin', id: item.id }} />
        </span>
        <span className={styles.tileName}>{item.name}</span>
      </button>
    )
  }
}

export function EffectsTab() {
  const [query, setQuery] = useState('')
  const project = useProject()
  const chosen = chosenLookId(project)
  const searching = query.trim() !== ''
  const looks = lookItems().filter((l) => matchesQuery(query, l))
  const transitions = transitionItems().filter((t) => matchesQuery(query, t))
  const effects = effectItems('effects').filter((e) => matchesQuery(query, e))
  const filters = effectItems('filters').filter((e) => matchesQuery(query, e))
  const nothing = !looks.length && !transitions.length && !effects.length && !filters.length
  return (
    <>
      <div className={styles.toolbar}>
        <SearchInput value={query} onChange={setQuery} placeholder="Search looks and effects" />
      </div>
      {nothing ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            title="No matches"
            description={`Nothing matches “${query.trim()}”. Try a mood, such as “warm” or “glitch”.`}
          />
        </div>
      ) : (
        <div className={`${styles.scroller} scroll`}>
          <TileGroup
            group="looks"
            name="Looks"
            items={looks}
            searching={searching}
            keep={chosen}
            tile={(l) => (
              <button
                key={l.id}
                className={[styles.tile, chosen === l.id && styles.tileOn].filter(Boolean).join(' ')}
                aria-pressed={chosen === l.id}
                onClick={() => chooseLook(l.id)}
                {...previewHandlers({ kind: 'look', id: l.id })}
              >
                <span
                  className={styles.tileArt}
                  style={l.thumbnail ? { backgroundImage: `url(${l.thumbnail})` } : undefined}
                >
                  <TilePreview item={{ kind: 'look', id: l.id }} />
                </span>
                <span className={styles.tileName}>{l.name}</span>
              </button>
            )}
          />
          <TileGroup
            group="transitions"
            name="Transitions"
            items={transitions}
            searching={searching}
            tile={pluginTile('transition', addTransition)}
          />
          <TileGroup
            group="effects"
            name="Effects"
            items={effects}
            searching={searching}
            tile={pluginTile('effect', addEffect)}
          />
          <TileGroup
            group="filters"
            name="Filters"
            items={filters}
            searching={searching}
            tile={pluginTile('effect', addEffect)}
          />
        </div>
      )}
    </>
  )
}
