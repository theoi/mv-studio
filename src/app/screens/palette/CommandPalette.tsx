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
} from 'lucide-react'
import { useReturnFocus } from '../../ds/focus.ts'
import { Kbd } from '../../ds/Kbd.tsx'
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
import { changeAspect } from '../../state/reframe.ts'
import { saveFrameFromPalette } from '../../state/stills.ts'
import { addTextAtPlayhead, splitAtPlayhead, undo } from '../../state/project.ts'
import { openAssist, selectedClipIds, set, useUi } from '../../state/ui.ts'
import styles from './CommandPalette.module.css'

interface Action {
  group: string
  label: string
  icon: ReactNode
  shortcut?: string
  keywords?: string
  /** Shown disabled, with why, until there are selected clips or copied clips. */
  needs?: 'clips' | 'clipboard'
  run: () => void
}

const actions: Action[] = [
  {
    group: 'Suggested',
    label: 'Export video…',
    icon: <Upload />,
    shortcut: 'Mod E',
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
    label: 'Find matching footage',
    icon: <Search />,
    keywords: 'tags search clips',
    run: () => openAssist('match'),
  },
  { group: 'Edit', label: 'Undo', icon: <Undo2 />, shortcut: 'Mod Z', run: undo },
  { group: 'Edit', label: 'Split at playhead', icon: <Scissors />, shortcut: 'S', run: splitAtPlayhead },
  {
    group: 'Edit',
    label: 'Copy',
    icon: <Copy />,
    shortcut: 'Mod C',
    needs: 'clips',
    run: () => void copySelection(),
  },
  {
    group: 'Edit',
    label: 'Cut',
    icon: <ScissorsLineDashed />,
    shortcut: 'Mod X',
    needs: 'clips',
    run: () => void cutSelection(),
  },
  {
    group: 'Edit',
    label: 'Paste at playhead',
    icon: <ClipboardPaste />,
    shortcut: 'Mod V',
    needs: 'clipboard',
    run: paste,
  },
  {
    group: 'Edit',
    label: 'Duplicate',
    icon: <CopyPlus />,
    shortcut: 'Mod D',
    needs: 'clips',
    run: () => void duplicateSelection(),
  },
  {
    group: 'Edit',
    label: 'Delete',
    icon: <Trash2 />,
    shortcut: 'Delete',
    needs: 'clips',
    run: () => void deleteSelection(),
  },
  {
    group: 'Edit',
    label: 'Select all on the track',
    icon: <SquareDashedMousePointer />,
    shortcut: 'Mod A',
    keywords: 'select every clip',
    run: selectAll,
  },
  { group: 'Edit', label: 'Add text', icon: <Type />, shortcut: 'T', run: addTextAtPlayhead },
  {
    group: 'Edit',
    label: 'Toggle snapping',
    icon: <Magnet />,
    shortcut: 'N',
    run: () => set((s) => ({ snap: !s.snap })),
  },
  {
    group: 'Edit',
    label: 'Apply a look…',
    icon: <Palette />,
    keywords: 'style grade filter restyle',
    run: () => set({ libraryTab: 'effects', libraryOpen: true }),
  },
  {
    group: 'Edit',
    label: 'Import media…',
    icon: <Film />,
    shortcut: 'Mod I',
    run: () => openImport(),
  },
  {
    group: 'View',
    label: 'Play / pause',
    icon: <Play />,
    shortcut: 'Space',
    run: () => set((s) => ({ playing: !s.playing })),
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
    shortcut: 'Shift V',
    keywords: 'live perform midi',
    run: () => set({ screen: 'vj' }),
  },
  {
    group: 'Project',
    label: 'Save frame',
    icon: <ImageDown />,
    keywords: 'still png image screenshot picture thumbnail',
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
    shortcut: 'Mod S',
    keywords: 'save store browser',
    run: () => void saveNow(),
  },
  {
    group: 'Settings',
    label: 'Connect fal.ai',
    icon: <KeyRound />,
    keywords: 'api key cloud',
    run: () => set({ dialog: 'settings', settingsPage: 'ai' }),
  },
  {
    group: 'Settings',
    label: 'Set up an LLM (Ollama, LM Studio, OpenAI)',
    icon: <Wand2 />,
    keywords: 'api key local model',
    run: () => set({ dialog: 'settings', settingsPage: 'ai' }),
  },
  {
    group: 'Settings',
    label: 'Open settings',
    icon: <Settings />,
    shortcut: 'Mod ,',
    run: () => set({ dialog: 'settings', settingsPage: 'general' }),
  },
  {
    group: 'Help',
    label: 'Keyboard shortcuts',
    icon: <Keyboard />,
    shortcut: '?',
    run: () => set({ dialog: 'settings', settingsPage: 'shortcuts' }),
  },
  { group: 'Help', label: 'Replay the guide', icon: <GraduationCap />, run: () => set({ guideStep: 0 }) },
]

const groups = ['Suggested', 'Assist', 'Edit', 'View', 'Project', 'Settings', 'Help']

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const returnFocus = useReturnFocus()
  const hasClips = useUi((s) => selectedClipIds(s.selection).length > 0)
  // Read when the palette renders: nothing can be copied while it is open.
  const canPaste = open && hasClipboard()
  const unavailable = (a: Action) =>
    a.needs === 'clips' && !hasClips
      ? 'Select clips first'
      : a.needs === 'clipboard' && !canPaste
        ? 'Copy clips first'
        : null
  const [search, setSearch] = useState('')
  const close = () => {
    set({ paletteOpen: false })
    setSearch('')
  }
  const run = (fn: () => void) => {
    close()
    fn()
  }
  const sentence = search.trim().split(/\s+/).length >= 3

  return (
    <RDialog.Root open={open} onOpenChange={(o) => (o ? set({ paletteOpen: true }) : close())}>
      <RDialog.Portal>
        <RDialog.Overlay className={styles.overlay} />
        <RDialog.Content className={styles.content} aria-describedby={undefined} {...returnFocus}>
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <Command label="Command palette" className={styles.command} loop>
            <div className={styles.inputRow}>
              <Search className={styles.inputIcon} />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search actions, tools and settings, or describe a change"
                className={styles.input}
              />
              <Kbd keys="Esc" />
            </div>
            <Command.List className={styles.list}>
              <Command.Empty className={styles.empty}>No matching action. Try fewer words.</Command.Empty>
              {sentence && (
                <Command.Group heading="Ask Assist" className={styles.group}>
                  <Command.Item
                    value={`ask ${search}`}
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
              )}
              {groups.map((g) => (
                <Command.Group key={g} heading={g} className={styles.group}>
                  {actions
                    .filter((a) => a.group === g)
                    .map((a) => {
                      const reason = unavailable(a)
                      return (
                        <Command.Item
                          key={a.label}
                          value={`${a.label} ${a.keywords ?? ''}`}
                          className={styles.item}
                          disabled={reason !== null}
                          onSelect={() => run(a.run)}
                        >
                          <span className={styles.itemIcon}>{a.icon}</span>
                          <span className={styles.itemLabel}>{a.label}</span>
                          {reason ? (
                            <span className={styles.itemHint}>{reason}</span>
                          ) : (
                            a.shortcut && <Kbd keys={a.shortcut} />
                          )}
                        </Command.Item>
                      )
                    })}
                </Command.Group>
              ))}
            </Command.List>
            <div className={styles.footer}>
              <span>
                <Kbd keys="↑" /> <Kbd keys="↓" /> to move
              </span>
              <span>
                <Kbd keys="Enter" /> to run
              </span>
              <span className={styles.footerRight}>Type a sentence to ask Assist</span>
            </div>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
