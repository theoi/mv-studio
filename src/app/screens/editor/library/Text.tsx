import { Type } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import {
  applyLibraryTextStyle,
  applyTextAnimation,
  textAnimationItems,
  textStyleItems,
  textTargetHint,
} from '../../../state/library.ts'
import { addTextAtPlayhead, useProject } from '../../../state/project.ts'
import { useUi } from '../../../state/ui.ts'
import { previewHandlers, type PreviewItem } from '../../../state/tilePreview.ts'
import styles from '../Library.module.css'
import { TileGroup } from './TileGroup.tsx'
import { TilePreview } from './TilePreview.tsx'

function Tile({
  item,
  name,
  thumbnail,
  onAdd,
}: {
  item: PreviewItem
  name: string
  thumbnail?: string
  onAdd: () => void
}) {
  return (
    <button className={styles.tile} onClick={onAdd} {...previewHandlers(item)}>
      <span
        className={styles.tileArt}
        style={thumbnail ? { backgroundImage: `url(${thumbnail})` } : undefined}
      >
        <TilePreview item={item} />
      </span>
      <span className={styles.tileName}>{name}</span>
    </button>
  )
}

const styleTile = (t: ReturnType<typeof textStyleItems>[number]) => (
  <Tile
    key={t.id}
    item={{ kind: 'text-style', id: t.id }}
    name={t.name}
    thumbnail={t.thumbnail}
    onAdd={() => applyLibraryTextStyle(t.id)}
  />
)

export function TextTab() {
  const project = useProject()
  const selection = useUi((s) => s.selection)
  return (
    <div className={`${styles.scroller} scroll`}>
      <div className={styles.padded}>
        <Button variant="secondary" block icon={<Type />} onClick={addTextAtPlayhead}>
          Add text
        </Button>
        <p className={styles.targetNote}>{textTargetHint(project, selection)}</p>
      </div>
      <TileGroup
        group="kinetic"
        name="Kinetic presets"
        items={textAnimationItems()}
        tile={(k) => (
          <Tile
            key={k.id}
            item={{ kind: 'plugin', id: k.id }}
            name={k.name}
            thumbnail={k.thumbnail}
            onAdd={() => applyTextAnimation(k.id)}
          />
        )}
      />
      <TileGroup group="karaoke" name="Karaoke styles" items={textStyleItems('karaoke')} tile={styleTile} />
      <TileGroup group="text-styles" name="Text styles" items={textStyleItems('styles')} tile={styleTile} />
    </div>
  )
}
