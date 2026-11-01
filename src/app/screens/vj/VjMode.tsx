import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { ArrowLeft, AudioWaveform, Circle, Film, Pause, Play, Square, Usb } from 'lucide-react'
import { PreviewController } from '../../../engine/preview.ts'
import { pluginRegistry } from '../../../engine/registry.ts'
import type { Asset } from '../../../model/index.ts'
import {
  VjSession,
  clipPadForAsset,
  clipPadForGenerator,
  defaultBindings,
  defaultLayout,
  type ClipSource,
  type MidiStatus,
  type Pad,
  type PadRow,
  type PadView,
  type VjSnapshot,
} from '../../../vj/index.ts'
import { Button } from '../../ds/Button.tsx'
import { Spinner } from '../../ds/Feedback.tsx'
import { Kbd } from '../../ds/Kbd.tsx'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from '../../ds/Menu.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { formatTime, plural } from '../../format.ts'
import { appMedia } from '../../state/media.ts'
import {
  editor,
  sectionAt,
  sectionName,
  sectionsOf,
  sectionTint,
  timelineDuration,
  useProject,
} from '../../state/project.ts'
import { barsState } from '../../state/songAnalysis.ts'
import { useThumbnail } from '../../state/thumbs.ts'
import {
  clearVjEntryFrame,
  leaveVj,
  midiControllers,
  midiDevicesLabel,
  setActiveVjSession,
  SHOWN_AFTER_MS,
  subscribeVjEntryFrame,
  vjEntryFrame,
  vjMidi,
} from '../../state/vj.ts'
import { get, set, toast, useUi } from '../../state/ui.ts'
import styles from './VjMode.module.css'

interface Engine {
  preview: PreviewController
  session: VjSession
}

const noSubscribe = () => () => undefined
const noSnapshot = () => null

function useSnapshot(session: VjSession | undefined): VjSnapshot | null {
  return useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? noSnapshot)
}

function playingOf(preview: PreviewController | undefined): boolean {
  return preview?.getSnapshot().state === 'playing'
}

function usePlaying(preview: PreviewController | undefined): boolean {
  return useSyncExternalStore(preview?.subscribe ?? noSubscribe, () => playingOf(preview))
}

function midiChip(midi: VjSnapshot['midi'] | undefined): string {
  const status: MidiStatus = midi?.status ?? 'off'
  if (status === 'ready' && midi?.devices.length) return midiDevicesLabel(midi.devices)
  if (status === 'requesting') return 'Connecting…'
  if (status === 'denied') return 'MIDI blocked'
  if (status === 'unsupported') return 'No Web MIDI'
  if (status === 'error') return 'MIDI error'
  return 'No MIDI device'
}

/** What a kept take added, or null when it changed nothing. */
function takeSummary(take: VjSnapshot['takes'][number], lined: 'bars' | 'beats'): string | null {
  const s = take.summary
  const parts = s
    ? [
        s.clips ? plural(s.clips, 'clip') : '',
        s.effects ? plural(s.effects, 'effect') : '',
        s.looks ? plural(s.looks, 'look') : '',
      ].filter(Boolean)
    : [plural(take.presses, 'press', 'presses')]
  if (parts.length === 0) return null
  const what = parts.join(', ')
  return take.quantized ? `${what}, lined up with the ${lined}` : what
}

/**
 * Each take is its own undo step ("VJ take N", and "Discard VJ take N" when discarded), so undoing a performance
 * walks back over the visit's takes at the top of the history, stopping at any other edit.
 */
function undoTakes(kept: number): number {
  let removed = 0
  while (removed < kept) {
    const step = /^(Discard )?VJ take \d+$/.exec(editor.undoLabel() ?? '')
    if (!step || !editor.undo()) break
    removed += step[1] ? -1 : 1
  }
  return removed
}

function failedTakeMessage(take: VjSnapshot['takes'][number]): string {
  const why = take.error ? `: ${take.error.replace(/\.$/, '')}` : ''
  return `Take ${take.number} couldn’t be added${why}. The timeline is unchanged.`
}

