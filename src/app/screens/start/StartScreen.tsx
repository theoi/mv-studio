import { FileUp, Lock, Plus, Settings, ArrowRight, Sparkles, Clock } from 'lucide-react'
import { Button, IconButton } from '../../ds/Button.tsx'
import { sceneThumb } from '../../mock/art.ts'
import { openEditor } from '../../state/project.ts'
import { set, type Kind } from '../../state/ui.ts'
import { Logo } from '../common/Logo.tsx'
import styles from './Start.module.css'

const kinds: { id: Exclude<Kind, 'blank'>; title: string; description: string }[] = [
  {
    id: 'lyric',
    title: 'Lyric video',
    description: 'Words timed to the vocals, with karaoke and kinetic type.',
  },
  { id: 'visualizer', title: 'Visualizer', description: 'Visuals that move with the beat, bass and vocals.' },
  {
    id: 'footage',
    title: 'Beat-cut footage',
    description: 'Your clips, cut to the beat and the song’s sections.',
  },
  {
    id: 'ai',
    title: 'AI music video',
    description: 'A complete, editable draft from your song and an idea.',
  },
]

const recent = [
  { name: 'Neon Skyline', edited: 'Edited 2 hours ago', scene: 'city' as const, kind: 'Lyric video' },
  { name: 'Low Tide (visualizer)', edited: 'Edited yesterday', scene: 'ocean' as const, kind: 'Visualizer' },
  { name: 'Tour recap', edited: 'Edited Oct 24', scene: 'crowd' as const, kind: 'Beat-cut footage' },
]

export function KindArt({ kind }: { kind: Exclude<Kind, 'blank'> }) {
  if (kind === 'lyric') {
    return (
      <div className={styles.art} style={{ backgroundImage: `url(${sceneThumb('city')})` }}>
        <div className={styles.artShade} />
        <div className={styles.lyricArt}>
          <span className={styles.lyricSung}>Under the </span>
          <span className={styles.lyricActive}>neon</span>
          <span> skyline</span>
        </div>
      </div>
    )
  }
  if (kind === 'visualizer') {
    return (
      <div className={styles.art} style={{ backgroundImage: `url(${sceneThumb('neon')})` }}>
        <div className={styles.artShade} />
        <div className={styles.bars}>
          {Array.from({ length: 22 }, (_, i) => (
            <span
              key={i}
              style={{
                height: `${18 + Math.abs(Math.sin(i * 0.9) * 52) + (i % 3) * 6}%`,
                animationDelay: `${(i % 7) * -90}ms`,
              }}
            />
          ))}
        </div>
      </div>
    )
  }
  if (kind === 'footage') {
    const strip = ['crowd', 'portrait', 'tunnel', 'dancer'] as const
    return (
      <div className={[styles.art, styles.footageArt].join(' ')}>
        <div className={styles.strip}>
          {strip.map((s) => (
            <span key={s} style={{ backgroundImage: `url(${sceneThumb(s)})` }} />
          ))}
        </div>
        <div className={styles.beats}>
          {Array.from({ length: 16 }, (_, i) => (
            <i key={i} className={i % 4 === 0 ? styles.downbeat : undefined} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className={styles.art} style={{ backgroundImage: `url(${sceneThumb('aurora')})` }}>
      <div className={styles.artShade} />
      <div className={styles.prompt}>
        <Sparkles />
        <span>dreamy city under the aurora</span>
      </div>
    </div>
  )
}

export function StartScreen() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
        <div className={styles.headerActions}>
          <Button variant="ghost" icon={<FileUp />}>
            Open project file
          </Button>
          <IconButton
            label="Settings"
            shortcut="Mod ,"
            onClick={() => set({ dialog: 'settings', settingsPage: 'general' })}
          >
            <Settings />
          </IconButton>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.hero}>
          <h1 className={styles.title}>What are you making?</h1>
          <p className={styles.subtitle}>Pick a starting point. You can mix everything later.</p>
        </div>

        <div className={styles.kinds}>
          {kinds.map((k) => (
            <button
              key={k.id}
              className={styles.kind}
              onClick={() => set({ screen: 'setup', kind: k.id, setupSong: false })}
            >
              <KindArt kind={k.id} />
              <div className={styles.kindText}>
                <span className={styles.kindTitle}>{k.title}</span>
                <span className={styles.kindDesc}>{k.description}</span>
              </div>
            </button>
          ))}
        </div>

        <button className={styles.blank} onClick={() => openEditor('blank', true)}>
          <span className={styles.blankIcon}>
            <Plus />
          </span>
          <span className={styles.blankText}>
            <span className={styles.kindTitle}>Blank project</span>
            <span className={styles.kindDesc}>Start from an empty timeline</span>
          </span>
          <ArrowRight className={styles.blankArrow} />
        </button>

        <section className={styles.recent} aria-labelledby="recent-title">
          <h2 id="recent-title" className={styles.sectionTitle}>
            Recent projects
          </h2>
          <div className={styles.recentList}>
            {recent.map((r) => (
              <button key={r.name} className={styles.recentItem} onClick={() => openEditor('lyric')}>
                <span
                  className={styles.recentThumb}
                  style={{ backgroundImage: `url(${sceneThumb(r.scene)})` }}
                />
                <span className={styles.recentText}>
                  <span className={styles.recentName}>{r.name}</span>
                  <span className={styles.recentMeta}>
                    <Clock />
                    {r.edited}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <Lock />
        Everything runs in your browser. Your songs and footage never leave this device.
      </footer>
    </div>
  )
}
