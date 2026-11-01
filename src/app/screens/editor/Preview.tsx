import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  AudioLines,
  Check,
  ChevronDown,
  ImageDown,
  Maximize2,
  Pause,
  Play,
  RectangleHorizontal,
  RectangleVertical,
  Repeat,
  SkipBack,
  SkipForward,
  Square,
  Upload,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { PreviewController } from '../../../engine/preview.ts'
import { BARS_NOTES, type AspectPreset, type Project } from '../../../model/index.ts'
import { Button, IconButton } from '../../ds/Button.tsx'
import { EmptyState, Spinner } from '../../ds/Feedback.tsx'
import { Slider } from '../../ds/Fields.tsx'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '../../ds/Menu.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../ds/Popover.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { formatTimecode } from '../../format.ts'
import { jumpSection } from '../../state/playback.ts'
import { setPref, usePrefs } from '../../state/prefs.ts'
import {
  isFullscreen,
  loopRange,
  PREVIEW_ZOOMS,
  setFullscreenTarget,
  subscribeFullscreen,
  toggleFullscreen,
  toggleLoop,
  zoomLabel,
} from '../../state/previewControls.ts'
import { saveFrame } from '../../state/stills.ts'
import {
  editor,
  hasSong,
  loadSample,
  sectionAt,
  sectionName,
  timelineDuration,
  useProject,
} from '../../state/project.ts'
import { barPosition, songBeatsOnTimeline, useBars, type BarsState } from '../../state/songAnalysis.ts'
import { get, set, toast, useUi } from '../../state/ui.ts'
import { openImport } from '../../state/importer.ts'
import { usePick } from '../../state/pick.ts'
import { changeAspect } from '../../state/reframe.ts'
import { clearVjReturnFrame, SHOWN_AFTER_MS, subscribeVjReturnFrame, vjReturnFrame } from '../../state/vj.ts'
import { PickOverlay } from './PickOverlay.tsx'
import type { Rect } from './handles.ts'
import { SelectionOverlay } from './SelectionOverlay.tsx'
import { connectPreview, fitStage } from './stage.ts'
import styles from './Preview.module.css'

const aspects: { value: AspectPreset; desc: string; icon: ReactNode; ratio: number }[] = [
  { value: '16:9', desc: 'Landscape · YouTube', icon: <RectangleHorizontal />, ratio: 16 / 9 },
  { value: '9:16', desc: 'Vertical · Shorts, Reels, TikTok', icon: <RectangleVertical />, ratio: 9 / 16 },
  { value: '1:1', desc: 'Square', icon: <Square />, ratio: 1 },
  { value: '4:5', desc: 'Portrait · feeds', icon: <RectangleVertical />, ratio: 4 / 5 },
]

/** One value of the project, re-rendering only when it changes (not on every edit, such as each step of a drag). */
function useProjectValue<T extends string | number | boolean>(select: (p: Project) => T): T {
  return useSyncExternalStore(editor.subscribe, () => select(editor.getProject()))
}

type StageStatus = 'loading' | 'ready' | 'failed' | 'stopped'

/** More restarts than this within the window and the stage stops trying and asks for a reload. */
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 120_000
/** How long the frame from VJ mode takes to fade out (`.returnFrame`'s transition). */
const RETURN_FADE_MS = 200