/** Runs the engine preview and the VJ session on the stage while VJ mode is open. */
function useEngine(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  stageRef: React.RefObject<HTMLDivElement | null>,
  onExit: (session: VjSession) => void,
) {
  const [engine, setEngine] = useState<Engine | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [drawn, setDrawn] = useState(false)
  // A little after the first frame: with a software GPU it reaches the screen a few hundred ms after it is drawn.
  const [shown, setShown] = useState(false)
  const exitEvent = useEffectEvent(onExit)

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const project = editor.getProject()
    const ratio = project.settings.width / project.settings.height
    const fit = () => {
      const r = stage.getBoundingClientRect()
      const width = Math.max(1, Math.floor(Math.min(r.width - 48, (r.height - 16) * ratio)))
      return { width, height: Math.max(1, Math.floor(width / ratio)) }
    }
    let preview: PreviewController
    try {
      preview = new PreviewController({ canvas, media: appMedia })
    } catch (error) {
      console.error('The VJ preview couldn’t start', error)
      toast('The live preview needs WebGL 2. Turn on hardware acceleration in your browser settings.')
      return
    }
    const first = fit()
    setSize(first)
    preview.setViewport(first.width, first.height)
    preview.seek(get().playhead)
    preview.setProject(project)
    const session = new VjSession({ editor, preview, midi: vjMidi(), onExit: () => exitEvent(session) })
    // Each visit starts as a rehearsal: nothing lands on the timeline until Record is on.
    session.setArmed(false)
    const detach = session.attachKeyboard(window)
    let shownTimer = 0
    const offFirstFrame = preview.onFrame(() => {
      setDrawn(true)
      shownTimer = window.setTimeout(() => {
        setShown(true)
        clearVjEntryFrame()
      }, SHOWN_AFTER_MS)
      offFirstFrame()
    })
    const offFrame = preview.onFrame((time) => {
      if (preview.clock.state === 'playing') set({ playhead: time })
    })
    const offState = preview.subscribe(() => {
      const { state, time } = preview.getSnapshot()
      if (state !== 'playing' && get().playhead !== time) set({ playhead: time })
    })
    const ro = new ResizeObserver(() => {
      const next = fit()
      setSize(next)
      preview.setViewport(next.width, next.height)
    })
    ro.observe(stage)
    setEngine({ preview, session })
    setActiveVjSession(session, { preview, canvas })
    return () => {
      setActiveVjSession(null)
      ro.disconnect()
      offFirstFrame()
      offFrame()
      offState()
      detach()
      window.clearTimeout(shownTimer)
      session.close()
      preview.dispose()
      setEngine(null)
      setDrawn(false)
      setShown(false)
    }
  }, [canvasRef, stageRef])

  return { engine, size, drawn, shown }
}

type PadButtonProps = Omit<ComponentProps<'button'>, 'className'> & {
  pad: PadView
  className: string
  art?: string
  learning: boolean
  mapping: boolean
  session: VjSession
}

/** Extra button props come from the slot's context-menu trigger and must reach the button. */
function PadButton({
  pad,
  className,
  art,
  learning,
  mapping,
  session,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  ...rest
}: PadButtonProps) {
  const down = useRef(false)
  const release = (timeStamp: number) => {
    if (!down.current) return
    down.current = false
    session.releasePad(pad.row, pad.index, timeStamp)
  }
  const lit = pad.kind === 'effect' ? pad.active && styles.padHeld : pad.active && styles.padLive
  return (
    <button
      {...rest}
      className={[styles.pad, className, lit, learning && styles.padLearn].filter(Boolean).join(' ')}
      style={art ? { ...rest.style, backgroundImage: `url(${art})` } : rest.style}
      aria-pressed={pad.active}
      aria-label={pad.label}
      title={pad.midi ? `MIDI ${pad.midi}` : undefined}
      onPointerDown={(e) => {
        onPointerDown?.(e)
        if (e.button !== 0) return
        if (mapping) {
          session.learn({ kind: 'pad', row: pad.row, index: pad.index })
          return
        }
        down.current = true
        session.pressPad(pad.row, pad.index, e.timeStamp)
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e)
        release(e.timeStamp)
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e)
        release(e.timeStamp)
      }}
    >
      <span className={styles.padKey}>{pad.key ?? '·'}</span>
      <span className={styles.padName}>{pad.label}</span>
    </button>
  )
}

function AssetPad({ asset, ...props }: Omit<PadButtonProps, 'art'> & { asset: Asset }) {
  const art = useThumbnail(asset)
  return <PadButton {...props} art={art} />
}

function clipArt(source: ClipSource | null | undefined): string | undefined {
  if (source?.type === 'generator')
    return pluginRegistry.catalog().find((e) => e.id === source.generatorId)?.thumbnail
  return undefined
}

