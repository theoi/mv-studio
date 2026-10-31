import { useEffect, useRef, type ReactNode } from 'react'
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
import { settingsForAspect, type AspectPreset } from '../../../model/index.ts'
import { Button, IconButton } from '../../ds/Button.tsx'
import { EmptyState } from '../../ds/Feedback.tsx'
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
import { get, set, toast, useUi } from '../../state/ui.ts'
import { describeFrame, renderFrame } from './render.ts'
import styles from './Preview.module.css'

const aspects: { value: AspectPreset; desc: string; icon: ReactNode; ratio: number }[] = [
  { value: '16:9', desc: 'Landscape · YouTube', icon: <RectangleHorizontal />, ratio: 16 / 9 },
  { value: '9:16', desc: 'Vertical · Shorts, Reels, TikTok', icon: <RectangleVertical />, ratio: 9 / 16 },
  { value: '1:1', desc: 'Square', icon: <Square />, ratio: 1 },
  { value: '4:5', desc: 'Portrait · feeds', icon: <RectangleVertical />, ratio: 4 / 5 },
]

function Stage({ ratio }: { ratio: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return
    let cssW = 0
    let cssH = 0
    const draw = () => {
      const s = get()
      const dpr = canvas.width / Math.max(1, cssW)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderFrame(
        ctx,
        cssW,
        cssH,
        describeFrame(editor.getProject(), s.playhead, {
          behindSubject: s.behindSubject,
          selectedLyricId: s.selection.type === 'lyric' ? s.selection.id : undefined,
          selectedClipId: s.selection.type === 'clip' ? s.selection.id : undefined,
          showSelection: !s.playing,
        }),
      )
    }
    const layout = () => {
      const r = wrap.getBoundingClientRect()
      const pad = 12
      cssW = Math.max(1, Math.floor(Math.min(r.width - pad * 2, (r.height - pad * 2) * ratio)))
      cssH = Math.max(1, Math.floor(cssW / ratio))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      draw()
    }
    let pending = 0
    const schedule = () => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(draw)
    }
    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    const unsubUi = useUi.subscribe((s, prev) => {
      if (
        s.playhead !== prev.playhead ||
        s.selection !== prev.selection ||
        s.behindSubject !== prev.behindSubject ||
        s.playing !== prev.playing
      )
        schedule()
    })
    const unsubProject = editor.subscribe(schedule)
    void document.fonts?.ready.then(draw)
    return () => {
      ro.disconnect()
      unsubUi()
      unsubProject()
      cancelAnimationFrame(pending)
    }
  }, [ratio])

  return (
    <div ref={wrapRef} className={styles.stage}>
      <canvas ref={canvasRef} className={styles.canvas} aria-label="Video preview" role="img" />
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
                <Button variant="primary" icon={<Upload />}>
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
              {playing ? <Pause /> : <Play className={styles.playIcon} />}
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
