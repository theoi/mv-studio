import { useMemo, useRef, useState } from 'react'
import { AudioWaveform, Image as ImageIcon, Music2, Plus, Sparkles, Trash2, Upload } from 'lucide-react'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { EmptyState, Spinner } from '../../../ds/Feedback.tsx'
import { SearchInput } from '../../../ds/Fields.tsx'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../../ds/Menu.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBpm, formatTime, plural } from '../../../format.ts'
import type { Asset, Project } from '../../../../model/index.ts'
import type { FootageResult } from '../../../../vision/index.ts'
import {
  clipTags,
  suggestionRowRef,
  useClipAnalyzing,
  useFootage,
  useFootageResults,
} from '../../../state/footage.ts'
import { addAsset, addAssetAtPlayhead, openImport } from '../../../state/importer.ts'
import { mediaRemoval, removeMedia } from '../../../state/library.ts'
import { endMediaDrag, startMediaDrag } from '../../../state/mediaDrag.ts'
import {
  bpmOf,
  hasSong,
  lyricLines,
  sectionName,
  sectionsOf,
  songAnalysis,
  timelineDuration,
  useProject,
} from '../../../state/project.ts'
import { analyzeAgain, SONG_STATE_TEXT } from '../../../state/songAnalysis.ts'
import { useThumbnail } from '../../../state/thumbs.ts'
import { focusedWithRing } from '../../../state/focusRing.ts'
import { useUi } from '../../../state/ui.ts'
import { useSongState } from '../assist/jobState.ts'
import styles from '../Library.module.css'

const filters = ['All', 'Video', 'Images', 'Generated'] as const

/** What a filter shows before there is anything to show. */
const noneYet: Record<(typeof filters)[number], { title: string; description: string }> = {
  All: { title: 'No clips or images yet', description: 'Drop clips and images, or Import.' },
  Video: { title: 'No video clips yet', description: 'Drop clips and images, or Import.' },
  Images: { title: 'No images yet', description: 'Drop clips and images, or Import.' },
  Generated: {
    title: 'Nothing generated yet',
    description: 'Images and clips you make in Assist › Generate appear here.',
  },
}

interface LibraryItem {
  asset: Asset
  name: string
  type: 'video' | 'image' | 'generated' | 'audio'
  tags: string[]
}

/** The project's media for the library: everything but the song, masks and fonts, newest imports first. */
function libraryItems(project: Project): LibraryItem[] {
  return Object.values(project.assets)
    .filter(
      (a) =>
        a.id !== project.songAssetId &&
        a.origin.type !== 'derived' &&
        a.origin.type !== 'stem' &&
        a.kind !== 'font',
    )
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
      tags: clipTags(project, asset.id),
    }))
}

const ANALYZING_NAMES = { analyzing: ', analyzing', waiting: ', waiting to be analyzed' } as const

/** The card's right-click menu, made when it opens so the counts are current. */
function MediaMenu({ asset, onRemove }: { asset: Asset; onRemove: () => void }) {
  const project = useProject()
  const playhead = useUi((s) => s.playhead)
  const removal = mediaRemoval(project, asset.id)
  return (
    <>
      <ContextMenuItem
        icon={<Plus />}
        description={`At ${formatTime(playhead, true)}`}
        onSelect={() => addAsset(asset.id)}
      >
        Add at playhead
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={<Trash2 />}
        danger
        disabled={'why' in removal}
        description={
          'why' in removal
            ? removal.why
            : removal.clips
              ? `Also removes ${plural(removal.clips, 'clip')} from the timeline`
              : undefined
        }
        onSelect={onRemove}
      >
        Remove from project
      </ContextMenuItem>
    </>
  )
}

