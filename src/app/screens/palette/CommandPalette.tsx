import { Command } from 'cmdk'
import { Dialog as RDialog } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  ScissorsLineDashed,
  SquareDashedMousePointer,
  Trash2,
  Upload,
  Scissors,
  Layers,
  Mic2,
  Clapperboard,
  Sparkles,
  Disc3,
  Settings,
  KeyRound,
  Type,
  Magnet,
  Play,
  Undo2,
  Download,
  Users,
  Box,
  Search,
  Palette,
  RectangleVertical,
  Keyboard,
  GraduationCap,
  Wand2,
  Film,
  FolderOpen,
  Save,
  ImageDown,
  Redo2,
  History,
  ZoomIn,
  ZoomOut,
  ChevronsLeftRight,
  PanelLeft,
  Music4,
  Pencil,
  Cpu,
  HardDrive,
  Info,
  Repeat,
  Maximize2,
} from 'lucide-react'
import { useReturnFocus } from '../../ds/focus.ts'
import { Kbd } from '../../ds/Kbd.tsx'
import { plural } from '../../format.ts'
import { ask } from '../../state/ask.ts'
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  hasClipboard,
  paste,
  selectAll,
} from '../../state/clipboard.ts'
import { openImport } from '../../state/importer.ts'
import { downloadProjectFile, openProjectFile, saveNow } from '../../state/persistence.ts'
import { keysOf } from '../../state/keymap.ts'
import { ASK_SCORE, paletteScore } from '../../state/paletteScore.ts'
import { chooseLook, lookItems } from '../../state/library.ts'
import { addTextAtPlayhead, editor, redo, splitAtPlayhead, undo } from '../../state/project.ts'
import { get, openAssist, selectedClipIds, set, toast, useUi, type SettingsPage } from '../../state/ui.ts'
import { toggleFullscreen, toggleLoop } from '../../state/previewControls.ts'
import { changeAspect } from '../../state/reframe.ts'
import { saveFrameFromPalette } from '../../state/stills.ts'
import { fitTimeline, zoomBy } from '../../state/zoom.ts'
import styles from './CommandPalette.module.css'

/** Actions that open a list of choices inside the palette. */
type Page = 'looks' | 'history'

interface Action {
  group: string
  label: string
  icon: ReactNode
  shortcut?: string
  keywords?: string
  /** Other names people search for it by; they rank like its own name. */
  aliases?: string[]
  run?: () => void
  page?: Page
  /**
   * Why the action can't run right now, shown in its row. The row stays in the list and can be highlighted (a
   * disabled cmdk item is skipped by the arrow keys and hides the reason), but Enter does nothing.
   */
  unavailable?: () => string | undefined
}

const settingsPage = (page: SettingsPage) => () => set({ dialog: 'settings', settingsPage: page })

/** Read when the palette renders: the selection doesn't change while it is open. */
const needsClips = () => (selectedClipIds(get().selection).length ? undefined : 'Select clips first')

