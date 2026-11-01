import { AudioWaveform, Plus, Replace } from 'lucide-react'
import type { PluginCatalogEntry } from '../../../../engine/types.ts'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../../ds/Menu.tsx'
import { formatTime } from '../../../format.ts'
import {
  addVisual,
  changeVisual,
  clickVisual,
  currentVisuals,
  endLibraryDrag,
  isReactive,
  startLibraryDrag,
  visualChangeItem,
  visualItems,
  visualTargetHint,
} from '../../../state/library.ts'
import { useProject } from '../../../state/project.ts'
import { previewHandlers } from '../../../state/tilePreview.ts'
import { useUi } from '../../../state/ui.ts'
import styles from '../Library.module.css'
import { TileGroup } from './TileGroup.tsx'
import { TilePreview } from './TilePreview.tsx'

/** A visual tile's right-click menu: add it at the playhead, or change the selected visuals to it. */
function VisualMenu({ id }: { id: string }) {
  const project = useProject()
  const selection = useUi((s) => s.selection)
  const playhead = useUi((s) => s.playhead)
  const change = visualChangeItem(project, selection, id)
  return (
    <>
      <ContextMenuItem
        icon={<Plus />}
        description={`At ${formatTime(playhead, true)}`}
        onSelect={() => addVisual(id)}
      >
        Add at playhead
      </ContextMenuItem>
      <ContextMenuItem
        icon={<Replace />}
        disabled={change.disabled}
        description={change.why}
        onSelect={() => changeVisual(id)}
      >
        {change.label}
      </ContextMenuItem>
    </>
  )
}

/**
 * A visual's tile: a click changes the selected visuals of its group to it, or adds it at the playhead when none is
 * selected; its menu offers both. A drag drops it on a free stretch of a track. `current` marks the visual a
 * selected clip is now.
 */
function visualTile(v: PluginCatalogEntry, current: boolean) {
  const reactive = isReactive(v)
  const label = [v.name, reactive && 'reacts to the music', current && 'current'].filter(Boolean).join(', ')
  return (
    <ContextMenu key={v.id}>
      <ContextMenuTrigger asChild>
        <button
          className={[styles.tile, current && styles.tileOn].filter(Boolean).join(' ')}
          aria-label={reactive || current ? label : undefined}
          draggable
          onDragStart={(e) => startLibraryDrag(e.nativeEvent, { kind: 'visual', id: v.id })}
          onDragEnd={endLibraryDrag}
          onClick={() => clickVisual(v.id)}
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
            {current && (
              <span className={styles.currentMark} aria-hidden>
                Current
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <VisualMenu id={v.id} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function VisualsTab() {
  const project = useProject()
  const selection = useUi((s) => s.selection)
  const current = currentVisuals(project, selection)
  const tile = (v: PluginCatalogEntry) => visualTile(v, current.has(v.id))
  const visualizers = visualItems('visualizers')
  const shaders = visualItems('shaders')
  const keep = (items: PluginCatalogEntry[]) => items.find((v) => current.has(v.id))?.id
  return (
    <>
      <div className={styles.tabHead}>
        <p className={styles.targetNote}>{visualTargetHint(project, selection)}</p>
      </div>
      <div className={`${styles.scroller} scroll`}>
        <TileGroup
          group="visualizers"
          name="Visualizers"
          items={visualizers}
          keep={keep(visualizers)}
          tile={tile}
        />
        <TileGroup group="shaders" name="Shader visuals" items={shaders} keep={keep(shaders)} tile={tile} />
      </div>
    </>
  )
}
