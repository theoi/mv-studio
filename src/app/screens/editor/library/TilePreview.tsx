import { useEffect, useRef } from 'react'
import { playTilePreview, useTilePreviewActive, type PreviewItem } from '../../../state/tilePreview.ts'
import styles from '../Library.module.css'

/** The live preview over a tile's art while the tile is hovered or focused (see state/tilePreview.ts). */
export function TilePreview({ item }: { item: PreviewItem }) {
  const active = useTilePreviewActive(item)
  const host = useRef<HTMLSpanElement>(null)
  const { kind, id } = item
  useEffect(() => {
    if (!active || !host.current) return
    return playTilePreview({ kind, id }, host.current)
  }, [active, kind, id])
  return active ? <span ref={host} className={styles.tilePreview} aria-hidden /> : null
}
