import { useState } from 'react'
import type { PluginCatalogEntry } from '../../../../engine/types.ts'
import { EmptyState } from '../../../ds/Feedback.tsx'
import { SearchInput } from '../../../ds/Fields.tsx'
import {
  addEffect,
  addTransition,
  chooseLook,
  chosenLookId,
  effectItems,
  endLibraryDrag,
  lookItems,
  matchesQuery,
  startLibraryDrag,
  transitionItems,
} from '../../../state/library.ts'
import { useProject } from '../../../state/project.ts'
import { previewHandlers } from '../../../state/tilePreview.ts'
import styles from '../Library.module.css'
import { TileGroup } from './TileGroup.tsx'
import { TilePreview } from './TilePreview.tsx'

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
                data-look-tile
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