const actions: Action[] = [
  {
    group: 'Suggested',
    label: 'Export video…',
    icon: <Upload />,
    aliases: ['render'],
    shortcut: keysOf('export'),
    run: () => set({ dialog: 'export' }),
  },
  {
    group: 'Suggested',
    label: 'Time lyrics to the vocals',
    icon: <Mic2 />,
    keywords: 'karaoke words align sync',
    run: () => openAssist('lyrics'),
  },
  {
    group: 'Suggested',
    label: 'Separate stems',
    icon: <Layers />,
    keywords: 'vocals drums bass isolate',
    run: () => openAssist('stems'),
  },
  {
    group: 'Assist',
    label: 'Draft a video with the director',
    icon: <Clapperboard />,
    keywords: 'ai auto generate whole',
    run: () => openAssist('director'),
  },
  {
    group: 'Assist',
    label: 'Cut clips to the beat',
    icon: <Scissors />,
    keywords: 'auto-cut edit rhythm',
    run: () => openAssist('autocut'),
  },
  {
    group: 'Assist',
    label: 'Generate an AI image or clip',
    icon: <Sparkles />,
    keywords: 'fal text to video image',
    run: () => openAssist('generate'),
  },
  {
    group: 'Assist',
    label: 'Put text behind the subject',
    icon: <Users />,
    keywords: 'segment cutout person mask',
    run: () => openAssist('behind'),
  },
  {
    group: 'Assist',
    label: 'Add 3D camera motion to a still',
    icon: <Box />,
    keywords: 'depth parallax',
    run: () => openAssist('camera'),
  },
  {
    group: 'Assist',
    label: 'Song analysis: tempo, beats and sections',
    icon: <Music4 />,
    keywords: 'bpm meter downbeat tap analyze',
    run: () => openAssist('analysis'),
  },
  {
    group: 'Assist',
    label: 'Find matching footage',
    icon: <Search />,
    keywords: 'tags search clips',
    run: () => openAssist('match'),
  },
  {
    group: 'Edit',
    label: 'Undo',
    icon: <Undo2 />,
    shortcut: keysOf('undo'),
    run: undo,
    unavailable: () => (editor.canUndo() ? undefined : 'Nothing to undo'),
  },
  {
    group: 'Edit',
    label: 'Redo',
    icon: <Redo2 />,
    shortcut: keysOf('redo'),
    run: redo,
    unavailable: () => (editor.canRedo() ? undefined : 'Nothing to redo'),
  },
  {
    group: 'Edit',
    label: 'Edit history…',
    icon: <History />,
    keywords: 'undo redo steps back',
    page: 'history',
    unavailable: () => (editor.canUndo() || editor.canRedo() ? undefined : 'No edits yet'),
  },
  {
    group: 'Edit',
    label: 'Split at playhead',
    icon: <Scissors />,
    shortcut: keysOf('split'),
    run: splitAtPlayhead,
  },
  {
    group: 'Edit',
    label: 'Copy',
    icon: <Copy />,
    shortcut: keysOf('copy'),
    run: () => void copySelection(),
    unavailable: needsClips,
  },
  {
    group: 'Edit',
    label: 'Cut',
    icon: <ScissorsLineDashed />,
    shortcut: keysOf('cut'),
    run: () => void cutSelection(),
    unavailable: needsClips,
  },
  {
    group: 'Edit',
    label: 'Paste at playhead',
    icon: <ClipboardPaste />,
    shortcut: keysOf('paste'),
    run: paste,
    unavailable: () => (hasClipboard() ? undefined : 'Copy clips first'),
  },
  {
    group: 'Edit',
    label: 'Duplicate',
    icon: <CopyPlus />,
    shortcut: keysOf('duplicate'),
    run: () => void duplicateSelection(),
    unavailable: needsClips,
  },
  {
    group: 'Edit',
    label: 'Delete',
    icon: <Trash2 />,
    shortcut: keysOf('delete'),
    run: () => void deleteSelection(),
    unavailable: needsClips,
  },
  {
    group: 'Edit',
    label: 'Select all on the track',
    icon: <SquareDashedMousePointer />,
    shortcut: keysOf('selectAll'),
    keywords: 'select every clip',
    run: selectAll,
  },
  { group: 'Edit', label: 'Add text', icon: <Type />, shortcut: keysOf('text'), run: addTextAtPlayhead },
  {
    group: 'Edit',
    label: 'Toggle snapping',
    icon: <Magnet />,
    shortcut: keysOf('snap'),
    run: () => set((s) => ({ snap: !s.snap })),
  },
  {
    group: 'Edit',
    label: 'Apply a look…',
    icon: <Palette />,
    keywords: 'style grade filter restyle',
    page: 'looks',
  },
  {
    group: 'Edit',
    label: 'Import media…',
    icon: <Film />,
    shortcut: keysOf('import'),
    run: () => openImport(),
  },
  {
    group: 'View',
    label: 'Play / pause',
    icon: <Play />,
    shortcut: keysOf('play'),
    run: () => set((s) => ({ playing: !s.playing })),
  },
  { group: 'View', label: 'Zoom in', icon: <ZoomIn />, shortcut: keysOf('zoomIn'), run: () => zoomBy(1.4) },
  {
    group: 'View',
    label: 'Zoom out',
    icon: <ZoomOut />,
    shortcut: keysOf('zoomOut'),
    run: () => zoomBy(1 / 1.4),
  },
  {
    group: 'View',
    label: 'Zoom to fit',
    icon: <ChevronsLeftRight />,
    shortcut: keysOf('zoomFit'),
    keywords: 'whole song timeline',
    run: fitTimeline,
  },
  {
    group: 'View',
    label: 'Show or hide the library',
    icon: <PanelLeft />,
    shortcut: keysOf('library'),
    keywords: 'panel media sidebar',
    run: () => set((s) => ({ libraryOpen: !s.libraryOpen })),
  },
  {
    group: 'View',
    label: 'Loop playback',
    icon: <Repeat />,
    shortcut: keysOf('loop'),
    keywords: 'repeat section',
    run: toggleLoop,
  },
  {
    group: 'View',
    label: 'Full-screen preview',
    icon: <Maximize2 />,
    shortcut: keysOf('fullscreen'),
    run: toggleFullscreen,
  },
  {
    group: 'View',
    label: 'Switch to vertical 9:16',
    icon: <RectangleVertical />,
    keywords: 'aspect ratio shorts reels tiktok',
    run: () => changeAspect('9:16'),
  },
  {
    group: 'View',
    label: 'Open VJ mode',
    icon: <Disc3 />,
    shortcut: keysOf('vj'),
    keywords: 'live perform midi',
    run: () => set({ screen: 'vj' }),
  },
  {
    group: 'Project',
    label: 'Save frame',
    icon: <ImageDown />,
    aliases: ['still', 'screenshot', 'PNG'],
    keywords: 'image picture thumbnail',
    run: () => void saveFrameFromPalette(),
  },
  {
    group: 'Project',
    label: 'Download project file',
    icon: <Download />,
    keywords: 'save backup portable',
    run: () => downloadProjectFile(),
  },
  {
    group: 'Project',
    label: 'Open project file…',
    icon: <FolderOpen />,
    keywords: 'mvstudio restore import backup',
    run: openProjectFile,
  },
  {
    group: 'Project',
    label: 'Save now',
    icon: <Save />,
    shortcut: keysOf('save'),
    keywords: 'save store browser',
    run: () => void saveNow(),
  },
  {
    group: 'Settings',
    label: 'Connect fal.ai',
    icon: <KeyRound />,
    keywords: 'api key cloud settings',
    run: settingsPage('ai'),
  },
  {
    group: 'Settings',
    label: 'Set up an LLM (Ollama, LM Studio, OpenAI)',
    icon: <Wand2 />,
    keywords: 'api key local model settings',
    run: settingsPage('ai'),
  },
  {
    group: 'Settings',
    label: 'Open settings',
    icon: <Settings />,
    aliases: ['preferences', 'options'],
    shortcut: keysOf('settings'),
    keywords: 'general autosave suggestions motion frame rate',
    run: settingsPage('general'),
  },
  {
    group: 'Settings',
    label: 'Editing settings: snapping and durations',
    icon: <Pencil />,
    keywords: 'still text default',
    run: settingsPage('editing'),
  },
  {
    group: 'Settings',
    label: 'This device: AI models and capabilities',
    icon: <Cpu />,
    keywords: 'threads webgpu local download settings',
    run: settingsPage('local'),
  },
  {
    group: 'Settings',
    label: 'VJ and MIDI settings',
    icon: <Disc3 />,
    keywords: 'controller quantize devices',
    run: settingsPage('vj'),
  },
  {
    group: 'Settings',
    label: 'Storage used in this browser',
    icon: <HardDrive />,
    keywords: 'space quota cache delete settings',
    run: settingsPage('storage'),
  },
  {
    group: 'Settings',
    label: 'About MV Studio',
    icon: <Info />,
    keywords: 'version licenses notices settings',
    run: settingsPage('about'),
  },
  {
    group: 'Help',
    label: 'Keyboard shortcuts',
    icon: <Keyboard />,
    aliases: ['hotkeys', 'key bindings', 'keymap'],
    shortcut: keysOf('shortcuts'),
    run: settingsPage('shortcuts'),
  },
  { group: 'Help', label: 'Replay the guide', icon: <GraduationCap />, run: () => set({ guideStep: 0 }) },
]

