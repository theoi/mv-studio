import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, AudioLines, Check, Film, Music2, Sparkles, Upload, Info } from 'lucide-react'
import { Button } from '../../ds/Button.tsx'
import { TextArea } from '../../ds/Fields.tsx'
import { Badge, Spinner } from '../../ds/Feedback.tsx'
import { sceneThumb, type SceneId } from '../../mock/art.ts'
import { peaks, song } from '../../mock/song.ts'
import { useCloud } from '../../state/cloud.ts'
import { draftFromSetup } from '../../state/director.ts'
import { openEditor } from '../../state/project.ts'
import { set, useUi, type Kind } from '../../state/ui.ts'
import { Logo } from '../common/Logo.tsx'
import styles from './Start.module.css'

const titles: Record<Kind, { title: string; lede: string }> = {
  lyric: {
    title: 'Lyric video',
    lede: 'Add your song and lyrics. Words are timed to the vocals automatically.',
  },
  visualizer: {
    title: 'Visualizer',
    lede: 'Add your song and pick a starting style. Everything reacts to the music.',
  },
  footage: {
    title: 'Beat-cut footage',
    lede: 'Add your song and your clips. They are cut to the beat and the sections.',
  },
  ai: {
    title: 'AI music video',
    lede: 'Add your song and describe the video. Assist drafts every shot for you to edit.',
  },
  blank: { title: 'Blank project', lede: '' },
}

const visualStyles: { id: string; name: string; scene: SceneId }[] = [
  { id: 'spectrum', name: 'Spectrum', scene: 'neon' },
  { id: 'ring', name: 'Waveform ring', scene: 'tunnel' },
  { id: 'particles', name: 'Particles', scene: 'aurora' },
  { id: 'flow', name: 'Shader flow', scene: 'rain' },
]

function MiniWave() {
  const bars = 64
  const step = Math.floor(peaks.length / bars)
  return (
    <span className={styles.miniWave} aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} style={{ height: `${12 + peaks[i * step] * 88}%` }} />
      ))}
    </span>
  )
}

function SongCard() {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    const a = window.setTimeout(() => setPhase(1), 900)
    const b = window.setTimeout(() => setPhase(2), 2200)
    return () => {
      window.clearTimeout(a)
      window.clearTimeout(b)
    }
  }, [])
  return (
    <div className={styles.songCard}>
      <span className={styles.songIcon}>
        <Music2 />
      </span>
      <div className={styles.songInfo}>
        <div className={styles.songName}>
          {song.title} <span className={styles.songMeta}>· {song.file} · 3:24</span>
        </div>
        <div className={styles.songStatus}>
          {phase === 0 && (
            <>
              <Spinner size={12} /> Finding the beat…
            </>
          )}
          {phase >= 1 && (
            <Badge tone="success" icon={<Check />}>
              120 BPM
            </Badge>
          )}
          {phase === 1 && (
            <>
              <Spinner size={12} /> Finding sections…
            </>
          )}
          {phase === 2 && (
            <>
              <Badge tone="success" icon={<Check />}>
                9 sections
              </Badge>
              <Badge tone="success" icon={<Check />}>
                Chorus at 1:04
              </Badge>
            </>
          )}
        </div>
      </div>
      <MiniWave />
    </div>
  )
}

export function SetupScreen() {
  const kind = useUi((s) => s.kind)
  const hasSong = useUi((s) => s.setupSong)
  const [visual, setVisual] = useState('spectrum')
  const [idea, setIdea] = useState('')
  const falKey = useCloud().falKey
  const t = titles[kind]

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
      </header>
      <main className={[styles.main, styles.setupMain].join(' ')}>
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft />}
          className={styles.back}
          onClick={() => set({ screen: 'start' })}
        >
          All kinds
        </Button>
        <h1 className={styles.setupTitle}>{t.title}</h1>
        <p className={styles.subtitle}>{t.lede}</p>

        <div className={styles.step}>
          <div className={styles.stepLabel}>
            <span className={styles.stepNum}>1</span> Your song
          </div>
          {hasSong ? (
            <SongCard />
          ) : (
            <div className={styles.drop}>
              <span className={styles.dropIcon}>
                <Upload />
              </span>
              <div className={styles.dropTitle}>Drop your song here</div>
              <div className={styles.dropHint}>MP3, WAV, FLAC, M4A or OGG</div>
              <div className={styles.dropActions}>
                <Button variant="secondary" onClick={() => set({ setupSong: true })}>
                  Choose file
                </Button>
                <Button variant="ghost" icon={<AudioLines />} onClick={() => set({ setupSong: true })}>
                  Use a sample song
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className={styles.step}>
          <div className={styles.stepLabel}>
            <span className={styles.stepNum}>2</span>
            {kind === 'lyric' && 'Lyrics'}
            {kind === 'visualizer' && 'Starting style'}
            {kind === 'footage' && 'Your clips'}
            {kind === 'ai' && 'Your idea'}
            <span className={styles.optional}>Optional</span>
          </div>
          {kind === 'lyric' && (
            <>
              <TextArea
                placeholder={
                  'Paste the lyrics here, one line per line.\nNo lyrics handy? Assist can draft them from the vocals.'
                }
                rows={4}
                aria-label="Lyrics"
              />
            </>
          )}
          {kind === 'visualizer' && (
            <div className={styles.styles} role="radiogroup" aria-label="Starting style">
              {visualStyles.map((v) => (
                <button
                  key={v.id}
                  role="radio"
                  aria-checked={visual === v.id}
                  className={[styles.styleCard, visual === v.id && styles.styleOn].filter(Boolean).join(' ')}
                  onClick={() => setVisual(v.id)}
                >
                  <span
                    className={styles.styleThumb}
                    style={{ backgroundImage: `url(${sceneThumb(v.scene)})` }}
                  />
                  <span>{v.name}</span>
                </button>
              ))}
            </div>
          )}
          {kind === 'footage' && (
            <div className={[styles.drop, styles.dropSmall].join(' ')}>
              <Film className={styles.dropInline} />
              <span>Drop video clips and images, or</span>
              <Button variant="secondary" size="sm">
                Choose files
              </Button>
            </div>
          )}
          {kind === 'ai' && (
            <>
              <TextArea
                placeholder="Describe the video, for example: a dreamy night drive through a neon city, ending at sunrise"
                rows={3}
                aria-label="Describe your video"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
              />
              <div className={styles.note}>
                <Info />
                <span>
                  {falKey
                    ? 'With fal.ai connected, the draft adds AI shots. You see the price before anything is generated.'
                    : 'Drafts work on this device with your media. Connect fal.ai in Settings to generate new shots; the cost is shown before anything is generated.'}
                </span>
              </div>
            </>
          )}
        </div>

        <div className={styles.setupFooter}>
          <Button
            variant="primary"
            size="lg"
            iconEnd={kind === 'ai' ? <Sparkles /> : <ArrowRight />}
            disabled={!hasSong}
            onClick={() => {
              openEditor(kind)
              if (kind === 'ai') draftFromSetup(idea)
            }}
          >
            {kind === 'ai' ? 'Draft my video' : 'Open the editor'}
          </Button>
          <Button variant="ghost" onClick={() => openEditor(kind, true)}>
            Skip for now
          </Button>
        </div>
      </main>
    </div>
  )
}
