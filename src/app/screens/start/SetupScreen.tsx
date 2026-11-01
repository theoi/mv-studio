import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  Film,
  Image as ImageIcon,
  Info,
  Lock,
  Music2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import type { AudioAnalysis } from '../../../model/index.ts'
import { VISUALIZER_STYLES } from '../../../plugins/templates.ts'
import { thumbnailUrl } from '../../../plugins/thumbnails.ts'
import { Button, IconButton } from '../../ds/Button.tsx'
import { TextArea } from '../../ds/Fields.tsx'
import { Badge, Spinner } from '../../ds/Feedback.tsx'
import { formatBpm, formatBytes, formatTime, plural } from '../../format.ts'
import { matchingDownloadBytes } from '../../state/autocut.ts'
import { useCloud } from '../../state/cloud.ts'
import { estimateLyrics, lyricsCost } from '../../state/lyrics.ts'
import { useProject } from '../../state/project.ts'
import {
  addFootage,
  chooseSampleSong,
  chooseSong,
  isAudioFile,
  openFromSetup,
  removeFootage,
  setSetup,
  setupAction,
  useSetup,
  type SetupAction,
  type SetupSong,
} from '../../state/setup.ts'
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

const WAVE_BARS = 64

/** The song's loudness as bars; flat until the song is analyzed. */
function MiniWave({ analysis }: { analysis: AudioAnalysis | undefined }) {
  const values = analysis?.features?.loudness
  const heights = useMemo(() => {
    if (!values?.length) return null
    const peak = values.reduce((a, v) => Math.max(a, v), 0) || 1
    return Array.from({ length: WAVE_BARS }, (_, i) => {
      const from = Math.floor((i * values.length) / WAVE_BARS)
      const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / WAVE_BARS))
      let max = 0
      for (let j = from; j < to; j++) max = Math.max(max, values[j] ?? 0)
      return max / peak
    })
  }, [values])
  return (
    <span
      className={[styles.miniWave, !heights && styles.miniWavePending].filter(Boolean).join(' ')}
      aria-hidden
    >
      {Array.from({ length: WAVE_BARS }, (_, i) => (
        <i key={i} style={{ height: `${12 + (heights?.[i] ?? 0.06) * 88}%` }} />
      ))}
    </span>
  )
}

function SongStatus({ song, analysis }: { song: SetupSong; analysis: AudioAnalysis | undefined }) {
  if (song.status === 'adding')
    return (
      <>
        <Spinner size={12} /> Adding the song to this browser…
      </>
    )
  if (song.analysis === 'failed')
    return (
      <span className={styles.songFailed}>
        Couldn’t find the beat. You can analyze it again in Assist › Song analysis.
      </span>
    )
  if (analysis) {
    const sections = analysis.sections ?? []
    // "Pre-chorus" comes first and is not the chorus.
    const chorus = sections.find((s) => /^chorus\b/i.test(s.label ?? ''))
    return (
      <>
        {analysis.tempo && analysis.tempo.bpm > 0 ? (
          <Badge tone="success" icon={<Check />}>
            {formatBpm(analysis.tempo.bpm)}
          </Badge>
        ) : (
          <Badge>No beat found</Badge>
        )}
        {sections.length > 0 && (
          <Badge tone="success" icon={<Check />}>
            {plural(sections.length, 'section')}
          </Badge>
        )}
        {chorus && (
          <Badge tone="success" icon={<Check />}>
            Chorus at {formatTime(chorus.start)}
          </Badge>
        )}
      </>
    )
  }
  return (
    <>
      <Spinner size={12} /> Finding the beat and sections…
    </>
  )
}

function SongCard({
  song,
  onReplace,
  takeFocus,
}: {
  song: SetupSong
  onReplace: () => void
  takeFocus: boolean
}) {
  const project = useProject()
  const analysis = song.asset ? project.analysis.audio[song.asset.id] : undefined
  const duration = song.asset?.duration
  const format = /\.([a-z0-9]+)$/i.exec(song.name)?.[1]?.toUpperCase()
  return (
    <div className={styles.songCard}>
      <span className={styles.songIcon}>
        <Music2 />
      </span>
      <div className={styles.songInfo}>
        <div className={styles.songName}>
          <span className={styles.songTitle} title={song.title}>
            {song.title}
          </span>
          <span className={styles.songMeta}>
            {format ? ` · ${format}` : ''}
            {duration ? ` · ${formatTime(duration)}` : ''}
          </span>
        </div>
        <div className={styles.songStatus} role="status">
          <SongStatus song={song} analysis={analysis} />
        </div>
      </div>
      <MiniWave analysis={analysis} />
      <Button variant="ghost" size="sm" onClick={onReplace} autoFocus={takeFocus}>
        Replace
      </Button>
    </div>
  )
}