function Stage({ ratio, projectWidth }: { ratio: number; projectWidth: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<PreviewController | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const sizeRef = useRef(size)
  const [status, setStatus] = useState<StageStatus>('loading')
  // Each preview gets a fresh canvas (the canvas key): a canvas handed to a render worker that died can't draw again.
  const [generation, setGeneration] = useState(0)
  const restarts = useRef<number[]>([])
  const centerNext = useRef(false)
  const frameRef = useRef<HTMLDivElement>(null)
  // The part of the stage on screen, in frame pixels (scrolled when zoomed in), for the handles.
  const [view, setView] = useState<Rect | null>(null)
  const measureView = useCallback(() => {
    const wrap = wrapRef.current
    const frame = frameRef.current
    if (!wrap || !frame) return
    const next = {
      x: wrap.scrollLeft - frame.offsetLeft,
      y: wrap.scrollTop - frame.offsetTop,
      width: wrap.clientWidth,
      height: wrap.clientHeight,
    }
    setView((v) =>
      v && v.x === next.x && v.y === next.y && v.width === next.width && v.height === next.height ? v : next,
    )
  }, [])
  const picking = usePick((s) => !!s.request)
  const zoom = useUi((s) => s.previewZoom)
  const full = useSyncExternalStore(subscribeFullscreen, () => isFullscreen(wrapRef.current))
  const zoomed = zoom !== 'fit' && !full
  // Back from VJ mode: its last frame stands in until this preview shows its own, instead of "Preparing the preview".
  const returnFrame = useSyncExternalStore(subscribeVjReturnFrame, vjReturnFrame)
  const returnBitmap = returnFrame === 'pending' ? null : returnFrame
  const [returnFading, setReturnFading] = useState(false)
  const drawReturn = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !returnBitmap) return
      canvas.width = returnBitmap.width
      canvas.height = returnBitmap.height
      try {
        canvas.getContext('2d')?.drawImage(returnBitmap, 0, 0)
      } catch {
        // Closed already: this preview has shown its own frame.
      }
    },
    [returnBitmap],
  )

  useEffect(() => {
    if (status === 'loading') return
    if (status !== 'ready') {
      clearVjReturnFrame()
      return
    }
    // A frame with a look or pad on differs from this one: fading reads as the performance coming off the picture.
    let faded = 0
    const timer = window.setTimeout(() => {
      setReturnFading(true)
      faded = window.setTimeout(clearVjReturnFrame, RETURN_FADE_MS)
    }, SHOWN_AFTER_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(faded)
    }
  }, [status])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let connection: ReturnType<typeof connectPreview>
    try {
      // The size the layout effect below measured before this ran (or a zoom level or full screen set).
      connection = connectPreview(canvas, sizeRef.current)
    } catch (error) {
      console.error('The preview could not start', error)
      void Promise.resolve().then(() => setStatus('failed'))
      return
    }
    previewRef.current = connection.preview
    const offFirstFrame = connection.preview.onFrame(() => {
      setStatus('ready')
      offFirstFrame()
    })
    const offStopped = connection.preview.subscribe(() => {
      if (!connection.preview.getSnapshot().error) return
      offStopped()
      const now = Date.now()
      restarts.current = [...restarts.current.filter((t) => now - t < RESTART_WINDOW_MS), now]
      if (restarts.current.length > MAX_RESTARTS) {
        setStatus('stopped')
        return
      }
      if (restarts.current.length > 1)
        toast('The preview restarted. If it keeps happening, close other tabs to free memory.')
      setStatus('loading')
      setGeneration((g) => g + 1)
    })
    return () => {
      offFirstFrame()
      offStopped()
      connection.dispose()
      previewRef.current = null
    }
  }, [generation])

  useEffect(() => {
    setFullscreenTarget(wrapRef.current)
    return () => setFullscreenTarget(null)
  }, [])

  // Sized before the first paint: the observer's first report comes after it, which left one paint with no stage.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    centerNext.current = zoomed
    const layout = () => {
      const next = zoomed
        ? { width: Math.round(projectWidth * zoom), height: Math.round((projectWidth * zoom) / ratio) }
        : fitStage(wrap, ratio, full ? 0 : undefined)
      const prev = sizeRef.current
      if (next.width !== prev.width || next.height !== prev.height) {
        sizeRef.current = next
        setSize(next)
        previewRef.current?.setViewport(next.width, next.height)
      }
      measureView()
    }
    layout()
    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [ratio, zoom, zoomed, projectWidth, full, measureView])

  // A new zoom level opens on the middle of the frame.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !centerNext.current) return
    centerNext.current = false
    wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2
    wrap.scrollTop = (wrap.scrollHeight - wrap.clientHeight) / 2
  }, [size])

  useLayoutEffect(() => measureView(), [size, zoomed, full, measureView])

  return (
    <div
      ref={wrapRef}
      className={[styles.stage, zoomed && styles.zoomed].filter(Boolean).join(' ')}
      tabIndex={-1}
      onScroll={measureView}
    >
      <div ref={frameRef} className={styles.frame} style={{ width: size.width, height: size.height }}>
        <canvas
          key={generation}
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Video preview"
          aria-busy={status === 'loading'}
          role="img"
        />
        {status === 'ready' && !full && (
          <SelectionOverlay width={size.width} height={size.height} view={view} />
        )}
        {status === 'ready' && picking && <PickOverlay width={size.width} height={size.height} />}
        {returnBitmap && (
          <canvas
            ref={drawReturn}
            className={[styles.returnFrame, returnFading && styles.returnFrameOut].filter(Boolean).join(' ')}
            aria-hidden
          />
        )}
        {status === 'loading' && !returnBitmap && (
          <div className={styles.stageNote}>
            <Spinner /> Preparing the preview
          </div>
        )}
        {status === 'failed' && (
          <div className={styles.stageNote}>
            The preview needs WebGL 2. Turn on hardware acceleration in your browser settings.
          </div>
        )}
        {status === 'stopped' && (
          <div className={[styles.stageNote, styles.stageNoteStack].join(' ')} role="alert">
            <span>
              The preview keeps stopping, most likely because the browser is short on memory. Close other
              tabs, then reload. Your project is saved.
            </span>
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function Timecode() {
  const t = useUi((s) => s.playhead)
  const duration = useProjectValue(timelineDuration)
  return (
    <span className={`${styles.timecode} tnum`}>
      <span className={styles.tcNow}>{formatTimecode(t)}</span>
      <span className={styles.tcTotal}> / {formatTimecode(duration)}</span>
    </span>
  )
}

/** What the position readout says about bars when it cannot count them. */
const BARS_NOTE: Record<BarsState['status'], string | undefined> = {
  ready: BARS_NOTES.beforeFirstBar,
  finding: BARS_NOTES.finding,
  unavailable: BARS_NOTES.notFound,
  none: undefined,
}

/** The section at the playhead, and the bar once the song's bars are found (never a bar guessed from the tempo). */
function Position() {
  const t = useUi((s) => s.playhead)
  const project = useProject()
  const bars = useBars()
  const beats = useMemo(() => songBeatsOnTimeline(project), [project])
  const sec = sectionAt(project, t)
  const place = bars.status === 'ready' ? barPosition(bars.downbeats, beats, t) : null
  return (
    <Tooltip
      label="Where you are in the song"
      description={place ? `Bar ${place.bar}, beat ${place.beat}` : BARS_NOTE[bars.status]}
    >
      <span className={`${styles.position} tnum`}>
        <span className={styles.posSection}>{sec && sectionName(sec)}</span>
        {place && <span>Bar {place.bar}</span>}
      </span>
    </Tooltip>
  )
}

function ZoomMenu({ disabled }: { disabled: boolean }) {
  const zoom = useUi((s) => s.previewZoom)
  return (
    <Menu>
      <Tooltip label="Preview zoom">
        <MenuTrigger asChild>
          <button className={styles.zoom} disabled={disabled} aria-label={`Preview zoom: ${zoomLabel(zoom)}`}>
            <span>{zoomLabel(zoom)}</span>
            <ChevronDown className={styles.chev} />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent width={150}>
        <MenuLabel>Preview zoom</MenuLabel>
        {(['fit', ...PREVIEW_ZOOMS] as const).map((z) => (
          <MenuItem
            key={z}
            icon={z === zoom ? <Check /> : undefined}
            onSelect={() => set({ previewZoom: z })}
          >
            {zoomLabel(z)}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function LoopButton({ disabled }: { disabled: boolean }) {
  const loop = useUi((s) => s.loop)
  // Names what loops, since a seek into another section moves the loop there without a toast.
  const looping = useUi((s) =>
    s.loop ? (loopRange(editor.getProject(), s.playhead).label ?? 'Whole video') : '',
  )
  return (
    <IconButton
      label={looping ? `Loop playback · ${looping}` : 'Loop playback'}
      shortcut="Mod L"
      active={loop}
      onClick={toggleLoop}
      disabled={disabled}
    >
      <Repeat />
    </IconButton>
  )
}

function VolumeControl() {
  const volume = usePrefs((p) => p.previewVolume)
  const pct = Math.round(volume * 100)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label="Volume">
          {pct === 0 ? <VolumeX /> : pct < 50 ? <Volume1 /> : <Volume2 />}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent title="Volume" side="top" align="end">
        <div className={styles.volume}>
          <Slider
            value={pct}
            onChange={(v) => setPref('previewVolume', v / 100)}
            ariaLabel="Volume"
            valueText={`${pct}%`}
          />
          <span className={`${styles.volumeValue} tnum`}>{pct}%</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function Preview() {
  const playing = useUi((s) => s.playing)
  const starting = useUi((s) => s.starting)
  const empty = useProjectValue((p) => !hasSong(p))
  const aspect = useProjectValue((p) => p.settings.aspect)
  const width = useProjectValue((p) => p.settings.width)
  const height = useProjectValue((p) => p.settings.height)
  const background = useProjectValue((p) => p.settings.backgroundColor)
  const current = aspects.find((a) => a.value === aspect) ?? aspects[0]!
  // Playback goes on while the menu is open: Save frame saves the frame that was right-clicked.
  const menuTime = useRef(0)

  return (
    <>
      <div className={styles.header}>
        <Menu>
          <Tooltip label="Aspect ratio" description="Change the frame for this project">
            <MenuTrigger asChild>
              <button className={styles.aspect}>
                {current.icon}
                <span>{current.value}</span>
                <ChevronDown className={styles.chev} />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuContent width={250}>
            <MenuLabel>Aspect ratio</MenuLabel>
            {aspects.map((a) => (
              <MenuItem
                key={a.value}
                icon={a.icon}
                description={a.desc}
                onSelect={() => changeAspect(a.value)}
              >
                {a.value}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              description="Make extra sizes when exporting"
              onSelect={() => set({ dialog: 'export' })}
            >
              Export in several formats…
            </MenuItem>
          </MenuContent>
        </Menu>
        <ZoomMenu disabled={empty} />
        <div className={styles.headerSpacer} />
        {!empty && <Position />}
      </div>

      {empty ? (
        <div className={styles.emptyStage}>
          <div
            className={styles.emptyFrame}
            style={{ '--ratio': current.ratio, background } as CSSProperties}
            aria-hidden
          />
          <div className={styles.emptyCard}>
            <EmptyState
              icon={<AudioLines />}
              title="Start with a song"
              description="Drop a song file here. Its beats, sections and energy are found in a few seconds."
              action={
                <>
                  <Button variant="primary" icon={<Upload />} onClick={() => openImport('song')}>
                    Import a song
                  </Button>
                  <Button variant="ghost" onClick={loadSample}>
                    Use a sample
                  </Button>
                </>
              }
            />
          </div>
        </div>
      ) : (
        <ContextMenu onOpenChange={(open) => open && (menuTime.current = get().playhead)}>
          {/* display: contents keeps the stage's layout; the menu opens where the pointer is. */}
          <ContextMenuTrigger style={{ display: 'contents' }}>
            <Stage ratio={current.ratio} projectWidth={width} />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              icon={<ImageDown />}
              description={`PNG · ${width} × ${height}`}
              onSelect={() => void saveFrame(menuTime.current)}
            >
              Save frame
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      <div className={styles.transport}>
        <Timecode />
        <div className={styles.controls}>
          <IconButton label="Previous section" shortcut="↑" onClick={() => jumpSection(-1)} disabled={empty}>
            <SkipBack />
          </IconButton>
          <Tooltip label={playing ? 'Pause' : 'Play'} shortcut="Space">
            <button
              className={styles.play}
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={() => set({ playing: !playing })}
              disabled={empty}
            >
              {starting ? <Spinner size={16} /> : playing ? <Pause /> : <Play className={styles.playIcon} />}
            </button>
          </Tooltip>
          <IconButton label="Next section" shortcut="↓" onClick={() => jumpSection(1)} disabled={empty}>
            <SkipForward />
          </IconButton>
        </div>
        <div className={styles.transportRight}>
          <LoopButton disabled={empty} />
          <VolumeControl />
          <IconButton label="Full-screen preview" shortcut="F" onClick={toggleFullscreen} disabled={empty}>
            <Maximize2 />
          </IconButton>
        </div>
      </div>
    </>
  )
}
