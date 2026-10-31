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
import { TilePreview } from './TilePreview.tsx'

/** Effects, filters or transitions as thumbnail tiles: a click adds one, a drag drops it on the timeline. */
function Tiles({
  label,
  kind,
  items,
  onAdd,
}: {
  label: string
  kind: 'effect' | 'transition'
  items: PluginCatalogEntry[]
  onAdd: (id: string) => void
}) {
  if (!items.length) return null
  return (
    <>
      <div className={styles.groupLabel}>{label}</div>
      <div className={styles.tiles}>
        {items.map((item) => (
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
        ))}
      </div>
    </>
  )
}

export function EffectsTab() {
  const [query, setQuery] = useState('')
  const project = useProject()
  const chosen = chosenLookId(project)
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
          {looks.length > 0 && (
            <>
              <div className={styles.groupLabel}>Looks · restyle the whole video</div>
              <div className={styles.tiles}>
                {looks.map((l) => (
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
                ))}
              </div>
            </>
          )}
          <Tiles
            label="Transitions · go on a cut"
            kind="transition"
            items={transitions}
            onAdd={addTransition}
          />
          <Tiles label="Effects" kind="effect" items={effects} onAdd={addEffect} />
          <Tiles label="Filters" kind="effect" items={filters} onAdd={addEffect} />
        </div>
      )}
    </>
  )
}