const ACTION_LABELS: Record<SetupAction, string> = {
  draft: 'Draft my video',
  time: 'Time my lyrics',
  cut: 'Cut my clips',
  open: 'Open the editor',
}

/** What timing the lyrics or cutting the clips will do on this device, said before the button is pressed. */
function useActionCost(action: SetupAction, songKey: string): { text: string; detail?: string } | null {
  const key = `${action}:${songKey}`
  const [cost, setCost] = useState<{ key: string; text: string; detail?: string } | null>(null)
  useEffect(() => {
    if (action !== 'time' && action !== 'cut') return
    let live = true
    const load =
      action === 'time'
        ? estimateLyrics('time').then(lyricsCost)
        : matchingDownloadBytes().then((bytes) => ({
            text: `Runs on this device · free${bytes ? ` · ${formatBytes(bytes)} download, once` : ''}`,
          }))
    load.then(
      (c) => live && setCost({ key, ...c }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [action, key])
  return cost?.key === key ? cost : null
}

function filesOf(input: HTMLInputElement): File[] {
  const files = [...(input.files ?? [])]
  // Choosing the same file again should still fire a change.
  input.value = ''
  return files
}

/** The clips step: a drop zone and the clips added so far. */
function Clips({ dragging, onChoose }: { dragging: boolean; onChoose: () => void }) {
  const { footage, adding, footageError } = useSetup()
  return (
    <>
      <div
        className={[styles.drop, styles.dropSmall, dragging && styles.dropActive].filter(Boolean).join(' ')}
      >
        <Film className={styles.dropInline} />
        <span>Drop video clips and images, or</span>
        <Button variant="secondary" size="sm" onClick={onChoose}>
          Choose files
        </Button>
      </div>
      {(footage.length > 0 || adding > 0) && (
        <ul className={styles.clipList} aria-label="Your clips">
          {footage.map((a) => (
            <li key={a.id} className={styles.clipChip}>
              {a.kind === 'image' ? <ImageIcon /> : <Film />}
              <span className={styles.clipName} title={a.name}>
                {a.name}
              </span>
              <IconButton size="xs" label={`Remove ${a.name}`} onClick={() => removeFootage(a.id)}>
                <X />
              </IconButton>
            </li>
          ))}
          {adding > 0 && (
            <li className={styles.clipChip} role="status">
              <Spinner size={12} /> Adding {plural(adding, 'file')}…
            </li>
          )}
        </ul>
      )}
      {footageError && (
        <p className={styles.setupError} role="alert">
          {footageError}
        </p>
      )}
    </>
  )
}

/** Kinds whose setup takes clips. */
const takesClips = (kind: Kind) => kind === 'footage' || kind === 'ai'

export function SetupScreen() {
  const kind = useUi((s) => s.kind)
  const { song, songError, footage, adding, lyrics, idea, visualizerStyle } = useSetup()
  const falKey = useCloud().falKey
  const songInput = useRef<HTMLInputElement>(null)
  const clipInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [opening, setOpening] = useState(false)
  // Choosing a song from the buttons replaces them with the song card; focus follows to its Replace button.
  const [focusSong, setFocusSong] = useState(false)
  const t = titles[kind]
  const action = setupAction(kind, { lyrics, footage })
  const cost = useActionCost(
    song?.status === 'ready' ? action : 'open',
    `${song?.asset?.id ?? ''}:${song?.analysis ?? ''}`,
  )
  const onStyleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const n = VISUALIZER_STYLES.length
    const i = VISUALIZER_STYLES.findIndex((v) => v.id === visualizerStyle)
    const next = VISUALIZER_STYLES[(i + step + n) % n]
    if (!next) return
    setSetup({ visualizerStyle: next.id })
    e.currentTarget.querySelector<HTMLElement>(`[data-style="${next.id}"]`)?.focus()
  }

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }
  const onDrop = (e: DragEvent) => {
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    e.preventDefault()
    setDragging(false)
    setFocusSong(false)
    const audio = files.find(isAudioFile)
    const others = files.filter((f) => !isAudioFile(f))
    if (audio) void chooseSong(audio)
    if (takesClips(kind) && others.length) void addFootage(others)
    else if (!audio && others[0]) void chooseSong(others[0])
  }
  const open = async (withSong: boolean) => {
    setOpening(true)
    try {
      await openFromSetup(withSong)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className={styles.page} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className={styles.header}>
        <Logo />
      </header>
      <main className={[styles.main, styles.setupMain].join(' ')}>
        <input
          ref={songInput}
          type="file"
          accept="audio/*"
          hidden
          aria-label="Song file"
          onChange={(e) => {
            const file = filesOf(e.currentTarget)[0]
            if (file) void chooseSong(file)
          }}
        />
        <input
          ref={clipInput}
          type="file"
          accept="video/*,image/*"
          multiple
          hidden
          aria-label="Clip files"
          onChange={(e) => void addFootage(filesOf(e.currentTarget))}
        />
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
          {song ? (
            <SongCard
              song={song}
              takeFocus={focusSong}
              onReplace={() => {
                setFocusSong(true)
                songInput.current?.click()
              }}
            />
          ) : (
            <div className={[styles.drop, dragging && styles.dropActive].filter(Boolean).join(' ')}>
              <span className={styles.dropIcon}>
                <Upload />
              </span>
              <div className={styles.dropTitle}>Drop your song here</div>
              <div className={styles.dropHint}>MP3, WAV, FLAC, M4A or OGG</div>
              <div className={styles.dropActions}>
                <Button
                  variant="secondary"
                  autoFocus={focusSong}
                  onClick={() => {
                    setFocusSong(true)
                    songInput.current?.click()
                  }}
                >
                  Choose file
                </Button>
                <Button
                  variant="ghost"
                  icon={<AudioLines />}
                  onClick={() => {
                    setFocusSong(true)
                    void chooseSampleSong()
                  }}
                >
                  Use a sample song
                </Button>
              </div>
            </div>
          )}
          {songError && (
            <p className={styles.setupError} role="alert">
              {songError}
            </p>
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
                value={lyrics}
                onChange={(e) => setSetup({ lyrics: e.target.value })}
              />
              {song?.sample && !lyrics.trim() && (
                <div className={styles.note}>
                  <Info />
                  <span>The sample song comes with timed lyrics. Paste your own to use them instead.</span>
                </div>
              )}
            </>
          )}
          {kind === 'visualizer' && (
            <div
              className={styles.styles}
              role="radiogroup"
              aria-label="Starting style"
              onKeyDown={onStyleKey}
            >
              {VISUALIZER_STYLES.map((v) => {
                const thumb = thumbnailUrl('generator', v.visualizerId)
                return (
                  <button
                    key={v.id}
                    role="radio"
                    aria-checked={visualizerStyle === v.id}
                    tabIndex={visualizerStyle === v.id ? 0 : -1}
                    data-style={v.id}
                    className={[styles.styleCard, visualizerStyle === v.id && styles.styleOn]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setSetup({ visualizerStyle: v.id })}
                  >
                    <span
                      className={styles.styleThumb}
                      style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
                    />
                    <span>{v.name}</span>
                  </button>
                )
              })}
            </div>
          )}
          {kind === 'footage' && <Clips dragging={dragging} onChoose={() => clipInput.current?.click()} />}
          {kind === 'ai' && (
            <TextArea
              placeholder="Describe the video, for example: a dreamy night drive through a neon city, ending at sunrise"
              rows={3}
              aria-label="Describe your video"
              value={idea}
              onChange={(e) => setSetup({ idea: e.target.value })}
            />
          )}
        </div>

        {kind === 'ai' && (
          <div className={styles.step}>
            <div className={styles.stepLabel}>
              <span className={styles.stepNum}>3</span> Your clips
              <span className={styles.optional}>Optional</span>
            </div>
            <Clips dragging={dragging} onChoose={() => clipInput.current?.click()} />
            <div className={styles.note}>
              <Info />
              <span>
                {falKey
                  ? 'With fal.ai connected, the draft adds AI shots. You see the price before anything is generated.'
                  : 'Drafts work on this device with your clips. Connect fal.ai in Settings to generate new shots; the cost is shown before anything is generated.'}
              </span>
            </div>
          </div>
        )}

        <div className={styles.setupFooter}>
          <Button
            variant="primary"
            size="lg"
            iconEnd={action === 'draft' ? <Sparkles /> : <ArrowRight />}
            disabled={
              song?.status !== 'ready' ||
              opening ||
              (action === 'cut' && song.analysis === 'running') ||
              (takesClips(kind) && adding > 0)
            }
            onClick={() => void open(true)}
          >
            {ACTION_LABELS[action]}
          </Button>
          {/* With a song on the card, Skip would drop it; the main button already skips the optional step. */}
          {!song && (
            <Button variant="ghost" disabled={opening} onClick={() => void open(false)}>
              Skip for now
            </Button>
          )}
          {cost && (
            <span className={styles.setupCost} title={cost.detail}>
              <Lock /> {cost.text}
            </span>
          )}
        </div>
      </main>
    </div>
  )
}
