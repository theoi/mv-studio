import { useMemo, useState } from 'react'
import { Plus, Sparkles, Music2, Type, Image as ImageIcon, Upload, AudioWaveform } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs.tsx'
import { SearchInput } from '../../ds/Fields.tsx'
import { Button, IconButton } from '../../ds/Button.tsx'
import { EmptyState } from '../../ds/Feedback.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { formatTime } from '../../format.ts'
import { sceneThumb, type SceneId } from '../../mock/art.ts'
import { media, type MediaItem } from '../../mock/media.ts'
import { peaks } from '../../mock/song.ts'
import { bpmOf, hasSong, lyricLines, sectionsOf, timelineDuration, useProject } from '../../state/project.ts'
import { set, toast, useUi, type LibraryTab } from '../../state/ui.ts'
import styles from './Library.module.css'

const filters = ['All', 'Video', 'Images', 'Generated'] as const

function MediaCard({ item }: { item: MediaItem }) {
  return (
    <div className={styles.card} draggable tabIndex={0} aria-label={`${item.name}, ${item.type}`}>
      <div className={styles.thumb} style={{ backgroundImage: `url(${sceneThumb(item.scene)})` }}>
        {item.type === 'generated' && (
          <span className={styles.genBadge}>
            <Sparkles /> AI
          </span>
        )}
        {item.type === 'image' && (
          <span className={styles.duration}>
            <ImageIcon />
          </span>
        )}
        {item.duration && <span className={`${styles.duration} tnum`}>{formatTime(item.duration)}</span>}
        <span className={styles.addBtn}>
          <IconButton
            label="Add at playhead"
            size="xs"
            variant="secondary"
            tooltipSide="top"
            onClick={() => toast(`Added “${item.name}” at the playhead`)}
          >
            <Plus />
          </IconButton>
        </span>
      </div>
      <div className={styles.cardName}>{item.name}</div>
    </div>
  )
}

function SongRow() {
  const project = useProject()
  const bars = 40
  const step = Math.floor(peaks.length / bars)
  const name = project.songAssetId ? project.assets[project.songAssetId]?.name : undefined
  return (
    <div className={styles.songRow} tabIndex={0}>
      <span className={styles.songIcon}>
        <Music2 />
      </span>
      <span className={styles.songText}>
        <span className={styles.songName}>{name}</span>
        <span className={`${styles.songMeta} tnum`}>
          {formatTime(timelineDuration(project))} · {bpmOf(project)} BPM · {sectionsOf(project).length}{' '}
          sections
        </span>
      </span>
      <span className={styles.songWave} aria-hidden>
        {Array.from({ length: bars }, (_, i) => (
          <i key={i} style={{ height: `${15 + (peaks[i * step] ?? 0) * 85}%` }} />
        ))}
      </span>
    </div>
  )
}

function Suggestions() {
  const selection = useUi((s) => s.selection)
  const project = useProject()
  if (selection.type !== 'lyric' && selection.type !== 'section') return null
  const label =
    selection.type === 'lyric'
      ? `“${lyricLines(project).find((l) => l.id === selection.id)?.text ?? ''}”`
      : (sectionsOf(project).find((s) => s.id === selection.id)?.label ?? 'this section')
  const picks = media.filter((m) => ['m-city', 'm-neon', 'm-crowd'].includes(m.id))
  return (
    <div className={styles.suggest}>
      <div className={styles.suggestHead}>
        <Sparkles />
        <span className={styles.suggestTitle}>Suggested for {label}</span>
      </div>
      <div className={styles.suggestRow}>
        {picks.map((m) => (
          <Tooltip
            key={m.id}
            label={m.name}
            description={`Matches: ${m.tags.slice(0, 2).join(', ')}`}
            side="top"
          >
            <button
              className={styles.suggestThumb}
              style={{ backgroundImage: `url(${sceneThumb(m.scene)})` }}
              aria-label={`Use ${m.name}`}
            />
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

function MediaTab() {
  const empty = !hasSong(useProject())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof filters)[number]>('All')
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return media.filter((m) => {
      if (filter === 'Video' && m.type !== 'video') return false
      if (filter === 'Images' && m.type !== 'image') return false
      if (filter === 'Generated' && m.type !== 'generated') return false
      return !q || m.name.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q))
    })
  }, [query, filter])

  if (empty) {
    return (
      <div className={styles.emptyWrap}>
        <EmptyState
          icon={<Upload />}
          title="Bring in your media"
          description="Drop a song, video clips or images anywhere, or import them. Files stay on this device."
          action={
            <Button variant="secondary" icon={<Plus />}>
              Import
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <>
      <div className={styles.toolbar}>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search by content"
          ariaLabel="Search media by content"
        />
        <IconButton label="Import media" shortcut="Mod I" variant="secondary">
          <Plus />
        </IconButton>
      </div>
      <div className={styles.filters} role="tablist" aria-label="Filter media">
        {filters.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            className={[styles.chip, filter === f && styles.chipOn].filter(Boolean).join(' ')}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className={`${styles.scroller} scroll`}>
        <Suggestions />
        <div className={styles.groupLabel}>Song</div>
        <SongRow />
        <div className={styles.groupLabel}>
          Clips and images <span className={styles.count}>{items.length}</span>
        </div>
        {items.length ? (
          <div className={styles.grid}>
            {items.map((m) => (
              <MediaCard key={m.id} item={m} />
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            title="No matches"
            description="Try another word, like “night”, “crowd” or “calm”."
          />
        )}
      </div>
    </>
  )
}

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

function TextTab() {
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

function VisualsTab() {
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

function EffectsTab() {
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

export function Library() {
  const tab = useUi((s) => s.libraryTab)
  return (
    <Tabs value={tab} onValueChange={(v) => set({ libraryTab: v as LibraryTab })} className={styles.root}>
      <TabsList ariaLabel="Library">
        <TabsTrigger value="media">Media</TabsTrigger>
        <TabsTrigger value="text">Text</TabsTrigger>
        <TabsTrigger value="visuals">Visuals</TabsTrigger>
        <TabsTrigger value="effects">Effects</TabsTrigger>
      </TabsList>
      <TabsContent value="media" className={styles.content}>
        <MediaTab />
      </TabsContent>
      <TabsContent value="text" className={styles.content}>
        <TextTab />
      </TabsContent>
      <TabsContent value="visuals" className={styles.content}>
        <VisualsTab />
      </TabsContent>
      <TabsContent value="effects" className={styles.content}>
        <EffectsTab />
      </TabsContent>
    </Tabs>
  )
}
