import { useMemo, useState } from 'react'
import {
  AudioWaveform,
  Film,
  Image as ImageIcon,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  Type,
  Upload,
  Wand2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs.tsx'
import { SearchInput } from '../../ds/Fields.tsx'
import { Button, IconButton } from '../../ds/Button.tsx'
import { EmptyState, Spinner } from '../../ds/Feedback.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { formatBpm, formatTime, plural } from '../../format.ts'
import { sceneThumb, type SceneId } from '../../mock/art.ts'
import { mediaById } from '../../mock/media.ts'
import { peaks } from '../../mock/song.ts'
import type { Asset, Project } from '../../../model/index.ts'
import type { FootageResult } from '../../../vision/index.ts'
import { useFootage, useFootageResults } from '../../state/footage.ts'
import { addAsset, openImport } from '../../state/importer.ts'
import {
  bpmOf,
  hasSong,
  lyricLines,
  sectionName,
  sectionsOf,
  songAnalysis,
  timelineDuration,
  useProject,
} from '../../state/project.ts'
import { useThumbnail } from '../../state/thumbs.ts'
import { set, toast, useUi, type LibraryTab } from '../../state/ui.ts'
import styles from './Library.module.css'

const filters = ['All', 'Video', 'Images', 'Generated'] as const

interface LibraryItem {
  asset: Asset
  name: string
  type: 'video' | 'image' | 'generated' | 'audio'
  tags: string[]
}

/** The project's media for the library: everything but the song, masks and fonts, newest imports first. */
function libraryItems(project: Project): LibraryItem[] {
  return Object.values(project.assets)
    .filter((a) => a.id !== project.songAssetId && a.origin.type !== 'derived' && a.kind !== 'font')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((asset) => ({
      asset,
      name: asset.name.replace(/\.[^.]+$/, ''),
      type:
        asset.origin.type === 'generated'
          ? 'generated'
          : asset.kind === 'audio'
            ? 'audio'
            : asset.kind === 'image'
              ? 'image'
              : 'video',
      tags: mediaById[asset.id]?.tags ?? [],
    }))
}

function MediaCard({ item }: { item: LibraryItem }) {
  const thumb = useThumbnail(item.asset)
  const duration = item.type === 'image' ? undefined : item.asset.duration
  return (
    <div className={styles.card} draggable tabIndex={0} aria-label={`${item.name}, ${item.type}`}>
      <div className={styles.thumb} style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}>
        {item.type === 'audio' && (
          <span className={styles.thumbIcon}>
            <AudioWaveform />
          </span>
        )}
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
        {duration !== undefined && <span className={`${styles.duration} tnum`}>{formatTime(duration)}</span>}
        <span className={styles.addBtn}>
          <IconButton
            label="Add at playhead"
            size="xs"
            variant="secondary"
            tooltipSide="top"
            onClick={() => addAsset(item.asset.id)}
          >
            <Plus />
          </IconButton>
        </span>
      </div>
      <div className={styles.cardName}>{item.name}</div>
    </div>
  )
}

const WAVE_BARS = 40

/** Bar heights (0..1) for the song row: the analyzed loudness when available, else the mock peaks. */
function songBars(project: Project): number[] {
  const loudness = songAnalysis(project)?.features?.loudness
  const values = loudness?.length ? loudness : peaks
  const step = values.length / WAVE_BARS
  return Array.from({ length: WAVE_BARS }, (_, i) => {
    let m = 0
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, values[j] ?? 0)
    return m
  })
}

function SongRow() {
  const project = useProject()
  const asset = project.songAssetId ? project.assets[project.songAssetId] : undefined
  const analyzed = !!songAnalysis(project)
  const bpm = bpmOf(project)
  return (
    <div className={styles.songRow} tabIndex={0}>
      <span className={styles.songIcon}>
        <Music2 />
      </span>
      <span className={styles.songText}>
        <span className={styles.songName}>{asset?.name}</span>
        <span className={`${styles.songMeta} tnum`}>
          {analyzed ? (
            <>
              {formatTime(timelineDuration(project))} · {bpm ? `${formatBpm(bpm)} · ` : ''}
              {plural(sectionsOf(project).length, 'section')}
            </>
          ) : (
            <>
              <Spinner size={10} /> Finding beats and sections…
            </>
          )}
        </span>
      </span>
      <span className={styles.songWave} aria-hidden>
        {songBars(project).map((v, i) => (
          <i key={i} style={{ height: `${15 + v * 85}%` }} />
        ))}
      </span>
    </div>
  )
}

function AddSongRow() {
  return (
    <button className={styles.songRow} onClick={() => openImport('song')}>
      <span className={styles.songIcon}>
        <Upload />
      </span>
      <span className={styles.songText}>
        <span className={styles.songName}>Import a song</span>
        <span className={styles.songMeta}>Beats, sections and energy are found in a few seconds</span>
      </span>
    </button>
  )
}

function SuggestionThumb({
  asset,
  result,
  onUse,
}: {
  asset: Asset
  result: FootageResult
  onUse: () => void
}) {
  const thumb = useThumbnail(asset)
  const name = asset.name.replace(/\.[^.]+$/, '')
  return (
    <Tooltip
      label={name}
      description={
        asset.kind === 'video'
          ? `Best part ${formatTime(result.range.start)}–${formatTime(result.range.end)}`
          : undefined
      }
      side="top"
    >
      <button
        className={styles.suggestThumb}
        style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
        aria-label={`Use ${name}`}
        onClick={onUse}
      />
    </Tooltip>
  )
}

