import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ArrowLeft, Circle, Pause, Play, Square, Usb } from 'lucide-react'
import { Button } from '../../ds/Button.tsx'
import { Kbd } from '../../ds/Kbd.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { formatTime } from '../../format.ts'
import { sceneThumb, type SceneId } from '../../mock/art.ts'
import {
  bpmOf,
  editor,
  energyAt,
  sectionAt,
  sectionColor,
  sectionKind,
  sectionName,
  sectionsOf,
  songAnalysis,
  timelineDuration,
  useProject,
} from '../../state/project.ts'
import { get, set, toast, useUi } from '../../state/ui.ts'
import { usePlaybackClock } from '../editor/hooks.ts'
import { renderFrame, type FrameInput } from '../editor/render.ts'
import styles from './VjMode.module.css'

const clipPads: { key: string; scene: SceneId; name: string }[] = [
  { key: 'Q', scene: 'city', name: 'Night city' },
  { key: 'W', scene: 'portrait', name: 'Singer' },
  { key: 'E', scene: 'crowd', name: 'Crowd' },
  { key: 'R', scene: 'neon', name: 'Neon grid' },
  { key: 'T', scene: 'tunnel', name: 'Tunnel' },
  { key: 'Y', scene: 'dancer', name: 'Dancer' },
  { key: 'U', scene: 'ocean', name: 'Ocean' },
  { key: 'I', scene: 'rain', name: 'Rain' },
  { key: 'O', scene: 'aurora', name: 'Aurora' },
  { key: 'P', scene: 'sunset', name: 'Sunset' },
]

const fxPads: { key: string; name: string; filter: string }[] = [
  { key: 'A', name: 'Strobe', filter: 'brightness(1.8)' },
  { key: 'S', name: 'RGB split', filter: 'saturate(2) hue-rotate(20deg)' },
  { key: 'D', name: 'Zoom pulse', filter: 'contrast(1.2)' },
  { key: 'F', name: 'Glow', filter: 'brightness(1.25) saturate(1.3)' },
  { key: 'G', name: 'Shake', filter: 'none' },
  { key: 'H', name: 'Invert', filter: 'invert(1)' },
  { key: 'J', name: 'Blur', filter: 'blur(6px)' },
  { key: 'K', name: 'Mono', filter: 'grayscale(1) contrast(1.3)' },
  { key: 'L', name: 'Freeze', filter: 'none' },
]

const looks: { name: string; filter: string }[] = [
  { name: 'Original', filter: '' },
  { name: 'Neon noir', filter: 'contrast(1.2) saturate(1.35) hue-rotate(-12deg)' },
  { name: 'Golden hour', filter: 'sepia(0.4) saturate(1.3) brightness(1.05)' },
  { name: 'VHS', filter: 'saturate(1.5) contrast(0.9)' },
  { name: 'Mono', filter: 'grayscale(1) contrast(1.2)' },
  { name: 'Dream', filter: 'brightness(1.12) saturate(0.85)' },
  { name: 'Ice', filter: 'hue-rotate(160deg) saturate(0.8)' },
  { name: 'Ember', filter: 'sepia(0.6) hue-rotate(-25deg) saturate(1.6)' },
]

/** The live output: the triggered clip with a spectrum overlay, reacting to the song like the editor preview. */
function liveFrame(t: number, scene: SceneId): FrameInput {
  const p = editor.getProject()
  const sec = sectionAt(p, t)
  return {
    t,
    scene,
    clipProgress: (t % 8) / 8,
    overlay: { kind: 'spectrum', progress: 0, id: 'vj-spectrum' },
    energy: energyAt(songAnalysis(p), t),
    beatInterval: 60 / (bpmOf(p) ?? 120),
    sectionKind: sec ? sectionKind(sec) : 'verse',
    behindSubject: false,
    showSelection: false,
  }
}

function without(set: Set<string>, key: string) {
  if (!set.has(key)) return set
  const next = new Set(set)
  next.delete(key)
  return next
}

