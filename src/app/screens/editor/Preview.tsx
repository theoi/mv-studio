import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AudioLines,
  ChevronDown,
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
  Volume2,
} from 'lucide-react'
import type { PreviewController } from '../../../engine/preview.ts'
import { settingsForAspect, type AspectPreset } from '../../../model/index.ts'
import { Button, IconButton } from '../../ds/Button.tsx'
import { EmptyState, Spinner } from '../../ds/Feedback.tsx'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../../ds/Menu.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { formatTimecode } from '../../format.ts'
import { jumpSection } from '../../state/playback.ts'
import {
  bpmOf,
  dispatch,
  editor,
  hasSong,
  loadSample,
  sectionAt,
  timelineDuration,
  useProject,
} from '../../state/project.ts'
import { set, toast, useUi } from '../../state/ui.ts'
import { openImport } from '../../state/importer.ts'
import { connectPreview, fitStage, selectionOutline } from './stage.ts'
import styles from './Preview.module.css'

const aspects: { value: AspectPreset; desc: string; icon: ReactNode; ratio: number }[] = [
  { value: '16:9', desc: 'Landscape · YouTube', icon: <RectangleHorizontal />, ratio: 16 / 9 },
  { value: '9:16', desc: 'Vertical · Shorts, Reels, TikTok', icon: <RectangleVertical />, ratio: 9 / 16 },
  { value: '1:1', desc: 'Square', icon: <Square />, ratio: 1 },
  { value: '4:5', desc: 'Portrait · feeds', icon: <RectangleVertical />, ratio: 4 / 5 },
]

function SelectionOverlay({ width, height }: { width: number; height: number }) {
  const selection = useUi((s) => s.selection)
  const t = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const project = useProject()
  if (playing || !width) return null
  const corners = selectionOutline(project, selection, t, width, height)
  if (!corners) return null
  return (
    <svg className={styles.overlay} width={width} height={height} aria-hidden>
      <polygon className={styles.selBox} points={corners.map((c) => c.join(',')).join(' ')} />
      {corners.map(([x, y], i) => (
        <rect key={i} className={styles.selHandle} x={x - 3.5} y={y - 3.5} width={7} height={7} />
      ))}
    </svg>
  )
}

type StageStatus = 'loading' | 'ready' | 'failed'

function Stage({ ratio }: { ratio: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<PreviewController | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [status, setStatus] = useState<StageStatus>('loading')

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const { width, height } = editor.getProject().settings
    let connection: ReturnType<typeof connectPreview>
    try {
      connection = connectPreview(canvas, fitStage(wrap, width / height))
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
    return () => {
      offFirstFrame()
      connection.dispose()
      previewRef.current = null
    }
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const layout = () => {
      const size = fitStage(wrap, ratio)
      setSize(size)
      previewRef.current?.setViewport(size.width, size.height)
    }
    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [ratio])

  return (
    <div ref={wrapRef} className={styles.stage}>
      <div className={styles.frame} style={{ width: size.width, height: size.height }}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Video preview"
          aria-busy={status === 'loading'}
          role="img"
        />
        {status === 'ready' && <SelectionOverlay width={size.width} height={size.height} />}
        {status === 'loading' && (
          <div className={styles.stageNote}>
            <Spinner /> Preparing the preview
          </div>
        )}
        {status === 'failed' && (
          <div className={styles.stageNote}>
            The preview needs WebGL 2. Turn on hardware acceleration in your browser settings.
          </div>
        )}
      </div>
    </div>
  )
}

function Timecode() {
  const t = useUi((s) => s.playhead)
  const project = useProject()
  return (
    <span className={`${styles.timecode} tnum`}>
      <span className={styles.tcNow}>{formatTimecode(t)}</span>
      <span className={styles.tcTotal}> / {formatTimecode(timelineDuration(project))}</span>
    </span>
  )
}

function Position() {
  const t = useUi((s) => s.playhead)
  const project = useProject()
  const sec = sectionAt(project, t)
  const beat = 60 / (bpmOf(project) ?? 120)
  const bar = Math.floor(t / (beat * 4)) + 1
  const beatInBar = Math.floor((t % (beat * 4)) / beat) + 1
  return (
    <Tooltip label="Where you are in the song" description={`Bar ${bar}, beat ${beatInBar}`}>
      <span className={`${styles.position} tnum`}>
        <span className={styles.posSection}>{sec?.label}</span>
        <span>Bar {bar}</span>
      </span>
    </Tooltip>
  )
}

export function Preview() {
  const playing = useUi((s) => s.playing)
  const starting = useUi((s) => s.starting)
  const project = useProject()
  const empty = !hasSong(project)
  const current = aspects.find((a) => a.value === project.settings.aspect) ?? aspects[0]!

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
                onSelect={() => {
                  dispatch({
                    type: 'project.updateSettings',
                    settings: settingsForAspect(a.value, project.settings.fps),
                  })
                  if (a.value !== '16:9')
                    toast(`Switched to ${a.value}. Keep subjects in frame?`, {
                      label: 'Reframe automatically',
                      run: () => toast('Clips reframed around their subjects'),
                    })
                }}
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
        <span className={styles.zoom}>Fit</span>
        <div className={styles.headerSpacer} />
        {!empty && <Position />}
      </div>

      {empty ? (
        <div className={styles.emptyStage}>
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
      ) : (
        <Stage ratio={current.ratio} />
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
          <IconButton label="Loop playback" shortcut="Mod L">
            <Repeat />
          </IconButton>
          <IconButton label="Volume">
            <Volume2 />
          </IconButton>
          <IconButton label="Full-screen preview" shortcut="F">
            <Maximize2 />
          </IconButton>
        </div>
      </div>
    </>
  )
}
