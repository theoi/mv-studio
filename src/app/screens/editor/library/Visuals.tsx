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
import { TilePreview } from './TilePreview.tsx'

function Group({ label, items }: { label: string; items: PluginCatalogEntry[] }) {
  return (
    <>
      <div className={styles.groupLabel}>{label}</div>
      <div className={styles.tiles}>
        {items.map((v) => (
          <button
            key={v.id}
            className={styles.tile}
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
              {isReactive(v) && (
                <span className={styles.reactive} title="Reacts to the music">
                  <AudioWaveform />
                </span>
              )}
            </span>
            <span className={styles.tileName}>{v.name}</span>
          </button>
        ))}
      </div>
    </>
  )
}

export function VisualsTab() {
  return (
    <div className={`${styles.scroller} scroll`}>
      <Group label="Visualizers" items={visualItems('visualizers')} />
      <Group label="Shader visuals" items={visualItems('shaders')} />
    </div>
  )
}