/** Clips that match the selected lyric line or section, from footage analysis; one click places the best part. */
function Suggestions() {
  const selection = useUi((s) => s.selection)
  const project = useProject()
  const strong = useFootage((s) => s.strongMatch)
  const target = selection.type === 'lyric' || selection.type === 'section' ? selection : null
  const results = useFootageResults(target?.type === 'section' ? 'section' : 'line', target?.id ?? null)
  if (!target) return null
  const line = target.type === 'lyric' ? lyricLines(project).find((l) => l.id === target.id) : undefined
  const section = target.type === 'section' ? sectionsOf(project).find((s) => s.id === target.id) : undefined
  const picks = (results ?? []).filter((r) => r.score >= strong && project.assets[r.assetId]).slice(0, 3)
  if (!picks.length) return null
  const label = line ? `“${line.text}”` : section ? sectionName(section) : 'this section'
  const place = (r: FootageResult) => {
    const lyric =
      line && Object.values(project.clips).find((c) => c.type === 'text' && c.lyricLineId === line.id)
    const best = r.range.end - r.range.start
    if (lyric)
      addAsset(r.assetId, { start: lyric.start, duration: lyric.duration, sourceStart: r.range.start })
    else if (section)
      addAsset(r.assetId, {
        start: section.start,
        duration: Math.min(section.end - section.start, Math.max(2, best)),
        sourceStart: r.range.start,
      })
  }
  return (
    <div className={styles.suggest}>
      <div className={styles.suggestHead}>
        <Sparkles />
        <span className={styles.suggestTitle}>Suggested for {label}</span>
      </div>
      <div className={styles.suggestRow}>
        {picks.map((r) => {
          const asset = project.assets[r.assetId]
          return asset ? (
            <SuggestionThumb key={r.assetId} asset={asset} result={r} onUse={() => place(r)} />
          ) : null
        })}
      </div>
    </div>
  )
}

function MediaTab() {
  const project = useProject()
  const all = useMemo(() => libraryItems(project), [project])
  const empty = !hasSong(project) && all.length === 0
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof filters)[number]>('All')
  const q = query.trim()
  const results = useFootageResults('search', q || null)
  const analyzing = useFootage((s) => s.indexing?.status === 'indexing')
  const items = useMemo(() => {
    const lower = q.toLowerCase()
    const shown = (m: LibraryItem) =>
      !(filter === 'Video' && m.type !== 'video') &&
      !(filter === 'Images' && m.type !== 'image') &&
      !(filter === 'Generated' && m.type !== 'generated')
    if (!lower) return all.filter(shown)
    const named = all.filter(
      (m) => m.name.toLowerCase().includes(lower) || m.tags.some((t) => t.includes(lower)),
    )
    // Clips that match the description come first, best first; name matches follow.
    const byId = new Map(all.map((m) => [m.asset.id, m]))
    const ranked = (results ?? []).flatMap((r) => byId.get(r.assetId) ?? [])
    return [...ranked, ...named.filter((m) => !ranked.includes(m))].filter(shown)
  }, [all, q, filter, results])

  if (empty) {
    return (
      <div className={styles.emptyWrap}>
        <EmptyState
          icon={<Upload />}
          title="Bring in your media"
          description="Drop a song, video clips or images anywhere, or import them. Files stay on this device."
          action={
            <Button variant="secondary" icon={<Plus />} onClick={() => openImport()}>
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
        <IconButton label="Import media" shortcut="Mod I" variant="secondary" onClick={() => openImport()}>
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
        {hasSong(project) ? <SongRow /> : <AddSongRow />}
        <div className={styles.groupLabel}>
          Clips and images <span className={styles.count}>{items.length}</span>
        </div>
        {items.length ? (
          <div className={styles.grid}>
            {items.map((m) => (
              <MediaCard key={m.asset.id} item={m} />
            ))}
          </div>
        ) : analyzing ? (
          <EmptyState compact title="Analyzing your footage…" description="Results appear as clips finish." />
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
      <TabsList
        ariaLabel="Library"
        trailing={
          <IconButton
            label="Collapse library"
            shortcut="Mod B"
            size="sm"
            onClick={() => set({ libraryOpen: false })}
          >
            <PanelLeftClose />
          </IconButton>
        }
      >
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

const railTabs: { value: LibraryTab; label: string; icon: ReactNode }[] = [
  { value: 'media', label: 'Media', icon: <Film /> },
  { value: 'text', label: 'Text', icon: <Type /> },
  { value: 'visuals', label: 'Visuals', icon: <AudioWaveform /> },
  { value: 'effects', label: 'Effects', icon: <Wand2 /> },
]

/** The collapsed library: a slim rail that gives the preview more room and reopens on any tab. */
export function LibraryRail() {
  const tab = useUi((s) => s.libraryTab)
  return (
    <nav className={styles.rail} aria-label="Library">
      <IconButton
        label="Expand library"
        shortcut="Mod B"
        tooltipSide="right"
        onClick={() => set({ libraryOpen: true })}
      >
        <PanelLeftOpen />
      </IconButton>
      <span className={styles.railDivider} />
      {railTabs.map((t) => (
        <IconButton
          key={t.value}
          label={t.label}
          tooltipSide="right"
          className={t.value === tab ? styles.railOn : undefined}
          onClick={() => set({ libraryOpen: true, libraryTab: t.value })}
        >
          {t.icon}
        </IconButton>
      ))}
    </nav>
  )
}
