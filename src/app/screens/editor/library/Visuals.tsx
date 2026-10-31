import { AudioWaveform } from 'lucide-react'
import type { PluginCatalogEntry } from '../../../../engine/types.ts'
import {
  addVisual,
  endLibraryDrag,
  isReactive,
  startLibraryDrag,
  visualItems,
} from '../../../state/library.ts'
import { previewHandlers } from '../../../state/tilePreview.ts'
import styles from '../Library.module.css'
import { TileGroup } from './TileGroup.tsx'
import { TilePreview } from './TilePreview.tsx'

/** A visual's tile: a click adds it at the playhead, a drag drops it on a free stretch of a track. */
function visualTile(v: PluginCatalogEntry) {
  const reactive = isReactive(v)
  return (
    <button
      key={v.id}
      className={styles.tile}
      aria-label={reactive ? `${v.name}, reacts to the music` : undefined}
      draggable
      onDragStart={(e) => startLibraryDrag(e.nativeEvent, { kind: 'visual', id: v.id })}
      onDragEnd={endLibraryDrag}
      onClick={() => addVisual(v.id)}
      {...previewHandlers({ kind: 'plugin', id: v.id })}
    >
      <span
        className={styles.tileArt}
        style={v.thumbnail ? { backgroundImage: `url(${v.thumbnail})` } : undefined}
      >
        <TilePreview item={{ kind: 'plugin', id: v.id }} />
        {reactive && (
          <span className={styles.reactive} title="Reacts to the music">
            <AudioWaveform />
          </span>
        )}
      </span>
      <span
        className={styles.tileName}
        onPointerEnter={(e) => {
          // Names cut off by narrow tiles get their full text as a tooltip.
          const el = e.currentTarget
          el.title = el.scrollWidth > el.clientWidth ? v.name : ''
        }}
      >
        {v.name}
      </span>
    </button>
  )
}

export function VisualsTab() {
  return (
    <div className={`${styles.scroller} scroll`}>
      <TileGroup
        group="visualizers"
        name="Visualizers"
        items={visualItems('visualizers')}
        tile={visualTile}
      />
      <TileGroup group="shaders" name="Shader visuals" items={visualItems('shaders')} tile={visualTile} />
    </div>
  )
}
