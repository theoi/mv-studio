import { AudioWaveform } from 'lucide-react'
import { sceneThumb, type SceneId } from '../../../mock/art.ts'
import styles from '../Library.module.css'

const visualizers: { name: string; scene: SceneId; overlay: 'bars' | 'line' | 'ring' | 'dots' }[] = [
  { name: 'Spectrum bars', scene: 'neon', overlay: 'bars' },
  { name: 'Waveform line', scene: 'ocean', overlay: 'line' },
  { name: 'Waveform ring', scene: 'tunnel', overlay: 'ring' },
  { name: 'Particles', scene: 'aurora', overlay: 'dots' },
]

const shaders: { name: string; gradient: string }[] = [
  {
    name: 'Flow field',
    gradient:
      'radial-gradient(circle at 30% 40%, #6c5cf0, transparent 55%), radial-gradient(circle at 70% 70%, #ff5fa2, transparent 50%), #0c0a18',
  },
  {
    name: 'Plasma',
    gradient: 'conic-gradient(from 90deg at 50% 50%, #ff7a59, #ffd36e, #5fd4c8, #6c5cf0, #ff7a59)',
  },
  { name: 'Kaleido', gradient: 'repeating-conic-gradient(from 0deg, #1d1a3a 0 15deg, #9b5f7c 15deg 30deg)' },
  {
    name: 'Liquid chrome',
    gradient: 'linear-gradient(135deg, #2b2f3a, #cfd6e4 40%, #3a3f4d 60%, #e9edf5 80%, #22252d)',
  },
]

function VisualOverlay({ kind }: { kind: 'bars' | 'line' | 'ring' | 'dots' }) {
  if (kind === 'bars')
    return (
      <span className={styles.ovBars}>
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} style={{ height: `${20 + Math.abs(Math.sin(i * 1.3)) * 70}%` }} />
        ))}
      </span>
    )
  if (kind === 'line')
    return (
      <svg className={styles.ovSvg} viewBox="0 0 100 40" preserveAspectRatio="none">
        <path
          d="M0 20 Q 8 4 16 20 T 32 20 T 48 20 T 64 20 T 80 20 T 100 20"
          fill="none"
          stroke="white"
          strokeWidth="1.6"
        />
      </svg>
    )
  if (kind === 'ring')
    return (
      <svg className={styles.ovSvg} viewBox="0 0 100 56">
        <circle cx="50" cy="28" r="15" fill="none" stroke="white" strokeWidth="1.4" strokeDasharray="2 1.5" />
        <circle cx="50" cy="28" r="10" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
      </svg>
    )
  return null
}

export function VisualsTab() {
  return (
    <div className={`${styles.scroller} scroll`}>
      <div className={styles.groupLabel}>Visualizers</div>
      <div className={styles.tiles}>
        {visualizers.map((v) => (
          <button key={v.name} className={styles.tile} draggable>
            <span className={styles.tileArt} style={{ backgroundImage: `url(${sceneThumb(v.scene)})` }}>
              <VisualOverlay kind={v.overlay} />
              <span className={styles.reactive} title="Reacts to the music">
                <AudioWaveform />
              </span>
            </span>
            <span className={styles.tileName}>{v.name}</span>
          </button>
        ))}
      </div>
      <div className={styles.groupLabel}>Shader visuals</div>
      <div className={styles.tiles}>
        {shaders.map((s) => (
          <button key={s.name} className={styles.tile} draggable>
            <span className={styles.tileArt} style={{ background: s.gradient }}>
              <span className={styles.reactive} title="Reacts to the music">
                <AudioWaveform />
              </span>
            </span>
            <span className={styles.tileName}>{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
