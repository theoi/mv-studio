import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Disc3,
  Download,
  FilePlus2,
  FolderOpen,
  GraduationCap,
  Keyboard,
  Pencil,
  Redo2,
  Search,
  Settings,
  Undo2,
  Upload,
} from 'lucide-react'
import { Button, IconButton } from '../../ds/Button.tsx'
import { Kbd } from '../../ds/Kbd.tsx'
import { ProgressRing, Spinner } from '../../ds/Feedback.tsx'
import { Input } from '../../ds/Fields.tsx'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ds/Menu.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { jobChipLabel, jobFraction, jobLabel, openJob, runningJobs, useJobs } from '../../state/jobs.ts'
import {
  downloadProjectFile,
  duplicateCurrent,
  openProjectFile,
  renameProject,
  saveNow,
  usePersistence,
} from '../../state/persistence.ts'
import { editor, redo, undo, useProject } from '../../state/project.ts'
import { set } from '../../state/ui.ts'
import { enterVj, takeVjButtonFocus, useVjEntering } from '../../state/vj.ts'
import { undoAction } from '../../format.ts'
import { LogoMark } from '../common/Logo.tsx'
import styles from './TopBar.module.css'

const DOCS_URL = 'https://github.com/theoi/mv-studio#readme'

function Activity() {
  const running = runningJobs(useJobs())
  const first = running[0]
  if (!first) return null
  // Jobs that can't measure their progress (a language model thinking) show a spinner instead of a stuck 0%.
  const fraction = jobFraction(first)
  const label = jobLabel(first)
  // The chip leaves out a title's details (a price), a narrow window cuts the rest off, and "Stopping…" replaces it:
  // the tooltip and the name keep all of it.
  const name = first.stopping ? `Stopping: ${first.title}` : first.title
  const more = running.length - 1
  return (
    <Tooltip label="Background tasks" description={`${name}. You can keep editing. Click for details.`}>
      <button
        className={styles.activity}
        aria-label={[name, fraction !== undefined && `${Math.round(fraction * 100)}%`, more > 0 && `+${more}`]
          .filter(Boolean)
          .join(' ')}
        onClick={() => openJob(first.kind)}
      >
        {fraction === undefined ? (
          <Spinner size={14} />
        ) : (
          <ProgressRing value={fraction} size={16} label={label} />
        )}
        <span className={styles.activityTitle}>{jobChipLabel(first)}</span>
        {fraction !== undefined && (
          <span className={`${styles.activityPct} tnum`}>{Math.round(fraction * 100)}%</span>
        )}
        {more > 0 && <span className={styles.activityMore}>+{more}</span>}
      </button>
    </Tooltip>
  )
}

const SAVE_HINT = 'Autosaves as you work. Mod S saves now.'

/** Whether the open project's latest changes are in browser storage. */
function SaveStatus() {
  const status = usePersistence((s) => s.status)
  const tracked = usePersistence((s) => s.tracked)
  const error = usePersistence((s) => s.error)
  if (tracked && status === 'error')
    return (
      <Tooltip
        label="Not saved"
        description={`${error ?? 'Couldn’t save in this browser.'} Click to try again.`}
      >
        <button className={styles.saved} data-state="error" onClick={() => void saveNow()}>
          <AlertTriangle />
          Not saved
        </button>
      </Tooltip>
    )
  if (tracked && (status === 'pending' || status === 'saving'))
    return (
      <Tooltip label="Saving in this browser" description={SAVE_HINT}>
        <span className={styles.saved}>
          <Spinner size={11} />
          Saving…
        </span>
      </Tooltip>
    )
  return (
    <Tooltip label="All changes saved in this browser" description={SAVE_HINT}>
      <span className={styles.saved}>
        <Check />
        Saved
      </span>
    </Tooltip>
  )
}

/** The project name, edited in place: Enter or leaving the field renames, Escape keeps the name. */
function RenameField({ project, onDone }: { project: { id: string; name: string }; onDone: () => void }) {
  return (
    <Input
      className={styles.rename}
      aria-label="Project name"
      defaultValue={project.name}
      maxLength={120}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.currentTarget.value = project.name
          e.currentTarget.blur()
        }
      }}
      onBlur={(e) => {
        void renameProject(project.id, e.currentTarget.value)
        onDone()
      }}
    />
  )
}

