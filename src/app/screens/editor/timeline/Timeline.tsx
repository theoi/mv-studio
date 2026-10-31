import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AudioWaveform,
  ChevronDown,
  Eye,
  EyeOff,
  Flag,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Music4,
  Palette,
  Plus,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Type,
  Upload,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type {
  Clip,
  FeatureSeries,
  LyricWord,
  Project,
  SongSection,
  StemName,
  Track,
} from '../../../../model/index.ts'
import { clipsOnTrack, STEM_NAMES } from '../../../../model/index.ts'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { Segmented, Slider } from '../../../ds/Fields.tsx'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '../../../ds/Menu.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBpm, formatTime, plural } from '../../../format.ts'
import { sceneThumb } from '../../../mock/art.ts'
import { JOB_KINDS, runningJobs, useJobs } from '../../../state/jobs.ts'
import {
  lineDeltaRange,
  lineTimingCommands,
  MOVE_LABEL,
  TIMING_LABEL,
  wordEdgeCommands,
  wordEdgeRange,
  type LineEdge,
  type WordEdge,
} from '../../../state/lyricEdits.ts'
import { lineTiming } from '../../../state/lyricTiming.ts'
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  hasClipboard,
  isSelectableClip,
  paste,
} from '../../../state/clipboard.ts'
import {
  bpmOf,
  dispatch,
  editor,
  hasSong,
  isLookClip,
  lyricLines,
  sectionColor,
  sectionKind,
  sectionGuess,
  sectionName,
  sectionsOf,
  sectionUnsure,
  songAnalysis,
  splitAtPlayhead,
  timelineDuration,
  useProject,
  viewOf,
  type ClipView,
} from '../../../state/project.ts'
import {
  get,
  openAssist,
  select,
  selectClips,
  selectedClipIds,
  set,
  toast,
  useUi,
} from '../../../state/ui.ts'
import {
  droppedLibraryItem,
  dropLibraryItem,
  isLibraryDrag,
  libraryDropHint,
} from '../../../state/library.ts'
import { revealSuggestions, useFootage, useFootageResults } from '../../../state/footage.ts'
import { templateState } from '../../../../plugins/templates.ts'
import { registerReveal } from '../../../state/reveal.ts'
import {
  separatedStems,
  songStemTrack,
  STEM_LABELS,
  stemBadgeText,
  stemMix,
  toggleStem,
  type StemMix,
} from '../../../state/stems.ts'
import { MAX_PPS, MIN_PPS, registerFit, zoomTo } from '../../../state/zoom.ts'
import { InlineSuggestion } from '../Suggestion.tsx'
import { energySampler } from './energy.ts'
import { LaneMenu } from './LaneMenu.tsx'
import { openLaneMenu } from './laneMenu.ts'
import styles from './Timeline.module.css'

const HEADER_W = 148
const RULER_H = 24
const SONG_H = 34

type LaneKind = 'video' | 'overlay' | 'lyrics' | 'look' | 'audio'

const laneHeight: Record<LaneKind, number> = { video: 42, overlay: 30, lyrics: 28, look: 22, audio: 46 }

/** The track lyric lines go on: the template's Lyrics track, or a track named Lyrics. */
function isLyricsTrack(p: Project, t: Track): boolean {
  return t.kind === 'visual' && (templateState(p)?.tracks.lyrics === t.id || t.name === 'Lyrics')
}

function laneKind(p: Project, t: Track): LaneKind {
  if (t.kind === 'audio') return 'audio'
  const clips = clipsOnTrack(p, t.id)
  if (!clips.length && isLyricsTrack(p, t)) return 'lyrics'
  if (clips.some((c) => c.type === 'video' || c.type === 'image')) return 'video'
  if (clips.length && clips.every((c) => c.type === 'text' && c.lyricLineId)) return 'lyrics'
  if (clips.length && clips.every(isLookClip)) return 'look'
  return clips.length ? 'overlay' : 'video'
}

/** Top and height of each track's row in the timeline content, below the ruler and the song lane. */
function trackRows(p: Project, empty: boolean): { trackId: string; top: number; height: number }[] {
  let top = RULER_H + (empty ? 0 : SONG_H)
  return p.tracks.map((t) => {
    const height = laneHeight[laneKind(p, t)]
    const row = { trackId: t.id, top, height }
    top += height
    return row
  })
}

/* ---------- viewport canvas: redraws only the visible slice on scroll and zoom ---------- */

type DrawFn = (ctx: CanvasRenderingContext2D, t0: number, pps: number, w: number, h: number) => void

