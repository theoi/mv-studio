import { useRef, useState } from 'react'
import {
  ArrowRight,
  Clock,
  Copy,
  Download,
  FileUp,
  Lock,
  MoreHorizontal,
  Music,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Button, IconButton } from '../../ds/Button.tsx'
import { Dialog } from '../../ds/Dialog.tsx'
import { Input } from '../../ds/Fields.tsx'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ds/Menu.tsx'
import { editedAgo } from '../../format.ts'
import { sceneThumb } from '../../mock/art.ts'
import {
  deleteProject,
  downloadProjectFile,
  duplicateProject,
  openProject,
  openProjectFile,
  renameProject,
  saveErrorMessage,
  usePersistence,
  type RecentProject,
} from '../../state/persistence.ts'
import { JOB_KINDS, runningJobs, useIsRunning, useJobs } from '../../state/jobs.ts'
import { openBlankProject, startSetup } from '../../state/setup.ts'
import { set, toast, type Kind } from '../../state/ui.ts'
import { Logo } from '../common/Logo.tsx'
import { CancelButton, RunCard } from '../editor/assist/ToolView.tsx'
import styles from './Start.module.css'

const kinds: { id: Exclude<Kind, 'blank'>; title: string; description: string }[] = [
  {
    id: 'lyric',
    title: 'Lyric video',
    description: 'Words timed to the vocals, with karaoke and kinetic type.',
  },
  { id: 'visualizer', title: 'Visualizer', description: 'Visuals that move with the beat, bass and vocals.' },
  {
    id: 'footage',
    title: 'Beat-cut footage',
    description: 'Your clips, cut to the beat and the song’s sections.',
  },
  {
    id: 'ai',
    title: 'AI music video',
    description: 'A complete, editable draft from your song and an idea.',
  },
]

const RECENT_LIMIT = 6