export function TopBar() {
  const project = useProject()
  const undoLabel = editor.undoLabel()
  const redoLabel = editor.redoLabel()
  const [renaming, setRenaming] = useState(false)
  const vjButton = useRef<HTMLButtonElement>(null)
  const vjEntering = useVjEntering()
  // Back from VJ mode, focus returns to the button that opened it.
  useEffect(() => {
    if (takeVjButtonFocus()) vjButton.current?.focus()
  }, [])

  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        <Tooltip label="Home" description="All projects and new video">
          <button
            className={styles.home}
            aria-label="Home"
            onClick={() => set({ screen: 'start', dialog: null })}
          >
            <LogoMark size={22} />
          </button>
        </Tooltip>
        {renaming ? (
          <RenameField project={project} onDone={() => setRenaming(false)} />
        ) : (
          <Menu>
            <MenuTrigger asChild>
              <button className={styles.project} aria-label={`Project: ${project.name}`}>
                <span className={styles.projectName}>{project.name}</span>
                <ChevronDown />
              </button>
            </MenuTrigger>
            <MenuContent width={260}>
              <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>
                Rename
              </MenuItem>
              <MenuItem icon={<Copy />} onSelect={() => void duplicateCurrent()}>
                Duplicate
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<FilePlus2 />} onSelect={() => set({ screen: 'start' })}>
                New project
              </MenuItem>
              <MenuItem icon={<FolderOpen />} onSelect={() => set({ screen: 'start' })}>
                Open recent…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Download />}
                description="One file with the project and all its media"
                onSelect={() => downloadProjectFile()}
              >
                Download project file
              </MenuItem>
              <MenuItem icon={<Upload />} onSelect={openProjectFile}>
                Open project file…
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        <SaveStatus />
        <span className={styles.divider} />
        <IconButton
          label={undoLabel ? `Undo ${undoAction(undoLabel)}` : 'Undo'}
          shortcut="Mod Z"
          onClick={undo}
          disabled={!undoLabel}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label={redoLabel ? `Redo ${undoAction(redoLabel)}` : 'Redo'}
          shortcut="Mod Shift Z"
          onClick={redo}
          disabled={!redoLabel}
        >
          <Redo2 />
        </IconButton>
      </div>

      <button className={styles.search} onClick={() => set({ paletteOpen: true })} data-guide="search">
        <Search />
        <span className={styles.searchText}>Search actions, tools and settings</span>
        <Kbd keys="Mod K" />
      </button>

      <div className={styles.right}>
        <Activity />
        <Tooltip
          label="VJ mode"
          shortcut="Shift V"
          description="Perform live with the keyboard or a MIDI controller"
        >
          <Button
            ref={vjButton}
            variant="ghost"
            icon={vjEntering ? <Spinner size={16} /> : <Disc3 />}
            aria-busy={vjEntering || undefined}
            onClick={enterVj}
          >
            VJ
          </Button>
        </Tooltip>
        <Menu>
          <Tooltip label="Help">
            <MenuTrigger asChild>
              <button className={styles.iconTrigger} aria-label="Help">
                <CircleHelp />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end" width={240}>
            <MenuItem
              icon={<Keyboard />}
              shortcut="?"
              onSelect={() => set({ dialog: 'settings', settingsPage: 'shortcuts' })}
            >
              Keyboard shortcuts
            </MenuItem>
            <MenuItem icon={<GraduationCap />} onSelect={() => set({ guideStep: 0 })}>
              Replay the guide
            </MenuItem>
            <MenuItem
              icon={<BookOpen />}
              onSelect={() => window.open(DOCS_URL, '_blank', 'noopener,noreferrer')}
            >
              Documentation
            </MenuItem>
          </MenuContent>
        </Menu>
        <IconButton label="Settings" shortcut="Mod ," onClick={() => set({ dialog: 'settings' })}>
          <Settings />
        </IconButton>
        <Tooltip label="Export video" shortcut="Mod E">
          <Button
            variant="primary"
            icon={<Upload />}
            onClick={() => set({ dialog: 'export', exportPhase: 'setup' })}
            className={styles.export}
          >
            Export
          </Button>
        </Tooltip>
      </div>
    </header>
  )
}