function ViewportCanvas({ height, draw }: { height: number; draw: DrawFn }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const pps = useUi((s) => s.pxPerSec)
  useLayoutEffect(() => {
    const canvas = ref.current
    // Looked up through the DOM: a child's layout effect runs before the parent's ref is attached on mount.
    const scroller = canvas?.closest<HTMLElement>('[data-timeline-scroller]')
    const ctx = canvas?.getContext('2d')
    if (!canvas || !scroller || !ctx) return
    let frame = 0
    const paint = () => {
      const w = Math.max(1, scroller.clientWidth - HEADER_W)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(height * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${height}px`
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, height)
      draw(ctx, scroller.scrollLeft / pps, pps, w, height)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(paint)
    }
    paint()
    scroller.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', schedule)
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [pps, height, draw])
  return <canvas ref={ref} className={styles.vcanvas} aria-hidden />
}

function makeRuler(beat: number | null): DrawFn {
  return (ctx, t0, pps, w, h) => {
    const t1 = t0 + w / pps
    const labelStep = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 64) ?? 60
    ctx.font = '500 10px "Inter Variable", Inter, sans-serif'
    ctx.textBaseline = 'top'
    if (beat) {
      const dense = beat * pps >= 5
      const step = dense ? beat : beat * 4
      for (let b = Math.floor(t0 / step); b * step <= t1; b++) {
        const x = Math.round((b * step - t0) * pps) + 0.5
        const down = !dense || b % 4 === 0
        ctx.fillStyle = down ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.14)'
        ctx.fillRect(x, down ? h - 9 : h - 5, 1, down ? 9 : 5)
      }
    }
    for (let t = Math.floor(t0 / labelStep) * labelStep; t <= t1; t += labelStep) {
      const x = (t - t0) * pps
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.fillRect(Math.round(x) + 0.5, 0, 1, h - 12)
      ctx.fillStyle = '#7b7f88'
      ctx.fillText(formatTime(t), x + 4, 4)
    }
  }
}

/** A flat line where a song's waveform goes until its loudness is analyzed. */
function makeFlatWave(color: string): DrawFn {
  return (ctx, _t0, _pps, w, h) => {
    ctx.fillStyle = color
    ctx.fillRect(0, Math.round(h / 2) - 1, w, 2)
  }
}

/** Waveform envelope from analyzed loudness. */
function makeWave(color: string, scaleY: number, { values, rate }: FeatureSeries): DrawFn {
  return (ctx, t0, pps, w, h) => {
    const mid = h / 2
    ctx.fillStyle = color
    const perPx = Math.max(1, rate / pps)
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((t0 + x / pps) * rate)
      if (i0 >= values.length) break
      let m = 0
      for (let i = i0; i < i0 + perPx; i++) {
        const v = values[i] ?? 0
        if (v > m) m = v
      }
      const a = Math.max(1, m * (h - 6) * 0.5 * scaleY)
      ctx.fillRect(x, mid - a, 1, a * 2)
    }
  }
}

function makeEnergy(series: FeatureSeries | undefined): DrawFn {
  const at = energySampler(series)
  return (ctx, t0, pps, w, h) => {
    if (!series?.values.length) return
    // Each 2 px column averages at least its own time span, so every sample counts once when zoomed out.
    const pts: [number, number][] = []
    for (let x = 0; x <= w; x += 2) pts.push([x, h - 2 - at(t0 + x / pps, 2 / pps) * (h - 8)])
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (const [x, y] of pts) ctx.lineTo(x, y)
    ctx.lineTo(w, h)
    ctx.closePath()
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(255,255,255,0.16)')
    g.addColorStop(1, 'rgba(255,255,255,0.02)')
    ctx.fillStyle = g
    ctx.fill()
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.lineWidth = 1.25
    ctx.stroke()
  }
}

/* ---------- lyric chips ---------- */

const LABEL_PAD = 12
const WORD_GAP = 1
const labelWidths = new Map<string, number>()
let measureCtx: CanvasRenderingContext2D | null | undefined

/** Width of a label in the 11 px chip font, cached; falls back to an average glyph width before fonts load. */
function labelWidth(text: string): number {
  const hit = labelWidths.get(text)
  if (hit !== undefined) return hit
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 6.2
  measureCtx.font = '400 11px "Inter Variable", Inter, sans-serif'
  const w = measureCtx.measureText(text).width
  labelWidths.set(text, w)
  return w
}

/** Narrowest word that still shows as a word with edge handles on the selected line. */
const MIN_WORD_PX = 12

/**
 * A lyric line shows its words only where they fit whole. Zoomed in, each word sits at its sung time and its edges
 * are handles; the selected line keeps its words as handles while every word is at least MIN_WORD_PX wide, even
 * where a label no longer fits. Otherwise the whole line shows if it fits, and a too-narrow chip shows the rhythm of
 * its words as marks instead of cut-off text.
 */
function LyricChipContent({
  text,
  words,
  start,
  width,
  pps,
  selected,
  onWordEdge,
}: {
  text: string
  words: LyricWord[]
  start: number
  width: number
  pps: number
  selected: boolean
  onWordEdge: (e: React.PointerEvent, index: number, edge: WordEdge) => void
}) {
  const spans = words.map((wd) => ({
    text: wd.text,
    left: (wd.start - start) * pps,
    width: Math.max(2, (wd.end - wd.start) * pps - WORD_GAP),
  }))
  const wordsFit = spans.length > 0 && spans.every((s) => labelWidth(s.text) + 6 <= s.width)
  if (wordsFit || (selected && spans.length > 0 && spans.every((s) => s.width >= MIN_WORD_PX)))
    return spans.map((s, i) => (
      <span key={i} className={styles.word} style={{ left: s.left, width: s.width }}>
        {s.text}
        <i
          className={[styles.wordEdge, styles.wordEdgeL].join(' ')}
          onPointerDown={(e) => onWordEdge(e, i, 'start')}
        />
        <i
          className={[styles.wordEdge, styles.wordEdgeR].join(' ')}
          onPointerDown={(e) => onWordEdge(e, i, 'end')}
        />
      </span>
    ))
  if (labelWidth(text) + LABEL_PAD <= width) return <span className={styles.lyricText}>{text}</span>
  if (width < 8 || !spans.length) return null
  return (
    <span className={styles.lyricMarks} aria-hidden>
      {spans.map((s, i) => (
        <i key={i} style={{ left: s.left, width: s.width }} />
      ))}
    </span>
  )
}

type LyricDrag = { type: 'line'; edge: LineEdge } | { type: 'word'; index: number; edge: WordEdge }

/**
 * Where a suggestion `width` px wide sits in a lane without covering its clips (`spans`, px): the first gap from the
 * left of the view (`view`, px) that fits it inside the view, else just after the last clip.
 */
function freeSpot(spans: [number, number][], view: [number, number], width: number, gap = 8): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  let x = view[0] + gap
  for (const [a, b] of sorted) {
    if (b + gap <= x) continue
    if (a - gap >= x + width) break
    x = b + gap
  }
  if (x + width <= view[1] - gap) return x
  return sorted.reduce((end, s) => Math.max(end, s[1]), 0) + gap
}

/* ---------- toolbar ---------- */

// Memoized, like TrackHeader: a drag re-renders the timeline on every pointer move, and neither depends on the clips.
const Toolbar = memo(function Toolbar({ onFit, bpm }: { onFit: () => void; bpm?: number }) {
  const snap = useUi((s) => s.snap)
  const beatSnap = useUi((s) => s.beatSnap)
  const showEnergy = useUi((s) => s.showEnergy)
  const pps = useUi((s) => s.pxPerSec)
  const tool = useUi((s) => s.tool)
  const sliderVal = Math.round((Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 100)
  return (
    <div className={styles.toolbar}>
      <div className={styles.tbGroup}>
        <Segmented
          size="sm"
          value={tool}
          onChange={(v) => set({ tool: v })}
          ariaLabel="Timeline tool"
          options={[
            { value: 'select', label: <MousePointer2 />, title: 'Select (V)' },
            { value: 'split', label: <Scissors />, title: 'Split (S)' },
          ]}
        />
        <span className={styles.tbDivider} />
        <div className={styles.snapGroup}>
          <IconButton
            label={snap ? 'Snapping on' : 'Snapping off'}
            shortcut="N"
            size="sm"
            active={snap}
            onClick={() => set({ snap: !snap })}
          >
            <Magnet />
          </IconButton>
          <Menu>
            <MenuTrigger asChild>
              <button className={styles.snapMenu} aria-label="Snapping options">
                <ChevronDown />
              </button>
            </MenuTrigger>
            <MenuContent width={220}>
              <MenuLabel>Snap to</MenuLabel>
              <MenuCheckItem
                checked={beatSnap}
                onCheckedChange={(v) => set({ beatSnap: v })}
                shortcut="Shift N"
              >
                Beats
              </MenuCheckItem>
              <MenuCheckItem checked>Bar starts</MenuCheckItem>
              <MenuCheckItem checked>Sections</MenuCheckItem>
              <MenuCheckItem checked>Clip edges</MenuCheckItem>
              <MenuCheckItem checked>Playhead</MenuCheckItem>
            </MenuContent>
          </Menu>
        </div>
        <IconButton
          label="Add marker"
          shortcut="M"
          size="sm"
          onClick={() => toast(`Marker added at ${formatTime(get().playhead, true)}`)}
        >
          <Flag />
        </IconButton>
        {bpm !== undefined && (
          <Tooltip label="Detected tempo and meter" description="Adjust in Assist › Song analysis">
            <button className={`${styles.bpm} tnum`} onClick={() => openAssist('analysis')}>
              <Music4 />
              {formatBpm(bpm)} · 4/4
            </button>
          </Tooltip>
        )}
      </div>
      <div className={styles.tbGroup}>
        <Menu>
          <Tooltip label="View options">
            <MenuTrigger asChild>
              <button className={styles.viewBtn} aria-label="View options">
                <SlidersHorizontal />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end" width={220}>
            <MenuLabel>Show</MenuLabel>
            <MenuCheckItem checked={showEnergy} onCheckedChange={(v) => set({ showEnergy: v })}>
              Energy curve
            </MenuCheckItem>
            <MenuCheckItem checked={beatSnap} onCheckedChange={(v) => set({ beatSnap: v })}>
              Beat grid
            </MenuCheckItem>
            <MenuCheckItem checked>Clip thumbnails</MenuCheckItem>
            <MenuSeparator />
            <MenuCheckItem checked={false}>Large tracks</MenuCheckItem>
          </MenuContent>
        </Menu>
        <span className={styles.tbDivider} />
        <IconButton label="Zoom out" shortcut="Mod −" size="sm" onClick={() => zoomTo(pps / 1.4)}>
          <ZoomOut />
        </IconButton>
        <div className={styles.zoomSlider}>
          <Slider
            value={sliderVal}
            onChange={(v) => zoomTo(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100))}
            ariaLabel="Timeline zoom"
          />
        </div>
        <IconButton label="Zoom in" shortcut="Mod +" size="sm" onClick={() => zoomTo(pps * 1.4)}>
          <ZoomIn />
        </IconButton>
        <Tooltip label="Fit the whole song" shortcut="Shift Z">
          <Button size="sm" variant="ghost" onClick={onFit}>
            Fit
          </Button>
        </Tooltip>
      </div>
    </div>
  )
})

/* ---------- clips ---------- */

type DragMode = 'move' | 'start' | 'end'

function snapTime(t: number, pps: number, edges: number[], beat: number | null, sectionStarts: number[]) {
  const s = get()
  if (!s.snap) return { t, snapped: null as number | null }
  const cands = [...edges, s.playhead, ...sectionStarts]
  if (s.beatSnap && beat) cands.push(Math.round(t / beat) * beat)
  let best = t
  let bestD = 8 / pps
  let snapped: number | null = null
  for (const c of cands) {
    const d = Math.abs(c - t)
    if (d < bestD) {
      bestD = d
      best = c
      snapped = c
    }
  }
  return { t: best, snapped }
}

interface ClipBlockProps {
  clip: ClipView
  pps: number
  selected: boolean
  onPointerDown: (e: React.PointerEvent, clip: ClipView, mode: DragMode) => void
}

const sameView = (a: ClipView, b: ClipView) =>
  (Object.keys(a) as (keyof ClipView)[]).every((k) => a[k] === b[k]) &&
  Object.keys(a).length === Object.keys(b).length

/** Shift or Mod click (or Enter or Space): adds the clip to the selection or takes it out. */
function toggleInSelection(clipId: string) {
  const picked = selectedClipIds(get().selection)
  selectClips(picked.includes(clipId) ? picked.filter((id) => id !== clipId) : [...picked, clipId])
}

/** Re-renders only when its clip, zoom or selection changes: an edit to one clip leaves the others alone. */
const ClipBlock = memo(
  ClipBlockView,
  (a, b) =>
    a.selected === b.selected &&
    a.pps === b.pps &&
    a.onPointerDown === b.onPointerDown &&
    sameView(a.clip, b.clip),
)

function ClipBlockView({ clip, pps, selected, onPointerDown }: ClipBlockProps) {
  const [canPaste, setCanPaste] = useState(false)
  const width = Math.max(2, (clip.end - clip.start) * pps)
  const isMedia = clip.kind === 'video' || clip.kind === 'image'
  const showLabel = width > 54
  const label =
    clip.kind === 'look' && clip.amount !== undefined
      ? `${clip.name} · ${Math.round(clip.amount * 100)}%`
      : clip.name
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) return
        // The menu acts on the selection, so a clip outside it becomes the selection.
        if (!selectedClipIds(get().selection).includes(clip.id)) select({ type: 'clip', id: clip.id })
        setCanPaste(hasClipboard())
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          className={[styles.clip, styles[`clip-${clip.kind}`], selected && styles.selected]
            .filter(Boolean)
            .join(' ')}
          style={{
            left: clip.start * pps,
            width,
            backgroundImage: isMedia && clip.scene ? `url(${sceneThumb(clip.scene, 160, 90)})` : undefined,
          }}
          role="button"
          tabIndex={0}
          aria-label={`${label}, ${formatTime(clip.start, true)} to ${formatTime(clip.end, true)}`}
          aria-pressed={selected}
          aria-keyshortcuts="Enter Shift+Enter"
          // Enter selects and Shift Enter adds to the selection; Space plays or pauses, as in other editors, even
          // with the clip focused from the keyboard.
          data-space-plays
          onPointerDown={(e) => onPointerDown(e, clip, 'move')}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            if (e.shiftKey || e.metaKey || e.ctrlKey) toggleInSelection(clip.id)
            else select({ type: 'clip', id: clip.id })
          }}
        >
          {!isMedia && (
            <span className={styles.clipLabel}>
              {clip.kind === 'text' ? <Type /> : clip.kind === 'look' ? <Palette /> : <AudioWaveform />}
              {showLabel && label}
            </span>
          )}
          {isMedia && showLabel && <span className={styles.mediaLabel}>{clip.name}</span>}
          {selected && isMedia && width > 40 && (
            <span className={styles.keyframes} aria-hidden>
              <i style={{ left: 6 }} />
              <i style={{ left: width - 14 }} />
            </span>
          )}
          <span
            className={[styles.handle, styles.handleL].join(' ')}
            onPointerDown={(e) => {
              e.stopPropagation()
              onPointerDown(e, clip, 'start')
            }}
          />
          <span
            className={[styles.handle, styles.handleR].join(' ')}
            onPointerDown={(e) => {
              e.stopPropagation()
              onPointerDown(e, clip, 'end')
            }}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem shortcut="S" onSelect={() => splitAtPlayhead(clip.id)}>
          Split at playhead
        </ContextMenuItem>
        <ContextMenuItem shortcut="Mod D" onSelect={duplicateSelection}>
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem shortcut="Mod C" onSelect={copySelection}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem shortcut="Mod X" onSelect={cutSelection}>
          Cut
        </ContextMenuItem>
        <ContextMenuItem shortcut="Mod V" disabled={!canPaste} onSelect={paste}>
          Paste
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openAssist('behind')}>Put text behind subject…</ContextMenuItem>
        <ContextMenuItem onSelect={() => openAssist('match')}>Find similar clips…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger shortcut="Delete" onSelect={deleteSelection}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/* ---------- headers ---------- */

const TrackHeader = memo(function TrackHeader({
  track,
  height,
  stems,
}: {
  track: Track
  height: number
  stems?: StemMix | null
}) {
  const toggle = (key: 'muted' | 'solo' | 'locked' | 'hidden') =>
    dispatch({ type: 'track.update', trackId: track.id, patch: { [key]: !track[key] } })
  const isAudio = track.kind === 'audio'
  const badge = stems && stemBadgeText(stems)
  return (
    <div className={styles.trackHeader} style={{ height }}>
      <span
        className={styles.trackName}
        onPointerEnter={(e) => {
          // Names cut off by the narrow header get their full text as a tooltip.
          const el = e.currentTarget
          el.title = el.scrollWidth > el.clientWidth ? track.name : ''
        }}
      >
        {track.name}
      </span>
      <span className={styles.trackIcons}>
        {isAudio ? (
          <>
            <IconButton
              label={track.muted ? 'Unmute' : 'Mute'}
              size="xs"
              active={track.muted}
              onClick={() => toggle('muted')}
              tooltipSide="top"
            >
              {track.muted ? <VolumeX /> : <Volume2 />}
            </IconButton>
            <Tooltip label="Solo" side="top">
              <button
                className={[styles.solo, track.solo && styles.soloOn].filter(Boolean).join(' ')}
                aria-label="Solo"
                aria-pressed={track.solo}
                onClick={() => toggle('solo')}
              >
                S
              </button>
            </Tooltip>
          </>
        ) : (
          <IconButton
            label={track.hidden ? 'Show track' : 'Hide track'}
            size="xs"
            active={track.hidden}
            onClick={() => toggle('hidden')}
            tooltipSide="top"
          >
            {track.hidden ? <EyeOff /> : <Eye />}
          </IconButton>
        )}
        <IconButton
          label={track.locked ? 'Unlock track' : 'Lock track'}
          size="xs"
          active={track.locked}
          onClick={() => toggle('locked')}
          tooltipSide="top"
        >
          {track.locked ? <Lock /> : <LockOpen />}
        </IconButton>
      </span>
      {stems && badge && (
        <span
          className={[styles.stemBadge, stems.solo.length > 0 && styles.stemBadgeSolo]
            .filter(Boolean)
            .join(' ')}
          title={badge}
        >
          {badge}
        </span>
      )}
    </div>
  )
})

/** A stem lane's header under the song track: mute and solo for that stem of the song. */
function StemHeader({ name, track }: { name: StemName; track: Track | undefined }) {
  const label = STEM_LABELS[name]
  const flags = track?.stems?.[name]
  const lower = label.toLowerCase()
  return (
    <div className={[styles.header, styles.stemHeader].join(' ')}>
      <span className={styles.stemName}>{label}</span>
      {track && (
        <span className={styles.trackIcons}>
          <IconButton
            label={flags?.muted ? `Unmute ${lower}` : `Mute ${lower}`}
            size="xs"
            active={!!flags?.muted}
            onClick={() => toggleStem(name, 'muted')}
            tooltipSide="top"
          >
            {flags?.muted ? <VolumeX /> : <Volume2 />}
          </IconButton>
          <Tooltip label={`Solo ${lower}`} side="top">
            <button
              className={[styles.solo, flags?.solo && styles.soloOn].filter(Boolean).join(' ')}
              aria-label={`Solo ${lower}`}
              aria-pressed={!!flags?.solo}
              onClick={() => toggleStem(name, 'solo')}
            >
              S
            </button>
          </Tooltip>
        </span>
      )}
    </div>
  )
}

/** The song's separated stems as lanes under the song track, each drawing that stem's loudness. */
function StemLanes({
  project,
  names,
  track,
  mix,
  height,
  width,
  clipWidth,
}: {
  project: Project
  names: StemName[]
  track: Track | undefined
  mix: StemMix | null
  height: number
  width: number
  clipWidth: number
}) {
  const features = songAnalysis(project)?.stemFeatures
  // Only measured loudness is drawn: a stem without features (separated by an older version) gets an empty clip.
  const draws = useMemo(
    () =>
      STEM_NAMES.map((name) => {
        const f = features?.[name]
        return f?.loudness.length ? makeWave('#56658a', 0.9, { rate: f.rate, values: f.loudness }) : undefined
      }),
    [features],
  )
  return names.map((name) => {
    const silent = !!mix && (mix.muted.includes(name) || (mix.solo.length > 0 && !mix.solo.includes(name)))
    const draw = draws[STEM_NAMES.indexOf(name)]
    return (
      <div
        key={name}
        className={[styles.row, silent && styles.rowHidden].filter(Boolean).join(' ')}
        style={{ height }}
        data-stem={name}
      >
        <StemHeader name={name} track={track} />
        <div className={styles.lane} style={{ width }}>
          <div className={styles.stemClip} style={{ width: clipWidth }}>
            {draw && <ViewportCanvas height={height - 4} draw={draw} />}
          </div>
        </div>
      </div>
    )
  })
}

/* ---------- playhead ---------- */

/** "3 clips match this line": shown on the selected lyric when footage analysis finds strong matches. */
function LineMatches({ lineId }: { lineId: string }) {
  const strong = useFootage((s) => s.strongMatch)
  const count = (useFootageResults('line', lineId) ?? []).filter((r) => r.score >= strong).length
  if (!count) return null
  return (
    <div className={styles.lyricSuggest}>
      <InlineSuggestion
        id={`match-${lineId}`}
        variant="chip"
        action="Show"
        onAction={() => {
          revealSuggestions()
          set({ libraryTab: 'media', libraryOpen: true })
        }}
      >
        {count === 1 ? '1 clip matches this line' : `${count} clips match this line`}
      </InlineSuggestion>
    </div>
  )
}

/**
 * The one suggestion under a selected section: "N clips match this chorus" when footage analysis finds two or more
 * strong matches, else "Re-cut this chorus to the beat". Dismissing either quiets the section.
 */
function SectionSuggestion({ section }: { section: SongSection }) {
  const strong = useFootage((s) => s.strongMatch)
  const count = (useFootageResults('section', section.id) ?? []).filter((r) => r.score >= strong).length
  const matchId = `match-${section.id}`
  const cutId = `cut-${section.id}`
  const quiet = useUi((s) => s.dismissed.includes(matchId) || s.dismissed.includes(cutId))
  if (quiet) return null
  // "this verse", not "this verse 1".
  const label = section.label.replace(/\s*\d+$/, '').toLowerCase()
  return (
    <div className={styles.sectionSuggest}>
      {count >= 2 ? (
        <InlineSuggestion
          id={matchId}
          variant="chip"
          action="Show"
          onAction={() => {
            revealSuggestions()
            set({ libraryTab: 'media', libraryOpen: true })
          }}
        >
          {count} clips match this {label}
        </InlineSuggestion>
      ) : (
        <InlineSuggestion
          id={cutId}
          variant="chip"
          action="Cut clips to it"
          onAction={() => openAssist('autocut')}
        >
          Re-cut this {label} to the beat
        </InlineSuggestion>
      )}
    </div>
  )
}
function Playhead({ height, head }: { height?: number; head?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const apply = () => {
      const { playhead, pxPerSec } = get()
      if (ref.current)
        ref.current.style.transform = `translateX(${(head ? 0 : HEADER_W) + playhead * pxPerSec}px)`
    }
    apply()
    return useUi.subscribe((s, p) => {
      if (s.playhead !== p.playhead || s.pxPerSec !== p.pxPerSec) apply()
    })
  }, [head])
  return (
    <div
      ref={ref}
      className={head ? styles.playheadHeadWrap : styles.playhead}
      style={{ height }}
      aria-hidden
    >
      {head && <span className={styles.playheadHead} />}
    </div>
  )
}

/* ---------- timeline ---------- */

export function Timeline() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<HTMLDivElement>(null)
  const project = useProject()
  const pps = useUi((s) => s.pxPerSec)
  const selection = useUi((s) => s.selection)
  const selIds = useMemo(() => new Set(selectedClipIds(selection)), [selection])
  const showEnergy = useUi((s) => s.showEnergy)
  const beatSnap = useUi((s) => s.beatSnap)
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const [view, setView] = useState({ t0: 0, t1: 120 })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<ReturnType<typeof libraryDropHint>>(null)

  const empty = !hasSong(project)
  const analysis = songAnalysis(project)
  const bpm = bpmOf(project)
  const beat = bpm ? 60 / bpm : null
  const sections = sectionsOf(project)
  const lines = lyricLines(project)
  const duration = empty ? 90 : timelineDuration(project)
  const contentW = duration * pps + 120
  const stems = separatedStems(project)
  const stemTrack = songStemTrack(project)
  const mix = stemMix(project)
  const timingLyrics = runningJobs(useJobs()).some((j) => j.kind === JOB_KINDS.lyrics)

  const lanes = project.tracks.map((t) => {
    const kind = laneKind(project, t)
    return { track: t, kind, height: laneHeight[kind] }
  })
  const stemH = 24
  // Untimed lines have no clip yet, so the suggestion to time them sits in the Lyrics track itself.
  const untimed = lines.filter((l) => l.text.trim() && lineTiming(l) === 'untimed').length
  const lyricsTrackId =
    lanes.find((l) => l.kind === 'lyrics')?.track.id ??
    project.tracks.find((t) => isLyricsTrack(project, t))?.id
  // Assist › Lyrics already offers the same action while it is open.
  const lyricsOpen = useUi((s) => s.rightTab === 'assist' && s.assistView === 'lyrics')
  const suggestTiming = untimed > 0 && !empty && !timingLyrics && !lyricsOpen
  const [suggestW, setSuggestW] = useState(320)
  const measureSuggest = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ro = new ResizeObserver(() => setSuggestW(el.offsetWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const suggestLeft =
    suggestTiming && lyricsTrackId
      ? freeSpot(
          clipsOnTrack(project, lyricsTrackId).map((c): [number, number] => [
            c.start * pps,
            (c.start + c.duration) * pps,
          ]),
          [Math.max(0, view.t0) * pps, view.t1 * pps - HEADER_W],
          suggestW,
        )
      : 0
  const lanesH = lanes.reduce((a, l) => a + l.height, 0) + stems.length * stemH
  const totalH = RULER_H + (empty ? 0 : SONG_H) + lanesH

  const ruler = useMemo(() => makeRuler(beat), [beat])
  const energyDraw = useMemo(() => makeEnergy(analysis?.energy), [analysis?.energy])
  const features = analysis?.features
  const songWave = useMemo(
    () =>
      features?.loudness.length
        ? makeWave('#7f91b3', 1, { rate: features.rate, values: features.loudness })
        : makeFlatWave('#7f91b3'),
    [features],
  )
  // Directly under the song's track, so each stem's mute and solo sit by the song.
  const stemLanes = stems.length > 0 && (
    <StemLanes
      project={project}
      names={stems}
      track={stemTrack}
      mix={mix}
      height={stemH}
      width={contentW}
      clipWidth={duration * pps}
    />
  )

  const updateView = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const t0 = el.scrollLeft / get().pxPerSec
    const t1 = t0 + el.clientWidth / get().pxPerSec
    setView((v) => (Math.abs(v.t0 - t0) > 1 || Math.abs(v.t1 - t1) > 1 ? { t0, t1 } : v))
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let f = 0
    const onScroll = () => {
      cancelAnimationFrame(f)
      f = requestAnimationFrame(updateView)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    f = requestAnimationFrame(updateView)
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(f)
    }
  }, [updateView, pps])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, get().playhead * get().pxPerSec - el.clientWidth * 0.35)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const px = e.clientX - rect.left - HEADER_W
        const { pxPerSec } = get()
        const tAt = (el.scrollLeft + px) / pxPerSec
        const next = Math.min(MAX_PPS, Math.max(MIN_PPS, pxPerSec * Math.exp(-e.deltaY * 0.0025)))
        set({ pxPerSec: next })
        requestAnimationFrame(() => {
          el.scrollLeft = tAt * next - px
        })
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(
    () =>
      useUi.subscribe((s, p) => {
        if (!s.playing || s.playhead === p.playhead) return
        const el = scrollRef.current
        if (!el) return
        const x = s.playhead * s.pxPerSec
        const visW = el.clientWidth - HEADER_W
        if (x > el.scrollLeft + visW - 60 || x < el.scrollLeft) el.scrollLeft = x - visW * 0.2
      }),
    [],
  )

  const fit = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    set({ pxPerSec: Math.max(MIN_PPS, (el.clientWidth - HEADER_W - 24) / duration) })
    requestAnimationFrame(() => (el.scrollLeft = 0))
  }, [duration])

  // Pasted or duplicated clips can land off screen, or on a new track that pushes them down.
  useEffect(
    () =>
      registerReveal((ids) =>
        requestAnimationFrame(() => {
          const el = scrollRef.current
          const p = editor.getProject()
          const clips = ids.flatMap((id) => (p.clips[id] ? [p.clips[id]] : []))
          if (!el || !clips.length) return
          const rows = new Map(trackRows(p, !hasSong(p)).map((r) => [r.trackId, r]))
          const spans = clips.flatMap((c) => {
            const row = rows.get(c.trackId)
            return row ? [row] : []
          })
          const pps = get().pxPerSec
          const x0 = Math.min(...clips.map((c) => c.start)) * pps
          const x1 = Math.max(...clips.map((c) => c.start + c.duration)) * pps
          const visW = el.clientWidth - HEADER_W
          if (x0 < el.scrollLeft || x1 > el.scrollLeft + visW)
            el.scrollLeft = Math.max(0, x0 - Math.max(24, (visW - (x1 - x0)) / 2))
          if (!spans.length) return
          const top = Math.min(...spans.map((r) => r.top))
          const bottom = Math.max(...spans.map((r) => r.top + r.height))
          // The ruler row stays at the top while scrolling, over the first RULER_H pixels.
          if (top < el.scrollTop + RULER_H) el.scrollTop = top - RULER_H
          else if (bottom > el.scrollTop + el.clientHeight)
            el.scrollTop = Math.min(top - RULER_H, bottom - el.clientHeight)
        }),
      ),
    [],
  )
  useEffect(() => registerFit(fit), [fit])

  const scrubFrom = (e: React.PointerEvent<HTMLDivElement>) => {
    const lane = e.currentTarget
    const rect = lane.getBoundingClientRect()
    const toT = (cx: number) => Math.min(duration, Math.max(0, (cx - rect.left) / get().pxPerSec))
    set({ playhead: toT(e.clientX), playing: false })
    lane.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => set({ playhead: toT(ev.clientX) })
    const up = () => {
      lane.removeEventListener('pointermove', move)
      lane.removeEventListener('pointerup', up)
    }
    lane.addEventListener('pointermove', move)
    lane.addEventListener('pointerup', up)
  }

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: ClipView, mode: DragMode) => {
      if (e.button !== 0) return
      e.preventDefault()
      const picked = selectedClipIds(get().selection)
      if (mode === 'move' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        toggleInSelection(clip.id)
        return
      }
      // Dragging a clip of a multi-selection moves them all; trimming acts on one clip.
      const group = mode === 'move' && picked.length > 1 && picked.includes(clip.id)
      if (!group) select({ type: 'clip', id: clip.id })
      const p = editor.getProject()
      const self = p.clips[clip.id]
      if (!self) return
      const moving = (group ? picked : [clip.id]).flatMap((id) => {
        const c = p.clips[id]
        return c ? [c] : []
      })
      const locked = p.tracks.find((t) => t.locked && moving.some((c) => c.trackId === t.id))
      if (locked) {
        toast(`The ${locked.name} track is locked. Unlock it to edit.`)
        return
      }
      const movingIds = new Set(moving.map((c) => c.id))
      const bounds = (c: Clip) => {
        const others = clipsOnTrack(p, c.trackId).filter((o) => !movingIds.has(o.id))
        const end = c.start + c.duration
        return {
          min: others
            .filter((o) => o.start + o.duration <= c.start + 0.001)
            .reduce((a, o) => Math.max(a, o.start + o.duration), 0),
          max: others.filter((o) => o.start >= end - 0.001).reduce((a, o) => Math.min(a, o.start), duration),
        }
      }
      const { min, max } = bounds(self)
      // How far the whole selection can move before one of its clips meets a clip that stays.
      let minShift = -Infinity
      let maxShift = Infinity
      for (const c of moving) {
        const b = bounds(c)
        minShift = Math.max(minShift, b.min - c.start)
        maxShift = Math.min(maxShift, b.max - (c.start + c.duration))
      }
      const same = clipsOnTrack(p, clip.trackId).filter((c) => !movingIds.has(c.id))
      const edges = same.flatMap((c) => [c.start, c.start + c.duration])
      const sectionStarts = sectionsOf(p).map((s) => s.start)
      const key = `drag:${e.pointerId}:${clip.id}:${Date.now()}`
      const x0 = e.clientX
      let moved = false
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - x0
        if (!moved && Math.abs(dx) < 3) return
        moved = true
        const scale = get().pxPerSec
        const dt = dx / scale
        if (mode === 'move') {
          const r = snapTime(clip.start + dt, scale, edges, beat, sectionStarts)
          const shift = Math.min(maxShift, Math.max(minShift, r.t - clip.start))
          setSnapLine(
            r.snapped !== null && Math.abs(r.snapped - (clip.start + shift)) < 0.001 ? r.snapped : null,
          )
          dispatch(
            { type: 'clip.move', moves: moving.map((c) => ({ clipId: c.id, start: c.start + shift })) },
            { coalesceKey: key },
          )
        } else if (mode === 'start') {
          const r = snapTime(clip.start + dt, scale, edges, beat, sectionStarts)
          const start = Math.min(clip.end - 0.25, Math.max(min, r.t))
          setSnapLine(r.snapped)
          dispatch(
            { type: 'clip.trim', clipId: clip.id, start, duration: clip.end - start },
            { coalesceKey: key },
          )
        } else {
          const r = snapTime(clip.end + dt, scale, edges, beat, sectionStarts)
          const end = Math.max(clip.start + 0.25, Math.min(max, r.t))
          setSnapLine(r.snapped)
          dispatch(
            { type: 'clip.trim', clipId: clip.id, start: clip.start, duration: end - clip.start },
            { coalesceKey: key },
          )
        }
      }
      const up = () => {
        editor.endGesture()
        setSnapLine(null)
        if (!moved && group) select({ type: 'clip', id: clip.id })
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
    },
    [beat, duration],
  )

  /** Drag on empty track space: selects the clips the rectangle touches (added to the selection with Shift or Mod). */
  const startMarquee = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    const content = contentRef.current
    const box = marqueeRef.current
    if (!content || !box) return
    const lane = e.currentTarget
    const origin = content.getBoundingClientRect()
    const x0 = e.clientX - origin.left
    const y0 = e.clientY - origin.top
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const before = get().selection
    const base = additive ? selectedClipIds(before) : []
    const p = editor.getProject()
    const rows = trackRows(p, empty)
    let pointer = { x: e.clientX, y: e.clientY }
    let moved = false
    let frame = 0
    let shown: string | null = null
    lane.setPointerCapture(e.pointerId)
    const update = () => {
      frame = 0
      const r = content.getBoundingClientRect()
      const x1 = pointer.x - r.left
      const y1 = pointer.y - r.top
      const left = Math.max(HEADER_W, Math.min(x0, x1))
      const right = Math.max(left, x0, x1)
      const top = Math.min(y0, y1)
      const bottom = Math.max(y0, y1)
      box.style.transform = `translate(${left}px, ${top}px)`
      box.style.width = `${right - left}px`
      box.style.height = `${bottom - top}px`
      box.hidden = false
      const scale = get().pxPerSec
      const t0 = (left - HEADER_W) / scale
      const t1 = (right - HEADER_W) / scale
      const tracks = new Set(
        rows.filter((row) => row.top < bottom && row.top + row.height > top).map((row) => row.trackId),
      )
      const hits = Object.values(p.clips)
        .filter(
          (c) => tracks.has(c.trackId) && isSelectableClip(c) && c.start < t1 && c.start + c.duration > t0,
        )
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id)
      const ids = [...new Set([...base, ...hits])]
      const key = ids.join(',')
      if (key === shown) return
      shown = key
      selectClips(ids)
    }
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return
      moved = true
      pointer = { x: ev.clientX, y: ev.clientY }
      frame ||= requestAnimationFrame(update)
    }
    const end = () => {
      cancelAnimationFrame(frame)
      box.hidden = true
      lane.removeEventListener('pointermove', move)
      lane.removeEventListener('pointerup', up)
      lane.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', onKey, true)
    }
    const up = () => {
      end()
      if (moved) update()
      else if (!additive) set({ selection: { type: 'none' } })
    }
    // Esc cancels the marquee and keeps the selection it started with; captured before the global Esc deselects.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      end()
      if (lane.hasPointerCapture(e.pointerId)) lane.releasePointerCapture(e.pointerId)
      set({ selection: before })
    }
    lane.addEventListener('pointermove', move)
    lane.addEventListener('pointerup', up)
    lane.addEventListener('pointercancel', up)
    window.addEventListener('keydown', onKey, true)
  }

  /**
   * Drags a lyric line (its body moves it, its edges move its start or end) or one edge of a word, as one undo step.
   * A click without moving only selects the line.
   */
  const onLyricPointerDown = (e: React.PointerEvent, lineId: string, trackId: string, drag: LyricDrag) => {
    e.stopPropagation()
    select({ type: 'lyric', id: lineId })
    if (e.button !== 0) return
    e.preventDefault()
    const p = editor.getProject()
    const limits =
      drag.type === 'line'
        ? lineDeltaRange(p, lineId, drag.edge)
        : wordEdgeRange(p, lineId, drag.index, drag.edge)
    if (!limits) return
    const track = p.tracks.find((t) => t.id === trackId)
    const key = `lyric:${e.pointerId}:${lineId}:${e.timeStamp}`
    const label = drag.type === 'line' && drag.edge === 'move' ? MOVE_LABEL : TIMING_LABEL
    const x0 = e.clientX
    let moved = false
    // On the window: a word can stop showing as a word while it is dragged narrower, which unmounts its handle.
    const move = (ev: PointerEvent) => {
      // A move with the button up means the press ended where no pointerup reached the window.
      if ((ev.buttons & 1) === 0) {
        up()
        return
      }
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 3) return
      if (!moved && track?.locked) {
        toast(`The ${track.name} track is locked. Unlock it to edit.`)
        up()
        return
      }
      moved = true
      const d = dx / get().pxPerSec
      const commands =
        drag.type === 'line'
          ? lineTimingCommands(p, lineId, drag.edge, d)
          : wordEdgeCommands(p, lineId, drag.index, drag.edge, d)
      if (commands) dispatch(commands, { coalesceKey: key, label })
    }
    const up = () => {
      if (moved) editor.endGesture()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const selId = selection.type === 'none' ? null : selection.id
  const gridStyle = beatSnap && beat ? { backgroundSize: `${beat * 4 * pps}px 100%` } : undefined
  const inView = (start: number, end: number) => end >= view.t0 - 4 && start <= view.t1 + 4

  return (
    <div className={styles.root}>
      <Toolbar onFit={fit} bpm={bpm} />
      <div ref={scrollRef} className={`${styles.scroller} scroll`} data-timeline-scroller>
        <div
          ref={contentRef}
          className={styles.content}
          style={{ width: HEADER_W + contentW, height: totalH }}
        >
          <div className={styles.row} style={{ height: RULER_H }}>
            <div className={[styles.header, styles.corner].join(' ')} />
            <div className={styles.ruler} style={{ width: contentW }} onPointerDown={scrubFrom}>
              <ViewportCanvas height={RULER_H} draw={ruler} />
              <Playhead head />
            </div>
          </div>

          {!empty && (
            <div className={styles.row} style={{ height: SONG_H }}>
              <div className={[styles.header, styles.songHeader].join(' ')}>
                <span className={styles.trackName}>Song map</span>
                <Tooltip
                  label="Sections, chorus and energy were found automatically"
                  description="Double-click a section to rename it. Drag its edges to adjust."
                >
                  <span className={styles.autoBadge}>
                    <Sparkles />
                  </span>
                </Tooltip>
              </div>
              <div className={styles.songLane} style={{ width: contentW }}>
                {showEnergy && (
                  <div className={styles.energyLayer}>
                    <ViewportCanvas height={SONG_H} draw={energyDraw} />
                  </div>
                )}
                {sections.map((s) => {
                  const sel = selId === s.id
                  return (
                    <div
                      key={s.id}
                      className={[styles.section, sel && styles.sectionSel].filter(Boolean).join(' ')}
                      style={{
                        left: s.start * pps,
                        width: (s.end - s.start) * pps,
                        ['--sec' as string]: sectionColor[sectionKind(s)],
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        select({ type: 'section', id: s.id })
                      }}
                      onDoubleClick={() => setRenaming(s.id)}
                      role="button"
                      tabIndex={0}
                      aria-label={`Section ${sectionName(s)}, ${formatTime(s.start)} to ${formatTime(s.end)}`}
                      title={sectionGuess(s) && `${sectionGuess(s)}. Double-click to rename.`}
                    >
                      {renaming === s.id ? (
                        <input
                          className={styles.renameInput}
                          autoFocus
                          defaultValue={s.label}
                          onPointerDown={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            const label = e.target.value.trim()
                            if (label && label !== s.label && analysis)
                              dispatch({
                                type: 'analysis.updateSection',
                                assetId: analysis.assetId,
                                sectionId: s.id,
                                patch: { label },
                              })
                            setRenaming(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') e.currentTarget.value = s.label
                            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                          }}
                          aria-label="Rename section"
                        />
                      ) : (
                        <span
                          className={[styles.sectionLabel, sectionUnsure(s) && styles.sectionLabelGuess]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {sectionName(s)}
                        </span>
                      )}
                      {sel && <SectionSuggestion section={s} />}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {lanes.map(({ track, kind, height }) => {
            const clips = clipsOnTrack(project, track.id)
              .map((c) => viewOf(project, c))
              .filter((c) => inView(c.start, c.end))
            return (
              <Fragment key={track.id}>
                <div
                  className={[styles.row, track.hidden && styles.rowHidden].filter(Boolean).join(' ')}
                  style={{ height }}
                >
                  <div className={styles.header}>
                    <TrackHeader
                      track={track}
                      height={height}
                      stems={track.id === stemTrack?.id ? mix : null}
                    />
                  </div>
                  <div
                    className={[styles.lane, beatSnap && beat && styles.grid].filter(Boolean).join(' ')}
                    style={{ width: contentW, ...gridStyle }}
                    onPointerDown={startMarquee}
                    onContextMenu={(e) =>
                      openLaneMenu(
                        e,
                        track.id,
                        (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps,
                      )
                    }
                    onDragOver={(e) => {
                      if (kind === 'audio' || !isLibraryDrag(e)) return
                      const time = (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps
                      const next = libraryDropHint(track.id, time)
                      // A locked track takes no drop: without preventDefault the browser shows "not allowed".
                      if (next && 'locked' in next) e.dataTransfer.dropEffect = 'none'
                      else {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'copy'
                      }
                      setDropHint((h) => (JSON.stringify(h) === JSON.stringify(next) ? h : next))
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(null)
                    }}
                    onDrop={(e) => {
                      const item = kind === 'audio' ? null : droppedLibraryItem(e)
                      if (!item) return
                      e.preventDefault()
                      setDropHint(null)
                      const time = (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps
                      dropLibraryItem(item, { trackId: track.id, time })
                    }}
                  >
                    {dropHint?.trackId === track.id &&
                      ('locked' in dropHint ? (
                        <div className={styles.dropLocked} style={{ left: dropHint.at * pps }}>
                          Track is locked
                        </div>
                      ) : (
                        <div
                          className={dropHint.end > dropHint.start ? styles.dropClip : styles.dropCut}
                          style={{
                            left: dropHint.start * pps,
                            width:
                              dropHint.end > dropHint.start
                                ? (dropHint.end - dropHint.start) * pps
                                : undefined,
                          }}
                        />
                      ))}
                    {kind === 'lyrics' &&
                      !empty &&
                      !lines.length &&
                      !clipsOnTrack(project, track.id).length && (
                        <Tooltip label="Paste lyrics or draft them from the vocals">
                          <button className={styles.laneEmpty} onClick={() => openAssist('lyrics')}>
                            <Plus /> Add lyrics
                          </button>
                        </Tooltip>
                      )}
                    {kind === 'audio' &&
                      clips.map((c) => (
                        <div
                          key={c.id}
                          className={styles.audioClip}
                          style={{ left: c.start * pps, width: (c.end - c.start) * pps }}
                        >
                          <ViewportCanvas height={height - 4} draw={songWave} />
                          <span className={styles.audioLabel}>
                            <Music4 /> {c.name}
                          </span>
                        </div>
                      ))}
                    {kind !== 'audio' &&
                      clips.map((c) => {
                        if (c.kind === 'lyric') {
                          const lineId = c.lyricLineId
                          const line = lines.find((l) => l.id === lineId)
                          const w = (c.end - c.start) * pps
                          const sel = selId === lineId
                          const drag = (e: React.PointerEvent, d: LyricDrag) => {
                            if (lineId) onLyricPointerDown(e, lineId, track.id, d)
                            else e.stopPropagation()
                          }
                          return (
                            <div
                              key={c.id}
                              className={[styles.lyric, sel && styles.selected].filter(Boolean).join(' ')}
                              style={{ transform: `translateX(${c.start * pps}px)`, width: w }}
                              role="button"
                              tabIndex={0}
                              aria-label={`Lyric: ${c.name}`}
                              aria-pressed={sel}
                              aria-keyshortcuts="Enter"
                              data-space-plays
                              onPointerDown={(e) => drag(e, { type: 'line', edge: 'move' })}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' || !lineId) return
                                e.preventDefault()
                                select({ type: 'lyric', id: lineId })
                              }}
                            >
                              <LyricChipContent
                                text={line?.text ?? c.name}
                                words={line?.words ?? []}
                                start={c.start}
                                width={w}
                                pps={pps}
                                selected={sel}
                                onWordEdge={(e, index, edge) => drag(e, { type: 'word', index, edge })}
                              />
                              {w >= 16 && (
                                <>
                                  <span
                                    className={[styles.handle, styles.handleL].join(' ')}
                                    onPointerDown={(e) => drag(e, { type: 'line', edge: 'start' })}
                                  />
                                  <span
                                    className={[styles.handle, styles.handleR].join(' ')}
                                    onPointerDown={(e) => drag(e, { type: 'line', edge: 'end' })}
                                  />
                                </>
                              )}
                              {sel && lineId && <LineMatches lineId={lineId} />}
                            </div>
                          )
                        }
                        return (
                          <ClipBlock
                            key={c.id}
                            clip={c}
                            pps={pps}
                            selected={selIds.has(c.id)}
                            onPointerDown={onClipPointerDown}
                          />
                        )
                      })}
                    {suggestTiming && track.id === lyricsTrackId && (
                      <div
                        ref={measureSuggest}
                        className={styles.untimedSuggest}
                        style={{ left: suggestLeft }}
                      >
                        <InlineSuggestion
                          id="time-lyrics"
                          variant="chip"
                          action="Time words to the vocals"
                          onAction={() => openAssist('lyrics')}
                        >
                          {plural(untimed, 'line')} not timed yet
                        </InlineSuggestion>
                      </div>
                    )}
                  </div>
                </div>
                {track.id === stemTrack?.id && stemLanes}
              </Fragment>
            )
          })}

          {!stemTrack && stemLanes}

          {empty && (
            <div className={styles.dropHint} style={{ top: RULER_H, left: HEADER_W }}>
              <Upload />
              <span>
                <strong>Drop your song here</strong> · beats, sections and energy appear in a few seconds
              </span>
            </div>
          )}

          {snapLine !== null && (
            <div
              className={styles.snapLine}
              style={{ transform: `translateX(${HEADER_W + snapLine * pps}px)`, height: totalH }}
            />
          )}
          <div ref={marqueeRef} className={styles.marquee} hidden aria-hidden />
          <Playhead height={totalH} />
        </div>
      </div>
      <LaneMenu />
    </div>
  )
}