const ASK_VALUE = 'ask-assist'

const actionScore = (a: Action, search: string) =>
  paletteScore(a.label, a.keywords ? [a.keywords] : [], search, a.aliases)

const actionsByLabel = new Map(actions.map((a) => [a.label, a]))

/** Actions are found by their label; the items of a page carry their name as the first keyword. */
function rank(value: string, search: string, keywords?: string[]): number {
  if (value === ASK_VALUE) return ASK_SCORE
  const action = actionsByLabel.get(value)
  if (action) return actionScore(action, search)
  return paletteScore(keywords?.[0] ?? value, keywords?.slice(1) ?? [], search)
}

const groups = ['Suggested', 'Assist', 'Edit', 'View', 'Project', 'Settings', 'Help']
const ASK_GROUP = 'ask'

/**
 * The groups in the order to show: as listed, or best match first while searching, with "Ask Assist" for a sentence
 * ranked by ASK_SCORE. Ordered here because cmdk only sorts the items inside each group.
 */
function sections(search: string, sentence: boolean): string[] {
  const query = search.trim()
  const all = sentence ? [ASK_GROUP, ...groups] : groups
  if (!query) return all
  const best = (g: string) =>
    g === ASK_GROUP
      ? ASK_SCORE
      : Math.max(0, ...actions.filter((a) => a.group === g).map((a) => actionScore(a, query)))
  return [...all].sort((a, b) => best(b) - best(a))
}

