import {
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
import { ProgressRing } from '../../ds/Feedback.tsx'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ds/Menu.tsx'
import { Tooltip } from '../../ds/Tooltip.tsx'
import { JOB_KINDS, runningJobs, useJobs } from '../../state/jobs.ts'
import { editor, redo, undo, useProject } from '../../state/project.ts'
import { openAssist, set, toast, type AssistView } from '../../state/ui.ts'
import { LogoMark } from '../common/Logo.tsx'
import styles from './TopBar.module.css'

const viewForKind: Record<string, AssistView> = {
  [JOB_KINDS.stems]: 'stems',
  [JOB_KINDS.director]: 'director',
  [JOB_KINDS.directorShots]: 'director',
  [JOB_KINDS.ask]: 'home',
  [JOB_KINDS.autocut]: 'autocut',
  [JOB_KINDS.camera]: 'camera',
  [JOB_KINDS.lyrics]: 'lyrics',
  [JOB_KINDS.realign]: 'lyrics',
  [JOB_KINDS.cutout]: 'behind',
  [JOB_KINDS.suitability]: 'behind',
}

function Activity() {
  const running = runningJobs(useJobs())
  const first = running[0]
  if (!first) return null
  const fraction = first.progress.fraction ?? 0
  return (
    <Tooltip label="Background tasks" description="You can keep editing. Click for details.">
      <button
        className={styles.activity}
        onClick={() => {
          const view = viewForKind[first.kind]
          if (view) openAssist(view)
          else set({ dialog: 'export', exportPhase: 'exporting' })
        }}
      >
        <ProgressRing value={fraction} size={16} label={first.title} />
        <span>{first.title}</span>
        <span className={`${styles.activityPct} tnum`}>{Math.round(fraction * 100)}%</span>
        {running.length > 1 && <span className={styles.activityMore}>+{running.length - 1}</span>}
      </button>
    </Tooltip>
  )
}

export function TopBar() {
  const project = useProject()
  const undoLabel = editor.undoLabel()
  const redoLabel = editor.redoLabel()

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
        <Menu>
          <MenuTrigger asChild>
            <button className={styles.project} aria-label={`Project: ${project.name}`}>
              <span className={styles.projectName}>{project.name}</span>
              <ChevronDown />
            </button>
          </MenuTrigger>
          <MenuContent width={260}>
            <MenuItem icon={<Pencil />}>Rename</MenuItem>
            <MenuItem icon={<Copy />}>Duplicate</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<FilePlus2 />} onSelect={() => set({ screen: 'start' })}>
              New project
            </MenuItem>
            <MenuItem icon={<FolderOpen />} onSelect={() => set({ screen: 'start' })}>
              Open recent…
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Download />} description="One file with the project and all its media">
              Download project file
            </MenuItem>
            <MenuItem icon={<Upload />}>Open project file…</MenuItem>
          </MenuContent>
        </Menu>
        <Tooltip
          label="All changes saved in this browser"
          description="Autosaves as you work. Mod S saves now."
        >
          <span className={styles.saved}>
            <Check />
            Saved
          </span>
        </Tooltip>
        <span className={styles.divider} />
        <IconButton
          label={undoLabel ? `Undo ${undoLabel.toLowerCase()}` : 'Undo'}
          shortcut="Mod Z"
          onClick={undo}
          disabled={!undoLabel}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label={redoLabel ? `Redo ${redoLabel.toLowerCase()}` : 'Redo'}
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
          <Button variant="ghost" icon={<Disc3 />} onClick={() => set({ screen: 'vj' })}>
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
            <MenuItem icon={<BookOpen />} onSelect={() => toast('Documentation opens in a new tab')}>
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