export function KindArt({ kind }: { kind: Exclude<Kind, 'blank'> }) {
  if (kind === 'lyric') {
    return (
      <div className={styles.art} style={{ backgroundImage: `url(${sceneThumb('city')})` }} aria-hidden>
        <div className={styles.artShade} />
        <div className={styles.lyricArt}>
          <span className={styles.lyricSung}>Under the </span>
          <span className={styles.lyricActive}>neon</span>
          <span> skyline</span>
        </div>
      </div>
    )
  }
  if (kind === 'visualizer') {
    return (
      <div className={styles.art} style={{ backgroundImage: `url(${sceneThumb('neon')})` }} aria-hidden>
        <div className={styles.artShade} />
        <div className={styles.bars}>
          {Array.from({ length: 22 }, (_, i) => (
            <span
              key={i}
              style={{
                height: `${18 + Math.abs(Math.sin(i * 0.9) * 52) + (i % 3) * 6}%`,
                animationDelay: `${(i % 7) * -90}ms`,
              }}
            />
          ))}
        </div>
      </div>
    )
  }
  if (kind === 'footage') {
    const strip = ['crowd', 'portrait', 'tunnel', 'dancer'] as const
    return (
      <div className={[styles.art, styles.footageArt].join(' ')} aria-hidden>
        <div className={styles.strip}>
          {strip.map((s) => (
            <span key={s} style={{ backgroundImage: `url(${sceneThumb(s)})` }} />
          ))}
        </div>
        <div className={styles.beats}>
          {Array.from({ length: 16 }, (_, i) => (
            <i key={i} className={i % 4 === 0 ? styles.downbeat : undefined} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className={styles.art} style={{ backgroundImage: `url(${sceneThumb('aurora')})` }} aria-hidden>
      <div className={styles.artShade} />
      <div className={styles.prompt}>
        <Sparkles />
        <span>dreamy city under the aurora</span>
      </div>
    </div>
  )
}

function RecentCard({ project }: { project: RecentProject }) {
  // Opening a kept project while a project file opens would be replaced by the file's project when it is in.
  const opening = useIsRunning(JOB_KINDS.projectImport)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // The menu traps focus while open and gives it back to its button as it closes, so the rename field takes focus
  // only once the menu has closed.
  const keepFocus = useRef(false)
  const field = useRef<HTMLInputElement>(null)
  const thumb = (
    <span
      className={styles.recentThumb}
      style={project.thumbnail ? { backgroundImage: `url(${project.thumbnail})` } : undefined}
    >
      {!project.thumbnail && <Music />}
    </span>
  )
  const meta = (
    <span className={styles.recentMeta}>
      <Clock />
      {editedAgo(project.updatedAt)}
    </span>
  )
  return (
    <div className={styles.recentItem}>
      {renaming ? (
        <div className={styles.recentOpen}>
          {thumb}
          <span className={styles.recentText}>
            <Input
              ref={field}
              aria-label="Project name"
              defaultValue={project.name}
              maxLength={120}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.currentTarget.value = project.name
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => {
                const name = e.currentTarget.value.trim()
                setRenaming(false)
                if (name && name !== project.name) void renameProject(project.id, name)
              }}
            />
            {meta}
          </span>
        </div>
      ) : (
        <button className={styles.recentOpen} onClick={() => void openProject(project.id)} disabled={opening}>
          {thumb}
          <span className={styles.recentText}>
            <span className={styles.recentName}>{project.name}</span>
            {meta}
          </span>
        </button>
      )}
      <Menu>
        <MenuTrigger asChild>
          <button className={styles.recentMore} aria-label={`More actions for ${project.name}`}>
            <MoreHorizontal />
          </button>
        </MenuTrigger>
        <MenuContent
          align="end"
          width={220}
          onCloseAutoFocus={(e) => {
            if (!keepFocus.current) return
            keepFocus.current = false
            e.preventDefault()
            field.current?.focus()
          }}
        >
          <MenuItem
            icon={<Pencil />}
            onSelect={() => {
              keepFocus.current = true
              setRenaming(true)
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon={<Copy />}
            onSelect={() =>
              void duplicateProject(project.id).catch((error: unknown) => toast(saveErrorMessage(error)))
            }
          >
            Duplicate
          </MenuItem>
          <MenuItem icon={<Download />} onSelect={() => downloadProjectFile(project.id)}>
            Download project file
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirming(true)}>
            Delete…
          </MenuItem>
        </MenuContent>
      </Menu>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete “${project.name}”?`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 />}
              onClick={() => {
                setConfirming(false)
                void deleteProject(project.id)
              }}
            >
              Delete project
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>
          The project and its media files are removed from this browser. Media another project uses is kept.
          You can’t undo this, so download the project file first if you might want it back.
        </p>
      </Dialog>
    </div>
  )
}

/** Projects kept in this browser, most recently edited first. Hidden until there is one. */
function RecentProjects() {
  const recents = usePersistence((s) => s.recents)
  const [all, setAll] = useState(false)
  if (!recents?.length) return null
  const shown = all ? recents : recents.slice(0, RECENT_LIMIT)
  return (
    <section className={styles.recent} aria-labelledby="recent-title">
      <div className={styles.recentHeader}>
        <h2 id="recent-title" className={styles.sectionTitle}>
          Recent projects
        </h2>
        {recents.length > RECENT_LIMIT && (
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${recents.length}`}
          </Button>
        )}
      </div>
      <div className={styles.recentList}>
        {shown.map((p) => (
          <RecentCard key={p.id} project={p} />
        ))}
      </div>
    </section>
  )
}
/** The project file being opened, with how far its media has got into this browser's storage. */
function OpeningFile() {
  const job = runningJobs(useJobs()).find((j) => j.kind === JOB_KINDS.projectImport)
  if (!job) return null
  return (
    <section className={styles.opening} aria-label={job.title}>
      <div className={styles.openingHeader}>
        <h2 className={styles.openingTitle}>{job.title}</h2>
        <CancelButton job={job} inline />
      </div>
      <RunCard
        job={job}
        label="Opening progress"
        placeholder="Reading the project file"
        note="Its media goes into this browser’s storage, so this takes a moment."
      />
    </section>
  )
}

export function StartScreen() {
  const opening = useIsRunning(JOB_KINDS.projectImport)
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Logo />
        <div className={styles.headerActions}>
          <Button variant="ghost" icon={<FileUp />} onClick={openProjectFile} disabled={opening}>
            Open project file
          </Button>
          <IconButton
            label="Settings"
            shortcut="Mod ,"
            onClick={() => set({ dialog: 'settings', settingsPage: 'general' })}
          >
            <Settings />
          </IconButton>
        </div>
      </header>

      <main className={styles.main}>
        <OpeningFile />
        <div className={styles.hero}>
          <h1 className={styles.title}>What are you making?</h1>
          <p className={styles.subtitle}>Pick a starting point. You can mix everything later.</p>
        </div>

        <div className={styles.kinds}>
          {kinds.map((k) => (
            <button key={k.id} className={styles.kind} onClick={() => startSetup(k.id)}>
              <KindArt kind={k.id} />
              <div className={styles.kindText}>
                <span className={styles.kindTitle}>{k.title}</span>
                <span className={styles.kindDesc}>{k.description}</span>
              </div>
            </button>
          ))}
        </div>

        <button className={styles.blank} onClick={() => void openBlankProject()}>
          <span className={styles.blankIcon}>
            <Plus />
          </span>
          <span className={styles.blankText}>
            <span className={styles.kindTitle}>Blank project</span>
            <span className={styles.kindDesc}>Start from an empty timeline</span>
          </span>
          <ArrowRight className={styles.blankArrow} />
        </button>

        <RecentProjects />
      </main>

      <footer className={styles.footer}>
        <Lock />
        Runs in your browser. Your songs and footage stay on this device unless you use a cloud feature.
      </footer>
    </div>
  )
}