export function VjMode() {
  usePlaybackClock()
  const project = useProject()
  const playing = useUi((s) => s.playing)
  const playhead = useUi((s) => s.playhead)
  const [live, setLive] = useState(0)
  const [held, setHeld] = useState<Set<string>>(new Set())
  const [look, setLook] = useState(1)
  const [rec, setRec] = useState(false)
  const [events, setEvents] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef(live)
  const drawRef = useRef<() => void>(() => undefined)

  const duration = timelineDuration(project)
  const list = sectionsOf(project)
  const sec = sectionAt(project, playhead)

  const trigger = (i: number) => {
    setLive(i)
    if (rec) setEvents((n) => n + 1)
  }

  const exit = () => {
    set({ screen: 'editor', playing: false })
    if (events > 0)
      toast(`Performance added to the timeline: ${events} changes, all editable`, {
        label: 'Undo',
        run: () => undefined,
      })
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.repeat || e.ctrlKey || e.metaKey) return
    const k = e.key.toUpperCase()
    if (e.key === 'Escape') {
      exit()
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      set({ playing: !get().playing })
      return
    }
    if (k === 'Z' && e.shiftKey) {
      setRec((r) => !r)
      return
    }
    const ci = clipPads.findIndex((p) => p.key === k)
    if (ci >= 0) {
      trigger(ci)
      return
    }
    if (fxPads.some((p) => p.key === k)) {
      setHeld((h) => new Set(h).add(k))
      if (rec) setEvents((n) => n + 1)
      return
    }
    const n = Number(e.key)
    if (n >= 1 && n <= looks.length) setLook(n - 1)
  })

  useEffect(() => {
    const down = (e: KeyboardEvent) => onKeyDown(e)
    const up = (e: KeyboardEvent) => setHeld((h) => without(h, e.key.toUpperCase()))
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !stage || !ctx) return
    let w = 0
    let h = 0
    const draw = () => {
      const pad = clipPads[liveRef.current] ?? clipPads[0]!
      const dpr = canvas.width / Math.max(1, w)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderFrame(ctx, w, h, liveFrame(get().playhead, pad.scene))
    }
    drawRef.current = draw
    const layout = () => {
      const r = stage.getBoundingClientRect()
      w = Math.max(1, Math.floor(Math.min(r.width, (r.height * 16) / 9)))
      h = Math.max(1, Math.floor((w * 9) / 16))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      draw()
    }
    const ro = new ResizeObserver(layout)
    ro.observe(stage)
    const unsub = useUi.subscribe((s, p) => {
      if (s.playhead !== p.playhead) draw()
    })
    void document.fonts?.ready.then(draw)
    return () => {
      ro.disconnect()
      unsub()
    }
  }, [])

  useEffect(() => {
    liveRef.current = live
    drawRef.current()
  }, [live])

  const filter =
    [looks[look]?.filter ?? '', ...[...held].map((k) => fxPads.find((p) => p.key === k)?.filter ?? '')]
      .filter(Boolean)
      .join(' ') || 'none'
  const shake = held.has('G')

  return (
    <div className={styles.root}>
      <header className={styles.top}>
        <div className={styles.topLeft}>
          <Button variant="ghost" icon={<ArrowLeft />} onClick={exit}>
            Back to editor
          </Button>
          <span className={styles.modeLabel}>VJ mode</span>
        </div>
        <div className={styles.topCenter}>
          <span className={styles.songName}>{project.name}</span>
          {sec && (
            <span
              className={styles.secName}
              style={{ color: `color-mix(in srgb, ${sectionColor[sectionKind(sec)]} 60%, white)` }}
            >
              {sectionName(sec)}
            </span>
          )}
          <span className={`${styles.time} tnum`}>
            {formatTime(playhead)} / {formatTime(duration)}
          </span>
        </div>
        <div className={styles.topRight}>
          <Tooltip
            label="MIDI controller"
            description="Connect a controller, then press a pad and a key to map it"
          >
            <button className={styles.midi}>
              <Usb /> No MIDI device
            </button>
          </Tooltip>
          <Tooltip
            label={rec ? 'Stop recording' : 'Record performance'}
            shortcut="Shift Z"
            description="Everything you trigger lands on the timeline as editable clips and keyframes"
          >
            <button
              className={[styles.rec, rec && styles.recOn].filter(Boolean).join(' ')}
              onClick={() => setRec(!rec)}
              aria-pressed={rec}
            >
              {rec ? <Square /> : <Circle />}
              {rec ? `Recording · ${events} events` : 'Record'}
            </button>
          </Tooltip>
        </div>
      </header>

      <div ref={stageRef} className={styles.stage}>
        <canvas
          ref={canvasRef}
          className={[styles.canvas, shake && styles.shake].filter(Boolean).join(' ')}
          style={{ filter }}
          aria-label="Live output"
          role="img"
        />
        {!playing && (
          <button className={styles.playHint} onClick={() => set({ playing: true })}>
            <Play /> Press <Kbd keys="Space" /> to play, then hit the keys below
          </button>
        )}
      </div>

      <div className={styles.progress}>
        <button
          className={styles.playBtn}
          onClick={() => set({ playing: !playing })}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause /> : <Play />}
        </button>
        <div className={styles.sections}>
          {list.map((s) => (
            <span
              key={s.id}
              className={styles.sec}
              style={{
                flex: s.end - s.start,
                background: `color-mix(in srgb, ${sectionColor[sectionKind(s)]} 40%, transparent)`,
              }}
            >
              <span>{sectionName(s)}</span>
            </span>
          ))}
          <span className={styles.head} style={{ left: `${(playhead / duration) * 100}%` }} />
        </div>
      </div>

      <div className={styles.deck}>
        <div className={styles.deckRow}>
          <div className={styles.deckLabel}>
            Clips <span>tap</span>
          </div>
          <div className={styles.pads} style={{ gridTemplateColumns: 'repeat(10, minmax(0, 1fr))' }}>
            {clipPads.map((p, i) => (
              <button
                key={p.key}
                className={[styles.pad, styles.clipPad, live === i && styles.padLive]
                  .filter(Boolean)
                  .join(' ')}
                style={{ backgroundImage: `url(${sceneThumb(p.scene)})` }}
                onClick={() => trigger(i)}
                aria-pressed={live === i}
              >
                <span className={styles.padKey}>{p.key}</span>
                <span className={styles.padName}>{p.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.deckRow}>
          <div className={styles.deckLabel}>
            Effects <span>hold</span>
          </div>
          <div
            className={styles.pads}
            style={{ gridTemplateColumns: 'repeat(9, minmax(0, 1fr)) minmax(0, 1fr)' }}
          >
            {fxPads.map((p) => (
              <button
                key={p.key}
                className={[styles.pad, styles.fxPad, held.has(p.key) && styles.padHeld]
                  .filter(Boolean)
                  .join(' ')}
                onPointerDown={() => setHeld((h) => new Set(h).add(p.key))}
                onPointerUp={() => setHeld((h) => without(h, p.key))}
                onPointerLeave={() => setHeld((h) => without(h, p.key))}
                aria-pressed={held.has(p.key)}
              >
                <span className={styles.padKey}>{p.key}</span>
                <span className={styles.padName}>{p.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.deckRow}>
          <div className={styles.deckLabel}>
            Looks <span>switch</span>
          </div>
          <div
            className={styles.pads}
            style={{ gridTemplateColumns: 'repeat(8, minmax(0, 1fr)) minmax(0, 2fr)' }}
          >
            {looks.map((l, i) => (
              <button
                key={l.name}
                className={[styles.pad, styles.lookPad, look === i && styles.padLive]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setLook(i)}
                aria-pressed={look === i}
              >
                <span className={styles.padKey}>{i + 1}</span>
                <span className={styles.padName}>{l.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