const pagePlaceholders: Record<Page, string> = {
  looks: 'Search looks',
  history: 'Search edits',
}

const pageEmpty: Record<Page, string> = {
  looks: 'No matching look. Try fewer words.',
  history: 'No edits to undo or redo yet',
}

/** Undoes or redoes `count` steps as separate steps, so Redo and Undo walk them back one at a time. */
function walkHistory(dir: 'undo' | 'redo', count: number, label: string) {
  if (count === 1) return dir === 'undo' ? undo() : redo()
  for (let i = 0; i < count; i++) {
    if (dir === 'undo') editor.undo()
    else editor.redo()
  }
  toast(
    dir === 'undo'
      ? `Undid ${plural(count, 'edit')}, back to before “${label}”`
      : `Redid ${plural(count, 'edit')}, through “${label}”`,
  )
}

function LooksPage({ run }: { run: (fn: () => void) => void }) {
  return (
    <Command.Group heading="Apply a look to the whole video" className={styles.group}>
      {lookItems().map((look) => (
        <Command.Item
          key={look.id}
          value={look.id}
          keywords={[look.name, look.category ?? '', look.description ?? '', ...(look.tags ?? [])]}
          className={styles.item}
          onSelect={() => run(() => chooseLook(look.id))}
        >
          <span className={styles.itemIcon}>
            <Palette />
          </span>
          <span className={styles.itemLabel}>{look.name}</span>
        </Command.Item>
      ))}
    </Command.Group>
  )
}

