import { useMemo, useState } from 'react'
import { AudioWaveform, Image as ImageIcon, Music2, Plus, Sparkles, Upload } from 'lucide-react'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { EmptyState, Spinner } from '../../../ds/Feedback.tsx'
import { SearchInput } from '../../../ds/Fields.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBpm, formatTime, plural } from '../../../format.ts'
import { mediaById } from '../../../mock/media.ts'
import type { Asset, Project } from '../../../../model/index.ts'
import type { FootageResult } from '../../../../vision/index.ts'
import { useClipAnalyzing, useFootage, useFootageResults } from '../../../state/footage.ts'
import { addAsset, openImport } from '../../../state/importer.ts'
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
import { useThumbnail } from '../../../state/thumbs.ts'
import { useUi } from '../../../state/ui.ts'
import styles from '../Library.module.css'

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
      tags: mediaById[asset.id]?.tags ?? [],
    }))
}

function MediaCard({ item }: { item: LibraryItem }) {
  const thumb = useThumbnail(item.asset)
  const duration = item.type === 'image' ? undefined : item.asset.duration
  const analyzing = useClipAnalyzing(item.asset.id)
  return (
    <div
      className={styles.card}
      draggable
      tabIndex={0}
      aria-label={`${item.name}, ${item.type}${analyzing ? ', analyzing' : ''}`}
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
        {duration !== undefined && <span className={`${styles.duration} tnum`}>{formatTime(duration)}</span>}
        {analyzing && (
          <span className={styles.analyzingMark} aria-hidden>
            <Spinner size={8} />
            Analyzing…
          </span>
        )}
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
