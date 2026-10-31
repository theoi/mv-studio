import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  AudioWaveform,
  ChevronDown,
  Eye,
  EyeOff,
  Flag,
  GripVertical,
  Headphones,
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
import type { Clip, FeatureSeries, LyricWord, Project, StemName, Track } from '../../../../model/index.ts'
import { BARS_NOTES, clipsOnTrack, STEM_NAMES } from '../../../../model/index.ts'
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
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '../../../ds/Menu.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { TransitionMark } from './Transitions.tsx'
import { formatBpm, formatTime, plural } from '../../../format.ts'
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
  addTransitionAtCut,
  bareCuts,
  placeTransitionMarks,
  transitionMarkWidth,
  transitionName,
  transitionsAtClip,
  type TransitionSpot,
} from '../../../state/transitions.ts'
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  hasClipboard,
  isLyricClip,
  isSelectableClip,
  paste,
  selectTimelineClips,
  timelineSelectionIds,
} from '../../../state/clipboard.ts'
import {
  bpmOf,
  dispatch,
  editor,
  hasSong,
  isLookClip,
  lyricLines,
  sectionGuess,
  sectionName,
  sectionsOf,
  sectionTint,
  sectionUnsure,
  songAnalysis,
  splitAtPlayhead,
  splitClipAt,
  timelineDuration,
  useProject,
  viewOf,
  type ClipView,
} from '../../../state/project.ts'
import { useFrameThumbnail } from '../../../state/thumbs.ts'
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
import { beatGrid, lastIndexAt, snapTo, type BeatGrid } from '../../../state/beats.ts'
import { useBars, type BarsState } from '../../../state/songAnalysis.ts'
import {
  droppedLibraryItem,
  dropLibraryItem,
  isLibraryDrag,
  libraryDropHint,
} from '../../../state/library.ts'
import { exportSectionTeaser } from '../../../state/exports.ts'
import { revealSuggestions, useFootage, useFootageResults } from '../../../state/footage.ts'
import { addMarkerAtPlayhead } from '../../../state/markers.ts'
import {
  EASINGS,
  groupMarks,
  keyframeMarks,
  markTargets,
  removeKeyframes,
  setKeyframeEasing,
  type KeyframeMark,
} from '../../../state/keyframes.ts'
import {
  BUTT_PX,
  blockedAt,
  dropShift,
  isLyricsTrack,
  refusalLabel,
  refusalToast,
  refuseTrack,
  type DropRefusal,
  type Span,
} from '../../../state/clipDrag.ts'
import { registerReveal } from '../../../state/reveal.ts'
import {
  cutClipsToSection,
  moveBoundary,
  sectionBoundaries,
  sectionClipIds,
  type SectionBoundary,
} from '../../../state/sections.ts'
import {
  separatedStems,
  songStemTrack,
  STEM_LABELS,
  stemBadge,
  stemMix,
  toggleStem,
  useUnplayableStem,
  type StemMix,
  type UnplayableStem,
} from '../../../state/stems.ts'
import { moveAnnouncement, moveTrack, moveTrackBy, trackMoveRange } from '../../../state/tracks.ts'
import { dropMedia, isMediaDrag, mediaDropHint, type MediaDropHint } from '../../../state/mediaDrag.ts'
import { MAX_PPS, MIN_PPS, registerFit, zoomTo } from '../../../state/zoom.ts'
import { InlineSuggestion } from '../Suggestion.tsx'
import { energySampler } from './energy.ts'
import { LaneMenu } from './LaneMenu.tsx'
import { openLaneMenu } from './laneMenu.ts'
import { Markers } from './Markers.tsx'
import styles from './Timeline.module.css'

const HEADER_W = 148
const RULER_H = 24
const SONG_H = 30

type LaneKind = 'video' | 'overlay' | 'lyrics' | 'look' | 'audio'

// Lanes leave their clips at least 24 px tall (lane minus the 1 px border and 2 px above and below), so short clips
// are easy to grab. The look lane stays compact: its one bar spans the song, so it is easy to hit anyway.
const laneHeight: Record<LaneKind, number> = { video: 40, overlay: 29, lyrics: 29, look: 22, audio: 40 }

function laneKind(p: Project, t: Track): LaneKind {
  if (t.kind === 'audio') return 'audio'
  const clips = clipsOnTrack(p, t.id)
  if (!clips.length && isLyricsTrack(p, t)) return 'lyrics'
  if (clips.some((c) => c.type === 'video' || c.type === 'image')) return 'video'
  if (clips.length && clips.every((c) => c.type === 'text' && c.lyricLineId)) return 'lyrics'
  if (clips.length && clips.every(isLookClip)) return 'look'
  return clips.length ? 'overlay' : 'video'
}

interface TrackRow {
  trackId: string
  top: number
  height: number
}

/**
 * Top and height of each track's row in the timeline content, below the ruler and the song lane. `kinds` overrides
 * the lane kinds (and so the heights) the clips would give.
 */
