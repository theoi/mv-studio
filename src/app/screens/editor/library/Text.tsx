import { Type } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { toast } from '../../../state/ui.ts'
import styles from '../Library.module.css'

const kinetic = [
  { id: 'rise', name: 'Rise', sample: 'Rise' },
  { id: 'pop', name: 'Pop', sample: 'Pop!' },
  { id: 'type', name: 'Typewriter', sample: 'Type_' },
  { id: 'wave', name: 'Wave', sample: 'Wave' },
  { id: 'glitch', name: 'Glitch', sample: 'Glitch' },
  { id: 'sweep', name: 'Karaoke sweep', sample: 'Sweep' },
]

const textStyles = [
  { id: 'title', name: 'Title', cls: 'tsTitle', sample: 'NEON' },
  { id: 'subtitle', name: 'Subtitle', cls: 'tsSub', sample: 'Lumen Drive' },
  { id: 'caption', name: 'Caption', cls: 'tsCaption', sample: 'Under the neon skyline' },
  { id: 'outline', name: 'Outline', cls: 'tsOutline', sample: 'ALIVE' },
]

export function TextTab() {
  return (
    <div className={`${styles.scroller} scroll`}>
      <div className={styles.padded}>
        <Button
          variant="secondary"
          block
          icon={<Type />}
          onClick={() => toast('Text layer added at the playhead')}
        >
          Add text
        </Button>
      </div>
      <div className={styles.groupLabel}>Kinetic presets · drop on lyrics or text</div>
      <div className={styles.tiles}>
        {kinetic.map((k) => (
          <button key={k.id} className={styles.tile} draggable>
            <span className={[styles.tileArt, styles.kinetic, styles[`k-${k.id}`]].join(' ')}>
              <span>{k.sample}</span>
            </span>
            <span className={styles.tileName}>{k.name}</span>
          </button>
        ))}
      </div>
      <div className={styles.groupLabel}>Text styles</div>
      <div className={styles.tiles}>
        {textStyles.map((t) => (
          <button key={t.id} className={styles.tile} draggable>
            <span className={[styles.tileArt, styles.textStyle, styles[t.cls]].join(' ')}>
              <span>{t.sample}</span>
            </span>
            <span className={styles.tileName}>{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