function HistoryPage({ run }: { run: (fn: () => void) => void }) {
  const { undo: undos, redo: redos } = editor.history()
  return (
    <>
      {undos.length > 0 && (
        <Command.Group heading="Undo" className={styles.group}>
          {undos.map((label, i) => (
            <Command.Item
              key={`undo-${i}`}
              value={`undo-${i}`}
              keywords={[label, 'undo']}
              className={styles.item}
              onSelect={() => run(() => walkHistory('undo', i + 1, label))}
            >
              <span className={styles.itemIcon}>
                <Undo2 />
              </span>
              <span className={styles.itemLabel}>
                {i === 0 ? `Undo “${label}”` : `Undo “${label}” and ${plural(i, 'later edit')}`}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {redos.length > 0 && (
        <Command.Group heading="Redo" className={styles.group}>
          {redos.map((label, i) => (
            <Command.Item
              key={`redo-${i}`}
              value={`redo-${i}`}
              keywords={[label, 'redo']}
              className={styles.item}
              onSelect={() => run(() => walkHistory('redo', i + 1, label))}
            >
              <span className={styles.itemIcon}>
                <Redo2 />
              </span>
              <span className={styles.itemLabel}>
                {i === 0 ? `Redo “${label}”` : `Redo “${label}” and ${plural(i, 'edit')} before it`}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  )
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const returnFocus = useReturnFocus()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState<Page | null>(null)
  const close = () => {
    set({ paletteOpen: false })
    setSearch('')
    setPage(null)
  }
  const run = (fn: () => void) => {
    close()
    fn()
  }
  const openPage = (next: Page) => {
    setPage(next)
    setSearch('')
  }
  const back = () => {
    setPage(null)
    setSearch('')
  }
  const sentence = !page && search.trim().split(/\s+/).length >= 3

  return (
    <RDialog.Root open={open} onOpenChange={(o) => (o ? set({ paletteOpen: true }) : close())}>
      <RDialog.Portal>
        <RDialog.Overlay className={styles.overlay} />
        <RDialog.Content
          className={styles.content}
          aria-describedby={undefined}
          {...returnFocus}
          onEscapeKeyDown={(e) => {
            if (!page) return
            e.preventDefault()
            back()
          }}
        >
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          {/* Keyed by page, so a list starts at its top with its first item selected. */}
          <Command
            key={page ?? 'actions'}
            label="Command palette"
            className={styles.command}
            loop
            filter={rank}
            onKeyDown={(e) => {
              if (page && e.key === 'Backspace' && !search) {
                e.preventDefault()
                back()
              }
            }}
          >
            <div className={styles.inputRow}>
              <Search className={styles.inputIcon} />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder={
                  page ? pagePlaceholders[page] : 'Search actions, tools and settings, or describe a change'
                }
                className={styles.input}
              />
              <Kbd keys="Esc" />
            </div>
            <Command.List className={styles.list}>
              <Command.Empty className={styles.empty}>
                {page ? pageEmpty[page] : 'No matching action. Try fewer words.'}
              </Command.Empty>
              {page === 'looks' && <LooksPage run={run} />}
              {page === 'history' && <HistoryPage run={run} />}
              {!page &&
                sections(search, sentence).map((g) =>
                  g === ASK_GROUP ? (
                    <Command.Group key={g} heading="Ask Assist" className={styles.group}>
                      <Command.Item
                        value={ASK_VALUE}
                        className={styles.item}
                        onSelect={() =>
                          run(() => {
                            openAssist('home')
                            void ask(search.trim())
                          })
                        }
                      >
                        <span className={[styles.itemIcon, styles.askIcon].join(' ')}>
                          <Sparkles />
                        </span>
                        <span className={styles.itemLabel}>Ask Assist: “{search.trim()}”</span>
                        <Kbd keys="Enter" />
                      </Command.Item>
                    </Command.Group>
                  ) : (
                    <Command.Group key={g} heading={g} className={styles.group}>
                      {actions
                        .filter((a) => a.group === g)
                        .map((a) => {
                          const reason = a.unavailable?.()
                          return (
                            <Command.Item
                              key={a.label}
                              value={a.label}
                              className={[styles.item, reason && styles.unavailable]
                                .filter(Boolean)
                                .join(' ')}
                              onSelect={() => {
                                if (reason) return
                                if (a.page) openPage(a.page)
                                else if (a.run) run(a.run)
                              }}
                            >
                              <span className={styles.itemIcon}>{a.icon}</span>
                              <span className={styles.itemLabel}>{a.label}</span>
                              {reason ? (
                                <span className={styles.reason}>{reason}</span>
                              ) : (
                                a.shortcut && <Kbd keys={a.shortcut} />
                              )}
                            </Command.Item>
                          )
                        })}
                    </Command.Group>
                  ),
                )}
            </Command.List>
            <div className={styles.footer}>
              <span>
                <Kbd keys="↑" /> <Kbd keys="↓" /> to move
              </span>
              <span>
                <Kbd keys="Enter" /> to run
              </span>
              {page ? (
                <span className={styles.footerRight}>
                  <Kbd keys="Esc" /> to go back
                </span>
              ) : (
                <span className={styles.footerRight}>Type a sentence to ask Assist</span>
              )}
            </div>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