/** A clip pad that stays on after release becomes one that shows only while held, and back. */
function toggledTrigger(pad: Pad): Pad {
  if (pad.action.kind !== 'clip') return pad
  return {
    ...pad,
    action: { ...pad.action, trigger: pad.action.trigger === 'latch' ? 'momentary' : 'latch' },
  }
}

/** Right-click menu of a pad slot: what the pad plays, how, and resetting the layout. */
function SlotMenu({
  row,
  index,
  session,
  snapshot,
  children,
}: {
  row: PadRow
  index: number
  session: VjSession
  snapshot: VjSnapshot
  children: ReactNode
}) {
  const project = useProject()
  const layout = session.getLayout()
  const rowPads =
    row === 'clips'
      ? (layout.clipBanks[snapshot.bank.index] ?? [])
      : row === 'effects'
        ? layout.effects
        : layout.looks
  const current = rowPads[index] ?? null
  const put = (pad: Pad | null) => session.setPad(row, index, pad)
  const media = Object.values(project.assets).filter((a) => a.kind === 'video' || a.kind === 'image')
  const visuals = pluginRegistry.catalog().filter((e) => e.kind === 'generator')
  const defaults = defaultLayout(project, pluginRegistry.catalog())
  const missing =
    row === 'clips'
      ? []
      : (row === 'effects' ? defaults.effects : defaults.looks).filter(
          (p): p is Pad => !!p && !rowPads.some((q) => q?.id === p.id),
        )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {/* Media and visuals in submenus: one flat list of both doesn't fit a 720 px window. */}
        {row === 'clips' && media.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={<Film />}>Media</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {media.map((a) => (
                <ContextMenuItem key={a.id} onSelect={() => put(clipPadForAsset(a))}>
                  {a.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {row === 'clips' && visuals.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={<AudioWaveform />}>Visuals</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {visuals.map((v) => (
                <ContextMenuItem key={v.id} onSelect={() => put(clipPadForGenerator(v))}>
                  {v.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {missing.map((p) => (
          <ContextMenuItem key={p.id} onSelect={() => put(p)}>
            {p.label}
          </ContextMenuItem>
        ))}
        {current?.action.kind === 'clip' && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => put(toggledTrigger(current))}>
              {current.action.trigger === 'latch' ? 'Show only while held' : 'Stay on after release'}
            </ContextMenuItem>
          </>
        )}
        {(current || snapshot.layoutCustomized) && <ContextMenuSeparator />}
        {current && (
          <ContextMenuItem danger onSelect={() => put(null)}>
            Clear pad
          </ContextMenuItem>
        )}
        {snapshot.layoutCustomized && (
          <ContextMenuItem onSelect={() => session.resetLayout()}>Reset all pads</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function Deck({
  session,
  snapshot,
  mapping,
}: {
  session: VjSession
  snapshot: VjSnapshot
  mapping: boolean
}) {
  const project = useProject()
  const learning = (pad: PadView) =>
    snapshot.learn?.kind === 'pad' && snapshot.learn.row === pad.row && snapshot.learn.index === pad.index
  const slot = (row: PadRow, pad: PadView | null, index: number, className: string) => {
    const source = pad?.source
    const asset = source?.type === 'asset' ? project.assets[source.assetId] : undefined
    const common = { className, session, mapping }
    const body = !pad ? (
      <button className={[styles.pad, styles.padEmpty, className].join(' ')} aria-label="Empty pad">
        <span className={styles.padKey}>·</span>
        <span className={styles.padName}>Empty</span>
      </button>
    ) : asset ? (
      <AssetPad pad={pad} asset={asset} learning={learning(pad)} {...common} />
    ) : (
      <PadButton pad={pad} art={clipArt(source)} learning={learning(pad)} {...common} />
    )
    return (
      <SlotMenu
        key={`${row}-${snapshot.bank.index}-${index}`}
        row={row}
        index={index}
        session={session}
        snapshot={snapshot}
      >
        {body}
      </SlotMenu>
    )
  }
  const { pads, bank } = snapshot
  return (
    <div className={styles.deck}>
      <div className={styles.deckRow}>
        <div className={styles.deckLabel}>
          Clips{' '}
          {bank.count > 1 ? (
            <Tooltip label="Switch clip banks" shortcut="[ ]">
              <span>
                tap · bank {bank.index + 1} of {bank.count}
              </span>
            </Tooltip>
          ) : (
            <span>tap</span>
          )}
        </div>
        <div className={styles.pads} style={{ gridTemplateColumns: 'repeat(10, minmax(0, 1fr))' }}>
          {pads.clips.map((p, i) => slot('clips', p, i, styles.clipPad))}
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
          {pads.effects.map((p, i) => slot('effects', p, i, styles.fxPad))}
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
          {pads.looks.map((p, i) => slot('looks', p, i, styles.lookPad))}
        </div>
      </div>
    </div>
  )
}

export function VjMode() {
  const project = useProject()
  const playhead = useUi((s) => s.playhead)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [mapping, setMapping] = useState(false)
  const closed = useRef(false)

  /** Esc (or a control mapped to exit) leaves mapping mode first; Back to editor always leaves. */
  const exit = (session: VjSession | undefined, fromSession = false) => {
    if (fromSession && mapping) {
      setMapping(false)
      return
    }
    leaveVj(() => {
      const kept = session && !closed.current ? session.close().kept : 0
      closed.current = true
      if (kept > 0)
        toast(`Performance added to the timeline: ${plural(kept, 'take')}, all editable`, {
          label: 'Undo',
          run: () => {
            const removed = undoTakes(kept)
            toast(removed > 0 ? `Removed ${plural(removed, 'take')} from the timeline` : 'Nothing to undo')
          },
        })
    })
  }

  const { engine, size, drawn, shown } = useEngine(canvasRef, stageRef, (s) => exit(s, true))
  // The editor's frame from when VJ mode opened, shown until the live output shows its own.
  const entryFrame = useSyncExternalStore(subscribeVjEntryFrame, vjEntryFrame)
  const entry = shown ? null : entryFrame
  const showEntry = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !entry) return
      canvas.width = entry.width
      canvas.height = entry.height
      try {
        canvas.getContext('2d')?.drawImage(entry, 0, 0)
      } catch {
        // Closed already: the live output has drawn.
      }
    },
    [entry],
  )
  const session = engine?.session
  const snapshot = useSnapshot(session)
  const playing = usePlaying(engine?.preview)

  // Take review: every take that lands says what it added, and can be discarded right away.
  const announced = useRef(new Set<string>())
  const grid = snapshot?.settings.quantize.grid ?? '1/4'
  useEffect(() => {
    for (const take of snapshot?.takes ?? []) {
      if (announced.current.has(take.id)) continue
      announced.current.add(take.id)
      if (take.status === 'failed') {
        toast(failedTakeMessage(take))
        continue
      }
      if (take.status !== 'kept') continue
      // Nearest bar lines up with beats until the song's bars are found (see vj/quantize.ts).
      const added = takeSummary(take, grid === 'bar' && barsState().status === 'ready' ? 'bars' : 'beats')
      if (!added) {
        toast(`Take ${take.number} changed nothing`)
        continue
      }
      toast(`Take ${take.number} added to the timeline: ${added}`, {
        label: 'Discard',
        run: () => {
          if (closed.current) return
          session?.discardTake(take.id)
          toast(`Take ${take.number} discarded`)
        },
      })
    }
  }, [snapshot?.takes, session, grid])

  useEffect(() => {
    if (snapshot?.error) toast(snapshot.error)
  }, [snapshot?.error])

  const duration = timelineDuration(project)
  const list = sectionsOf(project)
  const sec = sectionAt(project, playhead)
  const armed = snapshot?.transport.armed ?? false
  const togglePlay = () => session?.togglePlay()
  const learnPad = snapshot?.learn?.kind === 'pad' ? snapshot.learn : null
  const learnLabel = learnPad ? snapshot?.pads[learnPad.row][learnPad.index]?.label : undefined

  return (
    <div className={styles.root}>
      <header className={styles.top}>
        <div className={styles.topLeft}>
          <Button variant="ghost" icon={<ArrowLeft />} onClick={() => exit(session)}>
            Back to editor
          </Button>
          <span className={styles.modeLabel}>VJ mode</span>
        </div>
        <div className={styles.topCenter}>
          <span className={styles.songName}>{project.name}</span>
          {sec && (
            <span
              className={styles.secName}
              style={{ color: `color-mix(in srgb, ${sectionTint(sec)} 60%, white)` }}
            >
              {sectionName(sec)}
            </span>
          )}
          <span className={`${styles.time} tnum`}>
            {formatTime(playhead)} / {formatTime(duration)}
          </span>
        </div>
        <div className={styles.topRight}>
          <Menu>
            <Tooltip
              label="MIDI controller"
              description="Connect a controller, then press a pad and a key to map it"
            >
              <MenuTrigger asChild>
                <button className={styles.midi}>
                  <Usb /> {midiChip(snapshot?.midi)}
                </button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent width={260}>
              <MenuLabel>MIDI controller</MenuLabel>
              {snapshot?.midi.status === 'ready' ? (
                snapshot.midi.devices.length ? (
                  midiControllers(snapshot.midi.devices).map((c) => (
                    <MenuItem key={c.ports[0]?.id ?? c.name} disabled description={c.manufacturer}>
                      {c.name}
                    </MenuItem>
                  ))
                ) : (
                  <MenuItem disabled description="Plug one in; it appears here">
                    No controller found
                  </MenuItem>
                )
              ) : snapshot?.midi.status === 'unsupported' ? (
                <MenuItem disabled description="Use desktop Chrome or Edge for MIDI controllers">
                  This browser has no Web MIDI
                </MenuItem>
              ) : snapshot?.midi.status === 'denied' || snapshot?.midi.status === 'error' ? (
                <>
                  <MenuItem disabled description={snapshot.midi.error}>
                    {snapshot.midi.status === 'denied' ? 'MIDI access was blocked' : 'MIDI couldn’t start'}
                  </MenuItem>
                  <MenuItem
                    description={
                      snapshot.midi.status === 'denied'
                        ? 'Allow MIDI devices in the site settings first'
                        : 'Reconnect the controller first'
                    }
                    onSelect={() => void session?.connectMidi()}
                  >
                    Try again
                  </MenuItem>
                </>
              ) : (
                <MenuItem
                  disabled={snapshot?.midi.status === 'requesting'}
                  description="The browser asks for permission once"
                  onSelect={() => void session?.connectMidi()}
                >
                  Connect a MIDI controller
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem
                description="Click a pad, then press a key or a MIDI pad"
                onSelect={() => setMapping(true)}
              >
                Map keys and MIDI pads
              </MenuItem>
              <MenuItem onSelect={() => session?.setBindings(defaultBindings())}>Reset mappings</MenuItem>
            </MenuContent>
          </Menu>
          <Tooltip
            label={armed ? 'Stop recording' : 'Record performance'}
            shortcut="Shift Z"
            description="Everything you trigger lands on the timeline as editable clips and keyframes"
          >
            <button
              className={[styles.rec, armed && styles.recOn].filter(Boolean).join(' ')}
              onClick={() => session?.setArmed(!armed)}
              aria-pressed={armed}
            >
              {armed ? <Square /> : <Circle />}
              {armed ? `Recording · ${plural(snapshot?.transport.presses ?? 0, 'event')}` : 'Record'}
            </button>
          </Tooltip>
        </div>
      </header>

      <div ref={stageRef} className={styles.stage}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ width: size.width, height: size.height }}
          aria-label="Live output"
          aria-busy={!drawn}
          role="img"
        />
        {entry && (
          <canvas
            ref={showEntry}
            className={styles.entryFrame}
            style={{ width: size.width, height: size.height }}
            aria-hidden
          />
        )}
        {!drawn && !entry && (
          <div className={styles.stageNote} role="status">
            <Spinner /> Preparing the live output
          </div>
        )}
        {mapping ? (
          <div className={styles.playHint} role="status">
            {learnLabel
              ? `Press a key or a MIDI pad for “${learnLabel}”`
              : 'Click a pad, then press a key or a MIDI pad to map it.'}{' '}
            <Kbd keys="Esc" /> when done
          </div>
        ) : snapshot?.problem === 'empty' ? (
          <div className={styles.playHint} role="status">
            Add a song or clips to the timeline to perform over them
          </div>
        ) : (
          !playing && (
            <button className={styles.playHint} onClick={togglePlay}>
              <Play /> Press <Kbd keys="Space" /> to play, then hit the keys below
            </button>
          )
        )}
      </div>

      <div className={styles.progress}>
        <button className={styles.playBtn} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause /> : <Play />}
        </button>
        <div className={styles.sections}>
          {list.map((s) => (
            <span
              key={s.id}
              className={styles.sec}
              style={{
                flex: s.end - s.start,
                background: `color-mix(in srgb, ${sectionTint(s)} 40%, transparent)`,
              }}
            >
              <span>{sectionName(s)}</span>
            </span>
          ))}
          <span className={styles.head} style={{ left: `${(playhead / duration) * 100}%` }} />
        </div>
      </div>

      {session && snapshot && <Deck session={session} snapshot={snapshot} mapping={mapping} />}
    </div>
  )
}
