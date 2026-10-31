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
  lookItems,
  matchesQuery,
  transitionItems,
} from '../../../state/library.ts'
import { useProject } from '../../../state/project.ts'
import styles from '../Library.module.css'

function Pills({
  label,
  items,
  onAdd,
}: {
  label: string
  items: PluginCatalogEntry[]
  onAdd: (id: string) => void
}) {
  if (!items.length) return null
  return (
    <>
      <div className={styles.groupLabel}>{label}</div>
      <div className={styles.pills}>
        {items.map((item) => (
          <button key={item.id} className={styles.pill} onClick={() => onAdd(item.id)}>
            {item.name}
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
                  >
                    <span
                      className={styles.tileArt}
                      style={l.thumbnail ? { backgroundImage: `url(${l.thumbnail})` } : undefined}
                    />
                    <span className={styles.tileName}>{l.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <Pills label="Transitions · go on a cut" items={transitions} onAdd={addTransition} />
          <Pills label="Effects" items={effects} onAdd={addEffect} />
          <Pills label="Filters" items={filters} onAdd={addEffect} />
        </div>
      )}
    </>
  )
}
