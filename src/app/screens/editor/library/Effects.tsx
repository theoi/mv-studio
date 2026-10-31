import { useState } from 'react'
import { SearchInput } from '../../../ds/Fields.tsx'
import { sceneThumb } from '../../../mock/art.ts'
import { toast } from '../../../state/ui.ts'
import styles from '../Library.module.css'

const looks: { name: string; filter: string }[] = [
  { name: 'Original', filter: 'none' },
  { name: 'Neon noir', filter: 'contrast(1.25) saturate(1.4) hue-rotate(-12deg)' },
  { name: 'Golden hour', filter: 'sepia(0.45) saturate(1.3) brightness(1.05)' },
  { name: 'VHS', filter: 'saturate(1.6) contrast(0.9) blur(0.4px)' },
  { name: 'Mono', filter: 'grayscale(1) contrast(1.2)' },
  { name: 'Dream', filter: 'brightness(1.15) saturate(0.8) blur(0.6px)' },
]

const transitions = ['Crossfade', 'Flash', 'Whip pan', 'Zoom', 'Glitch', 'Dip to black']
const effects = ['Zoom pulse', 'RGB split', 'Glow', 'Shake', 'Strobe', 'Blur']

export function EffectsTab() {
  const [query, setQuery] = useState('')
  return (
    <>
      <div className={styles.toolbar}>
        <SearchInput value={query} onChange={setQuery} placeholder="Search looks and effects" />
      </div>
      <div className={`${styles.scroller} scroll`}>
        <div className={styles.groupLabel}>Looks · restyle the whole video</div>
        <div className={styles.tiles}>
          {looks.map((l, i) => (
            <button
              key={l.name}
              className={[styles.tile, i === 1 && styles.tileOn].filter(Boolean).join(' ')}
              onClick={() =>
                toast(`Look “${l.name}” applied to the whole video`, { label: 'Undo', run: () => undefined })
              }
            >
              <span
                className={styles.tileArt}
                style={{ backgroundImage: `url(${sceneThumb('city')})`, filter: l.filter }}
              />
              <span className={styles.tileName}>{l.name}</span>
            </button>
          ))}
        </div>
        <div className={styles.groupLabel}>Transitions · drop on a cut</div>
        <div className={styles.pills}>
          {transitions.map((t) => (
            <button key={t} className={styles.pill} draggable>
              {t}
            </button>
          ))}
        </div>
        <div className={styles.groupLabel}>Effects</div>
        <div className={styles.pills}>
          {effects.map((t) => (
            <button key={t} className={styles.pill} draggable>
              {t}
            </button>
          ))}
        </div>
        <div className={styles.groupLabel}>Filters</div>
        <div className={styles.pills}>
          {['Film grain', 'Vignette', 'Teal & orange', 'Faded', 'Bleach'].map((t) => (
            <button key={t} className={styles.pill} draggable>
              {t}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
