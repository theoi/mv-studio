import { sceneThumb } from '../../../mock/art.ts'
import { media } from '../../../mock/media.ts'
import { ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

export function MatchView() {
  return (
    <ToolView title="Match footage" subtitle={`${media.length} clips tagged on this device`}>
      <p className={styles.lede}>
        Clips are tagged by what’s in them, their mood and motion. Search in Media, or use these picks.
      </p>
      {[
        { s: 'Chorus', picks: ['crowd', 'neon', 'dancer'] as const, why: 'energetic, crowd, motion' },
        { s: 'Verse', picks: ['portrait', 'city', 'rain'] as const, why: 'calm, close-up, night' },
        { s: 'Bridge', picks: ['aurora', 'sunset', 'ocean'] as const, why: 'dreamy, slow, wide' },
      ].map((g) => (
        <div key={g.s} className={styles.matchGroup}>
          <div className={styles.matchHead}>
            <span className={styles.toolTitle}>{g.s}</span>
            <span className={styles.muted}>{g.why}</span>
          </div>
          <div className={styles.matchRow}>
            {g.picks.map((p) => (
              <span
                key={p}
                className={styles.matchThumb}
                style={{ backgroundImage: `url(${sceneThumb(p)})` }}
              />
            ))}
          </div>
        </div>
      ))}
    </ToolView>
  )
}
