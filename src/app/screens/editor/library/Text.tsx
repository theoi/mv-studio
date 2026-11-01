import { Type } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import {
  applyLibraryTextStyle,
  applyTextAnimation,
  currentTextItems,
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

/** A kinetic preset's or text style's tile; `current` marks what the texts a click would restyle have now. */
function Tile({
  item,
  name,
  thumbnail,
  current,
  onAdd,
}: {
  item: PreviewItem
  name: string
  thumbnail?: string
  current: boolean
  onAdd: () => void
}) {
  return (
    <button
      className={[styles.tile, current && styles.tileOn].filter(Boolean).join(' ')}
      aria-label={current ? `${name}, current` : undefined}
      onClick={onAdd}
      {...previewHandlers(item)}
    >
      <span
        className={styles.tileArt}
        style={thumbnail ? { backgroundImage: `url(${thumbnail})` } : undefined}
      >
        <TilePreview item={item} />
        {current && (
          <span className={styles.currentMark} aria-hidden>
            Current
          </span>
        )}
      </span>
      <span className={styles.tileName}>{name}</span>
    </button>
  )
}

export function TextTab() {
  const project = useProject()
  const selection = useUi((s) => s.selection)
  const current = currentTextItems(project, selection)
  const kinetic = textAnimationItems()
  const karaoke = textStyleItems('karaoke')
  const textStyles = textStyleItems('styles')
  const keep = (items: { id: string }[]) => items.find((i) => current.has(i.id))?.id
  const styleTile = (t: (typeof textStyles)[number]) => (
    <Tile
      key={t.id}
      item={{ kind: 'text-style', id: t.id }}
      name={t.name}
      thumbnail={t.thumbnail}
      current={current.has(t.id)}
      onAdd={() => applyLibraryTextStyle(t.id)}
    />
  )
  return (
    <>
      <div className={styles.tabHead}>
        <Button variant="secondary" block icon={<Type />} onClick={addTextAtPlayhead}>
          Add text
        </Button>
        <p className={styles.targetNote}>{textTargetHint(project, selection)}</p>
      </div>
      <div className={`${styles.scroller} scroll`}>
        <TileGroup
          group="kinetic"
          name="Kinetic presets"
          items={kinetic}
          keep={keep(kinetic)}
          tile={(k) => (
            <Tile
              key={k.id}
              item={{ kind: 'plugin', id: k.id }}
              name={k.name}
              thumbnail={k.thumbnail}
              current={current.has(k.id)}
              onAdd={() => applyTextAnimation(k.id)}
            />
          )}
        />
        <TileGroup
          group="karaoke"
          name="Karaoke styles"
          items={karaoke}
          keep={keep(karaoke)}
          tile={styleTile}
        />
        <TileGroup
          group="text-styles"
          name="Text styles"
          items={textStyles}
          keep={keep(textStyles)}
          tile={styleTile}
        />
      </div>
    </>
  )
}
