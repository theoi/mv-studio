import { AudioWaveform, Plus, Replace } from 'lucide-react'
import type { PluginCatalogEntry } from '../../../../engine/types.ts'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../../ds/Menu.tsx'
import { formatTime } from '../../../format.ts'
import {
  addVisual,
  changeVisual,
  clickVisual,
  endLibraryDrag,
  isReactive,
  startLibraryDrag,
  visualItems,
  visualTargetHint,
  visualTargets,
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
  const targets = visualTargets(project, selection)
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
        disabled={!targets || 'why' in targets}
        description={
          !targets ? 'Select a visual on the timeline first' : 'why' in targets ? targets.why : undefined
        }
        onSelect={() => changeVisual(id)}
      >
        {targets && !('why' in targets) ? `Change ${targets.what}` : 'Change the selected visual'}
      </ContextMenuItem>
    </>
  )
}

/**
 * A visual's tile: a click changes the selected visuals to it, or adds it at the playhead when none is selected; its
 * menu offers both. A drag drops it on a free stretch of a track.
 */
function visualTile(v: PluginCatalogEntry) {
  const reactive = isReactive(v)
  return (
    <ContextMenu key={v.id}>
      <ContextMenuTrigger asChild>
        <button
          className={styles.tile}
          aria-label={reactive ? `${v.name}, reacts to the music` : undefined}
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
  return (
    <div className={`${styles.scroller} scroll`}>
      <div className={styles.padded}>
        <p className={styles.targetNote}>{visualTargetHint(project, selection)}</p>
      </div>
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