function trackRows(p: Project, empty: boolean, kinds?: ReadonlyMap<string, LaneKind>): TrackRow[] {
  let top = RULER_H + (empty ? 0 : SONG_H)
  return p.tracks.map((t) => {
    const height = laneHeight[kinds?.get(t.id) ?? laneKind(p, t)]
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

function makeRuler(grid: BeatGrid | null): DrawFn {
  return (ctx, t0, pps, w, h) => {
    const t1 = t0 + w / pps
    const labelStep = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 64) ?? 60
    ctx.font = '500 10px "Inter Variable", Inter, sans-serif'
    ctx.textBaseline = 'top'
    if (grid) {
      const dense = grid.beat * pps >= 5
      // Until the bars are found, zoomed-out ticks fall on every few beats, all alike.
      const bars = grid.detectedBars
      const events = dense || !bars ? grid.beats : grid.downbeats
      const every = dense ? 1 : Math.max(1, Math.ceil(5 / (grid.beat * (bars ? grid.beatsPerBar : 1) * pps)))
      let d = Math.max(0, lastIndexAt(grid.downbeats, t0 - grid.beat))
      for (
        let i = Math.floor(Math.max(0, lastIndexAt(events, t0)) / every) * every;
        i < events.length;
        i += every
      ) {
        const t = events[i] as number
        if (t > t1) break
        let down = bars && !dense
        if (bars && dense) {
          while ((grid.downbeats[d] ?? Infinity) < t - grid.beat / 4) d++
          down = Math.abs((grid.downbeats[d] ?? Infinity) - t) < grid.beat / 4
        }
        const x = Math.round((t - t0) * pps) + 0.5
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

/** A flat line where a song's waveform goes until its loudness is analyzed, from 0 to the song's end. */
function makeFlatWave(color: string, end: number): DrawFn {
  return (ctx, t0, pps, w, h) => {
    const left = Math.max(0, -t0 * pps)
    const right = Math.min(w, (end - t0) * pps)
    if (right <= left) return
    ctx.fillStyle = color
    ctx.fillRect(left, Math.round(h / 2) - 1, right - left, 2)
  }
}

/** Bar lines behind the tracks once the bars are found, and beat lines when zoomed in, from the song's beat grid. */
function makeBeatLines(grid: BeatGrid | null): DrawFn {
  return (ctx, t0, pps, w, h) => {
    if (!grid) return
    const t1 = t0 + w / pps
    const line = (events: readonly number[], every: number) => {
      for (
        let i = Math.floor(Math.max(0, lastIndexAt(events, t0)) / every) * every;
        i < events.length;
        i += every
      ) {
        const t = events[i] as number
        if (t > t1) break
        ctx.fillRect(Math.round((t - t0) * pps), 0, 1, h)
      }
    }
    if (grid.beat * pps >= 18) {
      ctx.fillStyle = 'rgba(255,255,255,0.02)'
      line(grid.beats, 1)
    }
    if (!grid.detectedBars) return
    ctx.fillStyle = 'rgba(255,255,255,0.045)'
    line(grid.downbeats, Math.max(1, Math.ceil(12 / (grid.beat * grid.beatsPerBar * pps))))
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
  const songEnd = series?.values.length ? series.values.length / series.rate : 0
  return (ctx, t0, pps, w, h) => {
    // The curve stops where the song ends, on a timeline that runs longer than the song.
    const last = Math.min(w, (songEnd - t0) * pps)
    if (last <= 0) return
    // Each 2 px column averages at least its own time span, so every sample counts once when zoomed out.
    const y = (x: number) => h - 2 - at(Math.min(songEnd, t0 + x / pps), 2 / pps) * (h - 8)
    const pts: [number, number][] = []
    for (let x = 0; x < last; x += 2) pts.push([x, y(x)])
    pts.push([last, y(last)])
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (const [x, py] of pts) ctx.lineTo(x, py)
    ctx.lineTo(last, h)
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

/** Added to a lyric chip's name while its line is to check. */
const CHECK_NAMES = { words: ', draft, check the words', timing: ', check the timing' } as const

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
 * left of the view (`view`, px) that fits it inside the view, else null.
 */
function freeSpot(spans: [number, number][], view: [number, number], width: number, gap = 8): number | null {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  let x = view[0] + gap
  for (const [a, b] of sorted) {
    if (b + gap <= x) continue
    if (a - gap >= x + width) break
    x = b + gap
  }
  return x + width <= view[1] - gap ? x : null
}

/* ---------- toolbar ---------- */

// Memoized, like TrackHeader: a drag re-renders the timeline on every pointer move, and neither depends on the clips.
const Toolbar = memo(function Toolbar({
  onFit,
  bpm,
  grid,
  bars,
}: {
  onFit: () => void
  bpm?: number
  grid: BeatGrid | null
  bars: BarsState['status']
}) {
  const snap = useUi((s) => s.snap)
  const beatSnap = useUi((s) => s.beatSnap)
  const barSnap = useUi((s) => s.barSnap)
  const sectionSnap = useUi((s) => s.sectionSnap)
  const edgeSnap = useUi((s) => s.edgeSnap)
  const playheadSnap = useUi((s) => s.playheadSnap)
  const showEnergy = useUi((s) => s.showEnergy)
  const showGrid = useUi((s) => s.showGrid)
  const pps = useUi((s) => s.pxPerSec)
  const tool = useUi((s) => s.tool)
  // While the bars are not found, "Bar starts" is off (the choice is kept for when they are).
  const waiting = bars === 'finding' || bars === 'unavailable'
  const barsShort =
    bars === 'finding' ? BARS_NOTES.finding : bars === 'unavailable' ? BARS_NOTES.notFound : undefined
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
            { value: 'select', label: <MousePointer2 />, title: 'Select', shortcut: 'V' },
            { value: 'split', label: <Scissors />, title: 'Split: click a clip to cut it' },
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
              <MenuCheckItem
                checked={barSnap && !waiting}
                onCheckedChange={(v) => set({ barSnap: v })}
                disabled={waiting}
                description={barsShort}
              >
                Bar starts
              </MenuCheckItem>
              <MenuCheckItem checked={sectionSnap} onCheckedChange={(v) => set({ sectionSnap: v })}>
                Sections
              </MenuCheckItem>
              <MenuCheckItem checked={edgeSnap} onCheckedChange={(v) => set({ edgeSnap: v })}>
                Clip edges
              </MenuCheckItem>
              <MenuCheckItem checked={playheadSnap} onCheckedChange={(v) => set({ playheadSnap: v })}>
                Playhead
              </MenuCheckItem>
            </MenuContent>
          </Menu>
        </div>
        <IconButton label="Add marker" shortcut="M" size="sm" onClick={addMarkerAtPlayhead} data-add-marker>
          <Flag />
        </IconButton>
        {bpm !== undefined && (
          <Tooltip
            label="Detected tempo and meter"
            description={
              grid?.detectedBars || bars === 'none'
                ? 'Adjust in Assist › Song analysis'
                : bars === 'finding'
                  ? `${BARS_NOTES.finding} The meter shows once they are found.`
                  : `${BARS_NOTES.notFound}. ${BARS_NOTES.analyzeAgain} The meter shows once they are found.`
            }
          >
            <button className={`${styles.bpm} tnum`} onClick={() => openAssist('analysis')}>
              <Music4 />
              {formatBpm(bpm)}
              {grid?.detectedBars && ` · ${grid.beatsPerBar}/4`}
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
            <MenuCheckItem checked={showGrid} onCheckedChange={(v) => set({ showGrid: v })}>
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

/** Snaps within 8 px, to what the snap menu has on. */
function snapTime(t: number, pps: number, grid: BeatGrid | null, edges: number[], sections: number[]) {
  const s = get()
  return snapTo(t, 8 / pps, grid, s, { edges, sections, playhead: s.playhead })
}

/**
 * The selected clip's keyframes, one Tab stop: Left and Right (Home, End) move between them, Enter or a click moves
 * the playhead to one and opens its easing menu, Delete removes it. After a removal, focus goes to the neighboring
 * mark, or to the clip when none is left. Keyframes whose diamonds would touch share one mark at the first of them,
 * with their count and a line to the last; its menu sets the easing of all of them or removes them.
 */
function KeyframeMarks({
  clip,
  marks,
  pps,
  width,
}: {
  clip: ClipView
  marks: KeyframeMark[]
  pps: number
  width: number
}) {
  const [active, setActive] = useState(0)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  /** Where focus goes once a removal's menu has closed: a mark's first time, or the clip. */
  const after = useRef<{ remove: number; focus: number | 'clip' } | null>(null)
  const groups = groupMarks(
    marks,
    marks.map((m) => Math.min(width - 8, Math.max(8, m.time * pps))),
  )
  const targets = markTargets(
    groups.map((g) => g.at),
    width,
  )
  const firstTime = (i: number) => groups[i]?.marks[0]?.time
  const current = Math.min(active, groups.length - 1)
  const focusGroup = (i: number) => buttons.current.get(firstTime(i)!)?.focus()
  const focusAfterRemoving = (i: number): number | 'clip' => firstTime(i + 1) ?? firstTime(i - 1) ?? 'clip'
  const moveFocus = (target: number | 'clip') => {
    if (target === 'clip') document.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`)?.focus()
    else buttons.current.get(target)?.focus()
  }
  return (
    <span
      className={[styles.keyframes, clip.kind === 'look' && styles['keyframes-look']]
        .filter(Boolean)
        .join(' ')}
      style={{ left: clip.start * pps, width }}
    >
      {groups.map(
        (group) =>
          group.end > group.at && (
            <span
              key={`run-${group.marks[0]!.time}`}
              className={styles.keyframeRun}
              style={{ left: group.at, width: group.end - group.at }}
            />
          ),
      )}
      {groups.map((group, i) => {
        const first = group.marks[0]!
        const last = group.marks.at(-1)!
        const times = group.marks.map((m) => m.time)
        const count = times.length
        const at = clip.start + first.time
        const easing = group.marks.every((m) => m.easing === first.easing) ? first.easing : null
        const hasNext = group.marks.some((m) => m.hasNext)
        const target = targets[i]!
        return (
          <Menu key={first.time}>
            <MenuTrigger asChild>
              <button
                ref={(el) => {
                  if (el) buttons.current.set(first.time, el)
                  else buttons.current.delete(first.time)
                }}
                className={styles.keyframe}
                style={{
                  left: target.left,
                  width: target.width,
                  ['--diamond-x' as string]: `${group.at - target.left}px`,
                }}
                tabIndex={i === current ? 0 : -1}
                aria-label={
                  count > 1
                    ? `${count} keyframes, ${formatTime(at, true)} to ${formatTime(clip.start + last.time, true)}`
                    : `Keyframe at ${formatTime(at, true)}`
                }
                onFocus={() => setActive(i)}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  set({ playhead: at })
                }}
                onKeyDown={(e) => {
                  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
                  const to = step
                    ? i + step
                    : e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? groups.length - 1
                        : null
                  if (to !== null) {
                    // The global Left and Right move the playhead; here they move between the marks.
                    e.preventDefault()
                    e.stopPropagation()
                    focusGroup(Math.max(0, Math.min(groups.length - 1, to)))
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    set({ playhead: at })
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    // Without this, the global Delete would remove the whole clip.
                    e.preventDefault()
                    e.stopPropagation()
                    const next = focusAfterRemoving(i)
                    removeKeyframes(clip.id, times)
                    requestAnimationFrame(() => moveFocus(next))
                  }
                }}
              >
                {count > 1 && (
                  <span className={`${styles.keyframeCount} tnum`} aria-hidden>
                    {count}
                  </span>
                )}
              </button>
            </MenuTrigger>
            <MenuContent
              side="top"
              align="center"
              onCloseAutoFocus={(e) => {
                const pending = after.current
                if (!pending || pending.remove !== first.time) return
                // Remove once the menu has closed, so its trigger is still there to close against.
                e.preventDefault()
                after.current = null
                removeKeyframes(clip.id, times)
                requestAnimationFrame(() => moveFocus(pending.focus))
              }}
            >
              <MenuLabel>{hasNext ? 'Easing to the next keyframe' : 'No next keyframe'}</MenuLabel>
              {EASINGS.map((option) => (
                <MenuCheckItem
                  key={option.value}
                  checked={easing === option.value}
                  disabled={!hasNext}
                  onCheckedChange={() => setKeyframeEasing(clip.id, times, option.value)}
                >
                  {option.label}
                </MenuCheckItem>
              ))}
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  after.current = { remove: first.time, focus: focusAfterRemoving(i) }
                }}
              >
                {count > 1 ? `Remove ${count} keyframes` : 'Remove keyframe'}
              </MenuItem>
            </MenuContent>
          </Menu>
        )
      })}
    </span>
  )
}

interface ClipBlockProps {
  clip: ClipView
  pps: number
  selected: boolean
  /** Keyframes of the clip, shown while it is the only selected clip. */
  marks?: KeyframeMark[]
  onPointerDown: (e: React.PointerEvent, clip: ClipView, mode: DragMode) => void
}

const sameView = (a: ClipView, b: ClipView) =>
  (Object.keys(a) as (keyof ClipView)[]).every((k) => a[k] === b[k]) &&
  Object.keys(a).length === Object.keys(b).length

/**
 * Shift or Mod click (or Enter or Space): adds the clip, or a lyric line's chip, to the selection or takes it out. A
 * selected lyric line counts as its chip, so clips and lyric lines can be selected together.
 */
function toggleInSelection(clipId: string) {
  const p = editor.getProject()
  const picked = timelineSelectionIds(p, get().selection, p.clips[clipId]?.trackId)
  selectTimelineClips(p, picked.includes(clipId) ? picked.filter((id) => id !== clipId) : [...picked, clipId])
}

/** Re-renders only when its clip, zoom or selection changes: an edit to one clip leaves the others alone. */
const ClipBlock = memo(
  ClipBlockView,
  (a, b) =>
    a.selected === b.selected &&
    a.marks === b.marks &&
    a.pps === b.pps &&
    a.onPointerDown === b.onPointerDown &&
    sameView(a.clip, b.clip),
)

/** The cut without a transition at either end of a clip, the one nearer `time`; `clipId` is the clip after it. */
function cutNear(clip: ClipView, time: number): { clipId: string; time: number } | null {
  const cuts = bareCuts(editor.getProject(), clip.trackId).filter(
    (c) => Math.abs(c.time - clip.start) < 1e-3 || Math.abs(c.time - clip.end) < 1e-3,
  )
  cuts.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))
  return cuts[0] ?? null
}

function ClipBlockView({ clip, pps, selected, marks, onPointerDown }: ClipBlockProps) {
  const [canPaste, setCanPaste] = useState(false)
  const [cut, setCut] = useState<{ clipId: string; time: number } | null>(null)
  const [transitions, setTransitions] = useState<TransitionSpot[]>([])
  const menuTime = useRef(clip.start)
  const width = Math.max(2, (clip.end - clip.start) * pps)
  const isMedia = clip.kind === 'video' || clip.kind === 'image'
  const thumb = useFrameThumbnail(isMedia ? clip.asset : undefined, clip.sourceStart ?? 0)
  // A media clip's name sits beside its transition marks, which straddle its top edge where the name would be.
  const inW = clip.transitionIn ? transitionMarkWidth(clip.transitionIn, pps) : 0
  const outW = clip.transitionOut ? transitionMarkWidth(clip.transitionOut, pps) : 0
  const showLabel = isMedia ? width - inW - outW > 36 : width > 54
  const label =
    clip.kind === 'look' && clip.amount !== undefined
      ? `${clip.name} · ${Math.round(clip.amount * 100)}%`
      : clip.name
  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) return
          // The menu acts on the selection, so a clip outside it becomes the selection.
          if (!selectedClipIds(get().selection).includes(clip.id)) select({ type: 'clip', id: clip.id })
          setCanPaste(hasClipboard())
          setCut(cutNear(clip, menuTime.current))
          setTransitions(transitionsAtClip(editor.getProject(), clip.id))
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
              backgroundImage: thumb ? `url(${thumb})` : undefined,
            }}
            role="button"
            tabIndex={0}
            data-clip-id={clip.id}
            aria-label={`${label}, ${formatTime(clip.start, true)} to ${formatTime(clip.end, true)}`}
            aria-pressed={selected}
            aria-keyshortcuts="Enter Shift+Enter"
            // Enter selects and Shift Enter adds to the selection; Space plays or pauses, as in other editors, even
            // with the clip focused from the keyboard.
            data-space-plays
            onPointerDown={(e) => onPointerDown(e, clip, 'move')}
            onContextMenu={(e) => {
              const box = e.currentTarget.getBoundingClientRect()
              // From the keyboard (Shift F10) the menu opens with no pointer over the clip: use its start.
              menuTime.current =
                e.clientX >= box.left && e.clientX <= box.right
                  ? clip.start + (e.clientX - box.left) / pps
                  : clip.start
            }}
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
            {isMedia && showLabel && (
              <span
                className={styles.mediaLabel}
                style={inW || outW ? { left: inW + 3, maxWidth: width - inW - outW - 6 } : undefined}
              >
                {clip.name}
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
          {(cut || transitions.length > 0) && <ContextMenuSeparator />}
          {cut && (
            <ContextMenuItem
              description={`At the cut at ${formatTime(cut.time, true)}`}
              onSelect={() => addTransitionAtCut(cut.clipId)}
            >
              Add transition
            </ContextMenuItem>
          )}
          {/* Also reaches a transition whose mark is left out at a low zoom. */}
          {transitions.map((s) => (
            <ContextMenuItem
              key={`${s.clipId}:${s.edge}`}
              description={`${transitionName(s.transition)} at ${formatTime(s.start, true)}`}
              onSelect={() => select({ type: 'transition', id: s.clipId, edge: s.edge })}
            >
              Edit transition
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => openAssist('behind')}>Put text behind subject…</ContextMenuItem>
          <ContextMenuItem onSelect={() => openAssist('match')}>Find similar clips…</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger shortcut="Delete" onSelect={deleteSelection}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {/* Beside the clip, not inside it: events from the easing menu's portal would bubble to the clip's drag. */}
      {selected && marks && marks.length > 0 && width > 16 && (
        <KeyframeMarks clip={clip} marks={marks} pps={pps} width={width} />
      )}
    </>
  )
}

/* ---------- headers ---------- */

/** What turning a track setting on and off is called. */
const TRACK_TOGGLES = {
  muted: ['Mute', 'Unmute'],
  solo: ['Solo', 'Unsolo'],
  locked: ['Lock', 'Unlock'],
  hidden: ['Hide', 'Show'],
} as const

const TrackHeader = memo(function TrackHeader({
  track,
  height,
  stems,
  canMoveUp,
  canMoveDown,
  onGripPointerDown,
  onAnnounce,
  fallback,
}: {
  track: Track
  height: number
  stems?: StemMix | null
  canMoveUp: boolean
  canMoveDown: boolean
  onGripPointerDown: (e: React.PointerEvent<HTMLElement>, track: Track) => void
  onAnnounce: (message: string) => void
  /** The stem the preview could not decode, so it plays the full song. */
  fallback?: UnplayableStem | null
}) {
  // Undo names the action and the track: "Undid: Hide Video".
  const toggle = (key: keyof typeof TRACK_TOGGLES) =>
    dispatch(
      { type: 'track.update', trackId: track.id, patch: { [key]: !track[key] } },
      { label: `${TRACK_TOGGLES[key][track[key] ? 1 : 0]} ${track.name}` },
    )
  const isAudio = track.kind === 'audio'
  const badge = stems && stemBadge(stems, fallback)
  const grip = useRef<HTMLButtonElement>(null)
  // Set by Move up and Move down, so the closing menu hands focus to this track's grip instead of the page.
  const movedFromMenu = useRef(false)
  const moveBy = (step: -1 | 1) => {
    const moved = moveTrackBy(track.id, step)
    onAnnounce(moveAnnouncement(editor.getProject(), track.id, step, moved))
  }
  const moveFromMenu = (step: -1 | 1) => {
    movedFromMenu.current = true
    moveBy(step)
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={styles.trackHeader} style={{ height }}>
          <Tooltip label="Drag to reorder" description="↑ ↓ when focused" side="right">
            <button
              ref={grip}
              className={styles.grip}
              aria-label={`Move the ${track.name} track`}
              onPointerDown={(e) => onGripPointerDown(e, track)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                // The arrows otherwise move the playhead between sections.
                e.preventDefault()
                e.stopPropagation()
                moveBy(e.key === 'ArrowUp' ? -1 : 1)
              }}
            >
              <GripVertical />
            </button>
          </Tooltip>
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
          {badge && (
            <span
              className={[styles.stemBadge, badge.tone === 'warning' && styles.stemBadgeWarning]
                .filter(Boolean)
                .join(' ')}
              title={badge.full}
            >
              <span aria-hidden="true">{badge.text}</span>
              <span className="sr-only">{badge.full}</span>
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (!movedFromMenu.current) return
          movedFromMenu.current = false
          e.preventDefault()
          grip.current?.focus()
        }}
      >
        <ContextMenuItem icon={<ArrowUp />} disabled={!canMoveUp} onSelect={() => moveFromMenu(-1)}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem icon={<ArrowDown />} disabled={!canMoveDown} onSelect={() => moveFromMenu(1)}>
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        {isAudio ? (
          <>
            <ContextMenuItem icon={track.muted ? <Volume2 /> : <VolumeX />} onSelect={() => toggle('muted')}>
              {track.muted ? 'Unmute' : 'Mute'}
            </ContextMenuItem>
            <ContextMenuItem icon={<Headphones />} onSelect={() => toggle('solo')}>
              {track.solo ? 'Unsolo' : 'Solo'}
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem icon={track.hidden ? <Eye /> : <EyeOff />} onSelect={() => toggle('hidden')}>
            {track.hidden ? 'Show track' : 'Hide track'}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem icon={track.locked ? <LockOpen /> : <Lock />} onSelect={() => toggle('locked')}>
          {track.locked ? 'Unlock track' : 'Lock track'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

/** A stem lane's header under the song track: mute and solo for that stem of the song, from its icons or its menu. */
function StemHeader({ name, track }: { name: StemName; track: Track | undefined }) {
  const label = STEM_LABELS[name]
  const flags = track?.stems?.[name]
  const lower = label.toLowerCase()
  const header = (
    <div
      className={[styles.header, styles.stemHeader].join(' ')}
      // Without a song track there is nothing to offer, and the browser's page menu would open instead.
      onContextMenu={track ? undefined : (e) => e.preventDefault()}
    >
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
  if (!track) return header
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          icon={flags?.muted ? <Volume2 /> : <VolumeX />}
          onSelect={() => toggleStem(name, 'muted')}
        >
          {flags?.muted ? `Unmute ${lower}` : `Mute ${lower}`}
        </ContextMenuItem>
        <ContextMenuItem icon={<Headphones />} onSelect={() => toggleStem(name, 'solo')}>
          {flags?.solo ? `Unsolo ${lower}` : `Solo ${lower}`}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  const dropRef = useRef<HTMLDivElement>(null)
  const announceRef = useRef<HTMLDivElement>(null)
  const project = useProject()
  const pps = useUi((s) => s.pxPerSec)
  const selection = useUi((s) => s.selection)
  const selIds = useMemo(() => new Set(selectedClipIds(selection)), [selection])
  const showEnergy = useUi((s) => s.showEnergy)
  const showGrid = useUi((s) => s.showGrid)
  const [snapLine, setSnapLine] = useState<number | null>(null)
  // Where a dragged section edge is, shown beside it.
  const [edgeTime, setEdgeTime] = useState<number | null>(null)
  const nudgeEnd = useRef(0)
  // While a clip drag holds the lane heights, and where it can't drop.
  const [frozenKinds, setFrozenKinds] = useState<ReadonlyMap<string, LaneKind> | null>(null)
  const [refusedDrop, setRefusedDrop] = useState<{
    label: string
    /** The box of the clip that can't drop, which carries the label. */
    labelAt: number
    boxes: { top: number; height: number; start: number; duration: number }[]
  } | null>(null)
  const [view, setView] = useState({ t0: 0, t1: 120 })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<MediaDropHint | null>(null)

  const tool = useUi((s) => s.tool)
  const empty = !hasSong(project)
  const analysis = songAnalysis(project)
  const bpm = bpmOf(project)
  const grid = beatGrid(project)
  const bars = useBars().status
  const sections = sectionsOf(project)
  const lines = lyricLines(project)
  const duration = empty ? 90 : timelineDuration(project)
  const contentW = duration * pps + 120
  const stems = separatedStems(project)
  const stemTrack = songStemTrack(project)
  const mix = stemMix(project)
  const unplayable = useUnplayableStem(project)
  const timingLyrics = runningJobs(useJobs()).some((j) => j.kind === JOB_KINDS.lyrics)

  const lanes = project.tracks.map((t) => {
    const kind = frozenKinds?.get(t.id) ?? laneKind(project, t)
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
      : null
  const tracksH = lanes.reduce((a, l) => a + l.height, 0)
  const lanesH = tracksH + stems.length * stemH
  const totalH = RULER_H + (empty ? 0 : SONG_H) + lanesH

  const ruler = useMemo(() => makeRuler(grid), [grid])
  const beatLines = useMemo(() => makeBeatLines(grid), [grid])
  const boundaries = useMemo(() => sectionBoundaries(sections, duration), [sections, duration])
  const energyDraw = useMemo(() => makeEnergy(analysis?.energy), [analysis?.energy])
  const features = analysis?.features
  const songEnd = (project.songAssetId && project.assets[project.songAssetId]?.duration) || duration
  const songWave = useMemo(
    () =>
      features?.loudness.length
        ? makeWave('#7f91b3', 1, { rate: features.rate, values: features.loudness })
        : makeFlatWave('#7f91b3', songEnd),
    [features, songEnd],
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

  /** A media drop point, snapped like a clip drag. */
  const dropTime = (trackId: string, t: number) => {
    const edges = clipsOnTrack(project, trackId).flatMap((c) => [c.start, c.start + c.duration])
    return Math.max(
      0,
      snapTime(
        t,
        pps,
        grid,
        edges,
        sections.flatMap((x) => [x.start, x.end]),
      ).t,
    )
  }

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
    // React bubbles events from portals (a marker's menu) through the ruler; those would capture the pointer here.
    if (!lane.contains(e.target as Node)) return
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
      if (get().tool === 'split') {
        const content = contentRef.current
        if (!content) return
        const scale = get().pxPerSec
        const at = (e.clientX - content.getBoundingClientRect().left - HEADER_W) / scale
        const p = editor.getProject()
        const edges = clipsOnTrack(p, clip.trackId)
          .filter((c) => c.id !== clip.id)
          .flatMap((c) => [c.start, c.start + c.duration])
        const sectionEdges = sectionsOf(p).flatMap((s) => [s.start, s.end])
        splitClipAt(clip.id, snapTime(at, scale, grid, edges, sectionEdges).t)
        return
      }
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
      // Lyric chips in the selection stay with their sung lines; the other clips move.
      const moving = (group ? picked : [clip.id]).flatMap((id) => {
        const c = p.clips[id]
        return c && !isLyricClip(c) ? [c] : []
      })
      const staying = group && picked.some((id) => isLyricClip(p.clips[id]))
      const locked = p.tracks.find((t) => t.locked && moving.some((c) => c.trackId === t.id))
      if (locked) {
        toast(`The ${locked.name} track is locked. Unlock it to edit.`)
        return
      }
      const movingIds = new Set(moving.map((c) => c.id))
      const spansOn = new Map<string, Span[]>()
      /** The clips that stay on a track. */
      const othersOn = (trackId: string) => {
        let spans = spansOn.get(trackId)
        if (!spans) {
          spans = clipsOnTrack(p, trackId)
            .filter((o) => !movingIds.has(o.id))
            .map((o) => ({ start: o.start, end: o.start + o.duration }))
          spansOn.set(trackId, spans)
        }
        return spans
      }
      // A trim stops at the clip's neighbors.
      const own = othersOn(clip.trackId)
      const edges = own.flatMap((o) => [o.start, o.end])
      const min = own.filter((o) => o.end <= self.start + 0.001).reduce((a, o) => Math.max(a, o.end), 0)
      const max = own
        .filter((o) => o.start >= self.start + self.duration - 0.001)
        .reduce((a, o) => Math.min(a, o.start), duration)
      const trackIndex = new Map(p.tracks.map((t, i) => [t.id, i]))
      const rowOf = (c: Clip) => trackIndex.get(c.trackId) ?? 0
      // A group keeps each clip's distance in tracks from the grabbed one, as far as the track list allows.
      const minRows = -Math.min(...moving.map(rowOf))
      const maxRows = p.tracks.length - 1 - Math.max(...moving.map(rowOf))
      const lo = -Math.min(...moving.map((c) => c.start))
      const hi = Math.max(0, duration - Math.max(...moving.map((c) => c.start + c.duration)))
      const grabbedFirst = [self, ...moving.filter((c) => c !== self)]
      const sectionEdges = sectionsOf(p).flatMap((s) => [s.start, s.end])
      const key = `drag:${e.pointerId}:${clip.id}:${Date.now()}`
      const x0 = e.clientX
      const y0 = e.clientY
      let moved = false
      let rows: TrackRow[] = []
      let refused: DropRefusal | null = null
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - x0
        if (!moved && Math.hypot(dx, ev.clientY - y0) < 3) return
        moved = true
        const scale = get().pxPerSec
        const dt = dx / scale
        if (mode === 'move') {
          if (!rows.length) {
            // Lane heights stay as they were until the drop, so a clip changing tracks never moves the lanes under
            // the pointer.
            const kinds = new Map(p.tracks.map((t) => [t.id, laneKind(p, t)]))
            setFrozenKinds(kinds)
            rows = trackRows(p, !hasSong(p), kinds)
          }
          const y = ev.clientY - (contentRef.current?.getBoundingClientRect().top ?? 0)
          const under = rows.findIndex((r) => y < r.top + r.height)
          const offset = Math.min(
            maxRows,
            Math.max(minRows, (under < 0 ? rows.length - 1 : under) - rowOf(self)),
          )
          const trackFor = (c: Clip) => p.tracks[rowOf(c) + offset] as Track
          const near = othersOn(trackFor(self).id).flatMap((o) => [o.start, o.end])
          const r = snapTime(clip.start + dt, scale, grid, near, sectionEdges)
          let refusal: DropRefusal | null = null
          let refusedAt = -1
          for (const [i, c] of grabbedFirst.entries()) {
            refusal = refuseTrack(p, c, trackFor(c), movingIds)
            if (refusal) {
              refusedAt = i
              break
            }
          }
          const spans = grabbedFirst.map((c) => ({
            start: c.start,
            end: c.start + c.duration,
            others: othersOn(trackFor(c).id),
          }))
          const place = refusal ? null : dropShift(spans, r.t - clip.start, dt, BUTT_PX / scale, lo, hi)
          if (!place) {
            // The clips go back to where they started until the pointer finds a place they can drop.
            if (!refused) editor.cancelGesture(key)
            refused = refusal ?? { reason: 'room' }
            setSnapLine(null)
            const shift = Math.min(hi, Math.max(lo, dt))
            if (!refusal) refusedAt = blockedAt(spans, shift)
            setRefusedDrop({
              label: refusalLabel(refused),
              labelAt: Math.max(0, refusedAt),
              boxes: grabbedFirst.map((c) => {
                const row = rows[rowOf(c) + offset] as TrackRow
                return { top: row.top, height: row.height, start: c.start + shift, duration: c.duration }
              }),
            })
            return
          }
          if (refused) {
            refused = null
            setRefusedDrop(null)
          }
          setSnapLine(
            place.edge ??
              (r.snapped !== null && Math.abs(r.snapped - (clip.start + place.shift)) < 0.001
                ? r.snapped
                : null),
          )
          dispatch(
            {
              type: 'clip.move',
              moves: moving.map((c) => ({
                clipId: c.id,
                start: c.start + place.shift,
                trackId: trackFor(c).id,
              })),
            },
            { coalesceKey: key },
          )
        } else if (mode === 'start') {
          const r = snapTime(clip.start + dt, scale, grid, edges, sectionEdges)
          const start = Math.min(clip.end - 0.25, Math.max(min, r.t))
          setSnapLine(r.snapped)
          dispatch(
            { type: 'clip.trim', clipId: clip.id, start, duration: clip.end - start },
            { coalesceKey: key },
          )
        } else {
          const r = snapTime(clip.end + dt, scale, grid, edges, sectionEdges)
          const end = Math.max(clip.start + 0.25, Math.min(max, r.t))
          setSnapLine(r.snapped)
          dispatch(
            { type: 'clip.trim', clipId: clip.id, start: clip.start, duration: end - clip.start },
            { coalesceKey: key },
          )
        }
      }
      const finish = () => {
        if (refused) setRefusedDrop(null)
        if (rows.length) setFrozenKinds(null)
        setSnapLine(null)
        if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('keydown', onKey, true)
      }
      const up = () => {
        if (refused) toast(refusalToast(p, refused))
        else editor.endGesture()
        finish()
        if (!moved && group) select({ type: 'clip', id: clip.id })
        // The chips didn't follow the drag, so say why they stayed.
        if (moved && staying && !refused)
          toast(`Moved ${plural(moving.length, 'clip')}. Lyric lines stay with the vocals.`)
      }
      // Esc puts the clips back and ends the drag; captured before the global Esc deselects.
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        if (!refused) editor.cancelGesture(key)
        finish()
      }
      // On the window: a clip that changes tracks is drawn by a new element, and the old one loses the pointer.
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('keydown', onKey, true)
    },
    [grid, duration],
  )

  /** Dragging a section boundary: snaps to the beat grid and the playhead, and stops short of the neighbors. */
  const startEdgeDrag = (e: React.PointerEvent<HTMLElement>, b: SectionBoundary) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    const owner = b.after ?? b.before
    if (owner) select({ type: 'section', id: owner.id })
    const key = `section-edge:${e.pointerId}:${e.timeStamp}`
    const x0 = e.clientX
    let moved = false
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      const scale = get().pxPerSec
      const r = snapTime(b.t + dx / scale, scale, grid, [], [])
      const t = Math.min(b.max, Math.max(b.min, r.t))
      setSnapLine(r.snapped !== null && Math.abs(r.snapped - t) < 0.001 ? r.snapped : null)
      setEdgeTime(t)
      moveBoundary(b, t, key)
    }
    const up = () => {
      editor.endGesture()
      setSnapLine(null)
      setEdgeTime(null)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  /** Left and right arrows move a boundary to the previous or next beat (bar with Shift). */
  const nudgeEdge = (e: React.KeyboardEvent, b: SectionBoundary) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    // The arrows otherwise move the playhead.
    e.preventDefault()
    e.stopPropagation()
    const dir = e.key === 'ArrowLeft' ? -1 : 1
    let t = b.t + dir * (e.shiftKey ? 1 : 0.1)
    if (grid) {
      // Shift moves a bar: to the next bar start, or four beats until the bars are found.
      const byBar = e.shiftKey && grid.detectedBars
      const events = byBar ? grid.downbeats : grid.beats
      const steps = e.shiftKey && !byBar ? grid.beatsPerBar : 1
      const i = lastIndexAt(events, b.t + (dir * grid.beat) / 4)
      t = (dir > 0 ? events[i + steps] : events[i - steps + 1]) ?? t
    }
    // A run of nudges, until a pause, is one undo step.
    moveBoundary(b, t, `edge-nudge:${b.before?.id ?? ''}|${b.after?.id ?? ''}`)
    window.clearTimeout(nudgeEnd.current)
    nudgeEnd.current = window.setTimeout(() => editor.endGesture(), 800)
  }

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
    const p = editor.getProject()
    const base = additive ? timelineSelectionIds(p, before) : []
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
          (c) =>
            tracks.has(c.trackId) &&
            (isSelectableClip(c) || isLyricClip(c)) &&
            c.start < t1 &&
            c.start + c.duration > t0,
        )
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id)
      const ids = [...new Set([...base, ...hits])]
      const key = ids.join(',')
      if (key === shown) return
      shown = key
      selectTimelineClips(p, ids)
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

  /** Dragging a track header's grip: a line shows where the track will go among the tracks of its kind. */
  const startTrackDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, track: Track) => {
      if (e.button !== 0) return
      e.preventDefault()
      const content = contentRef.current
      const line = dropRef.current
      if (!content || !line) return
      const grip = e.currentTarget
      const p = editor.getProject()
      const rows = trackRows(p, empty)
      const from = rows.findIndex((r) => r.trackId === track.id)
      const others = rows.filter((_, i) => i !== from)
      const { min, max } = trackMoveRange(p, track.id)
      let target = from
      grip.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        const y = ev.clientY - content.getBoundingClientRect().top
        target = Math.min(max, Math.max(min, others.filter((r) => r.top + r.height / 2 < y).length))
        const below = others[target]
        const last = others[others.length - 1]
        const at = below ? below.top : last ? last.top + last.height : 0
        line.style.transform = `translateY(${at - 1}px)`
        line.hidden = target === from
      }
      const up = () => {
        line.hidden = true
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        grip.removeEventListener('pointercancel', up)
        if (target !== from) moveTrack(track.id, target)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
      grip.addEventListener('pointercancel', up)
    },
    [empty],
  )

  const announce = useCallback((message: string) => {
    const region = announceRef.current
    if (!region) return
    // Emptied first, so the same message twice in a row is read again.
    region.textContent = ''
    requestAnimationFrame(() => {
      region.textContent = message
    })
  }, [])

  const selId = selection.type === 'none' ? null : selection.id
  // Keyframe marks show on the clip only while it is the one selected clip.
  const markedClip =
    selection.type === 'clip' && selectedClipIds(selection).length === 1
      ? project.clips[selection.id]
      : undefined
  const selectedMarks = useMemo(() => (markedClip ? keyframeMarks(markedClip) : undefined), [markedClip])
  const inView = (start: number, end: number) => end >= view.t0 - 4 && start <= view.t1 + 4

  return (
    <div className={styles.root}>
      <Toolbar onFit={fit} bpm={bpm} grid={grid} bars={bars} />
      <div ref={scrollRef} className={`${styles.scroller} scroll`} data-timeline-scroller data-tool={tool}>
        <div
          ref={contentRef}
          className={styles.content}
          style={{ width: HEADER_W + contentW, height: totalH }}
          data-refused={refusedDrop ? '' : undefined}
        >
          <div className={styles.row} style={{ height: RULER_H }}>
            <div className={[styles.header, styles.corner].join(' ')} />
            <div className={styles.ruler} style={{ width: contentW }} onPointerDown={scrubFrom}>
              <ViewportCanvas height={RULER_H} draw={ruler} />
              <Markers markers={project.markers} pps={pps} />
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
                    <ContextMenu
                      key={s.id}
                      onOpenChange={(open) => open && select({ type: 'section', id: s.id })}
                    >
                      <ContextMenuTrigger asChild>
                        <div
                          className={[styles.section, sel && styles.sectionSel].filter(Boolean).join(' ')}
                          style={{
                            left: s.start * pps,
                            width: (s.end - s.start) * pps,
                            ['--sec' as string]: sectionTint(s),
                          }}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            if (e.button === 0) select({ type: 'section', id: s.id })
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
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => set({ playhead: s.start, playing: false })}>
                          Go to its start
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => selectClips(sectionClipIds(editor.getProject(), s))}>
                          Select its clips
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => cutClipsToSection(s.id)}>
                          Cut clips to this section…
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => exportSectionTeaser(s.id)}>
                          Export as a teaser…
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )
                })}
                {boundaries.map((b) => {
                  const name =
                    b.before && b.after
                      ? `Edge between ${sectionName(b.before)} and ${sectionName(b.after)}`
                      : b.after
                        ? `Start of ${sectionName(b.after)}`
                        : `End of ${b.before ? sectionName(b.before) : 'section'}`
                  return (
                    <div
                      key={`${b.before?.id ?? ''}|${b.after?.id ?? ''}`}
                      className={styles.sectionEdge}
                      style={{ left: b.t * pps }}
                      role="slider"
                      tabIndex={0}
                      aria-label={name}
                      aria-orientation="horizontal"
                      aria-valuemin={b.min}
                      aria-valuemax={b.max}
                      aria-valuenow={b.t}
                      aria-valuetext={formatTime(b.t, true)}
                      onPointerDown={(e) => startEdgeDrag(e, b)}
                      onKeyDown={(e) => nudgeEdge(e, b)}
                    />
                  )
                })}
                {edgeTime !== null && (
                  <div className={`${styles.edgeTime} tnum`} style={{ left: edgeTime * pps }}>
                    {formatTime(edgeTime, true)}
                  </div>
                )}
              </div>
            </div>
          )}

          {showGrid && grid && (
            <div
              className={styles.beatLines}
              style={{
                top: RULER_H + (empty ? 0 : SONG_H),
                left: HEADER_W,
                width: contentW,
                height: tracksH,
              }}
            >
              <ViewportCanvas height={tracksH} draw={beatLines} />
            </div>
          )}

          {lanes.map(({ track, kind, height }, index) => {
            const clips = clipsOnTrack(project, track.id)
              .map((c) => viewOf(project, c))
              .filter((c) => inView(c.start, c.end))
            const transitionMarks =
              kind === 'video' || kind === 'overlay'
                ? placeTransitionMarks(project, track.id, pps, selection)
                : undefined
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
                      canMoveUp={index > trackMoveRange(project, track.id).min}
                      canMoveDown={index < trackMoveRange(project, track.id).max}
                      onGripPointerDown={startTrackDrag}
                      onAnnounce={announce}
                      fallback={track.id === stemTrack?.id ? unplayable : null}
                    />
                  </div>
                  <div
                    className={styles.lane}
                    style={{ width: contentW }}
                    data-locked={track.locked || undefined}
                    onPointerDown={startMarquee}
                    onContextMenu={(e) =>
                      openLaneMenu(
                        e,
                        track.id,
                        (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps,
                      )
                    }
                    onDragOver={(e) => {
                      const media = isMediaDrag(e)
                      if (!media && (kind === 'audio' || !isLibraryDrag(e))) return
                      const time = (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps
                      const next = media
                        ? mediaDropHint(track.id, dropTime(track.id, time))
                        : libraryDropHint(track.id, time)
                      // Media lands where it is dropped here, so the editor's "Drop to import" overlay stays away.
                      if (media) e.stopPropagation()
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
                      const time = (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps
                      if (isMediaDrag(e)) {
                        e.preventDefault()
                        e.stopPropagation()
                        setDropHint(null)
                        dropMedia(e, { trackId: track.id, time: dropTime(track.id, time) })
                        return
                      }
                      const item = kind === 'audio' ? null : droppedLibraryItem(e)
                      if (!item) return
                      e.preventDefault()
                      setDropHint(null)
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
                        >
                          {'newTrack' in dropHint && <span className={styles.dropNewTrack}>New track</span>}
                        </div>
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
                          // The line alone, or its chip among several selected clips.
                          const only = selId === lineId
                          const sel = only || selIds.has(c.id)
                          const drag = (e: React.PointerEvent, d: LyricDrag) => {
                            const body = d.type === 'line' && d.edge === 'move'
                            if (body && e.button === 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
                              e.stopPropagation()
                              e.preventDefault()
                              toggleInSelection(c.id)
                            } else if (lineId) onLyricPointerDown(e, lineId, track.id, d)
                            else e.stopPropagation()
                          }
                          return (
                            <div
                              key={c.id}
                              className={[styles.lyric, sel && styles.selected].filter(Boolean).join(' ')}
                              style={{ transform: `translateX(${c.start * pps}px)`, width: w }}
                              role="button"
                              tabIndex={0}
                              aria-label={`Lyric: ${c.name}${line?.check ? CHECK_NAMES[line.check] : ''}`}
                              aria-pressed={sel}
                              aria-keyshortcuts="Enter Shift+Enter"
                              data-space-plays
                              data-lyric-line={lineId}
                              onPointerDown={(e) => drag(e, { type: 'line', edge: 'move' })}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' || !lineId) return
                                e.preventDefault()
                                if (e.shiftKey || e.metaKey || e.ctrlKey) toggleInSelection(c.id)
                                else select({ type: 'lyric', id: lineId })
                              }}
                            >
                              {line?.check && <span className={styles.draftDot} aria-hidden />}
                              <LyricChipContent
                                text={line?.text ?? c.name}
                                words={line?.words ?? []}
                                start={c.start}
                                width={w}
                                pps={pps}
                                selected={only}
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
                              {only && lineId && <LineMatches lineId={lineId} />}
                            </div>
                          )
                        }
                        return (
                          <Fragment key={c.id}>
                            <ClipBlock
                              clip={c}
                              pps={pps}
                              selected={selIds.has(c.id)}
                              marks={markedClip?.id === c.id ? selectedMarks : undefined}
                              onPointerDown={onClipPointerDown}
                            />
                            {transitionMarks?.get(c.id)?.map((m) => (
                              <TransitionMark
                                key={m.edge}
                                mark={m}
                                selected={
                                  selection.type === 'transition' &&
                                  selection.id === m.clipId &&
                                  selection.edge === m.edge
                                }
                              />
                            ))}
                          </Fragment>
                        )
                      })}
                    {suggestTiming && track.id === lyricsTrackId && (
                      <div
                        className={[styles.untimedLayer, suggestLeft === null && styles.untimedPinned]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <div
                          ref={measureSuggest}
                          className={styles.untimedSuggest}
                          style={suggestLeft === null ? undefined : { left: suggestLeft }}
                        >
                          <InlineSuggestion
                            id="time-lyrics"
                            variant="chip"
                            ambient
                            action="Time words to the vocals"
                            onAction={() => openAssist('lyrics')}
                          >
                            {plural(untimed, 'line')} not timed yet
                          </InlineSuggestion>
                        </div>
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
          {refusedDrop?.boxes.map((b, i) => (
            <div
              key={i}
              className={styles.refusedDrop}
              style={{
                transform: `translate(${HEADER_W + b.start * pps}px, ${b.top + 3}px)`,
                width: b.duration * pps,
                height: b.height - 6,
              }}
            >
              {i === refusedDrop.labelAt && <span className={styles.refusedLabel}>{refusedDrop.label}</span>}
            </div>
          ))}
          <div ref={marqueeRef} className={styles.marquee} hidden aria-hidden />
          <div ref={dropRef} className={styles.trackDrop} hidden aria-hidden />
          <div ref={announceRef} className="sr-only" aria-live="polite" />
          <Playhead height={totalH} />
        </div>
      </div>
      <LaneMenu />
    </div>
  )
}