function MediaCard({ item }: { item: LibraryItem }) {
  const thumb = useThumbnail(item.asset)
  const duration = item.type === 'image' ? undefined : item.asset.duration
  const analyzing = useClipAnalyzing(item.asset.id)
  const card = useRef<HTMLDivElement>(null)
  // The card is gone once its file is removed, so focus goes to the next card, else the previous one, else the panel.
  const focusAfterRemove = useRef<HTMLElement | null>(null)
  const remove = () => {
    const el = card.current
    const next = el?.nextElementSibling ?? el?.previousElementSibling ?? el?.closest('[role="tabpanel"]')
    if (removeMedia(item.asset.id) && next instanceof HTMLElement) focusAfterRemove.current = next
  }
  return (
    <ContextMenu>
      <Tooltip label={item.name} description={item.tags.length ? item.tags.join(' · ') : undefined}>
        <ContextMenuTrigger asChild>
          <div
            ref={card}
            className={styles.card}
            draggable
            role="button"
            tabIndex={0}
            aria-label={`${item.name}, ${item.type}${analyzing ? ANALYZING_NAMES[analyzing] : ''}`}
            aria-description="Adds it at the playhead"
            onDragStart={(e) => startMediaDrag(e, item.asset.id)}
            onDragEnd={endMediaDrag}
            // The second click of a double-click would add it again.
            onClick={(e) => {
              if (e.detail < 2) addAssetAtPlayhead(item.asset.id)
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              // Space adds only when the card was reached with the keyboard; after a click on it, Space plays or pauses.
              if (e.key !== 'Enter' && !(e.key === ' ' && focusedWithRing(e.currentTarget))) return
              e.preventDefault()
              e.stopPropagation()
              addAssetAtPlayhead(item.asset.id)
            }}
          >
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
              {duration !== undefined && (
                <span className={`${styles.duration} tnum`}>{formatTime(duration)}</span>
              )}
              {analyzing && (
                <span className={styles.analyzingMark} data-state={analyzing} aria-hidden>
                  {analyzing === 'analyzing' && <Spinner size={8} />}
                  <span className={styles.analyzingLabel}>
                    {analyzing === 'analyzing' ? 'Analyzing…' : 'Waiting'}
                  </span>
                </span>
              )}
              <span className={styles.addBtn}>
                <IconButton
                  label="Add at playhead"
                  size="xs"
                  variant="secondary"
                  tooltipSide="top"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (e.detail < 2) addAssetAtPlayhead(item.asset.id)
                  }}
                >
                  <Plus />
                </IconButton>
              </span>
            </div>
            <div className={styles.cardName}>{item.name}</div>
          </div>
        </ContextMenuTrigger>
      </Tooltip>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          const target = focusAfterRemove.current
          if (!target) return
          focusAfterRemove.current = null
          e.preventDefault()
          target.focus()
        }}
      >
        <MediaMenu asset={item.asset} onRemove={remove} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

const WAVE_BARS = 40

/** Bar heights (0..1) for the song row from the analyzed loudness; low and even until the song is analyzed. */
function songBars(project: Project): number[] {
  const loudness = songAnalysis(project)?.features?.loudness
  if (!loudness?.length) return Array.from({ length: WAVE_BARS }, () => 0.12)
  const values = loudness
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
  const state = useSongState()
  const bpm = bpmOf(project)
  const unanalyzed = state === 'not-analyzed' || state === 'failed'
  return (
    <div className={styles.songRow} tabIndex={0}>
      <span className={styles.songIcon}>
        <Music2 />
      </span>
      <span className={styles.songText}>
        <span className={styles.songName}>{asset?.name}</span>
        <span className={`${styles.songMeta} tnum`}>
          {state === 'analyzed' || state === 'no-beat' ? (
            <>
              {formatTime(timelineDuration(project))} · {bpm ? `${formatBpm(bpm)} · ` : ''}
              {plural(sectionsOf(project).length, 'section')}
            </>
          ) : state === 'analyzing' ? (
            <>
              <Spinner size={10} /> Finding beats and sections…
            </>
          ) : (
            SONG_STATE_TEXT[state]
          )}
        </span>
      </span>
      {unanalyzed ? (
        <Button size="sm" variant="secondary" onClick={() => void analyzeAgain()}>
          {state === 'failed' ? 'Try again' : 'Analyze'}
        </Button>
      ) : (
        <span className={styles.songWave} aria-hidden>
          {songBars(project).map((v, i) => (
            <i key={i} style={{ height: `${15 + v * 85}%` }} />
          ))}
        </span>
      )}
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
    <div className={styles.suggest} ref={suggestionRowRef}>
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

export function MediaTab() {
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
          description="Drop a song, clips and images anywhere, or Import. Files are kept in this browser."
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
          Clips and images {items.length > 0 && <span className={styles.count}>{items.length}</span>}
        </div>
        {items.length ? (
          <div className={styles.grid}>
            {items.map((m) => (
              <MediaCard key={m.asset.id} item={m} />
            ))}
          </div>
        ) : analyzing ? (
          <EmptyState compact title="Analyzing your footage…" description="Results appear as clips finish." />
        ) : !q ? (
          <EmptyState
            compact
            {...noneYet[filter]}
            action={
              filter !== 'Generated' && (
                <Button variant="secondary" icon={<Plus />} onClick={() => openImport()}>
                  Import
                </Button>
              )
            }
          />
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
