import type { ReactNode } from 'react'
import {
  AudioLines,
  Box,
  ChevronRight,
  Clapperboard,
  Layers,
  Mic2,
  Scissors,
  Search,
  Sparkles,
  Users,
  Wand2,
} from 'lucide-react'
import { EmptyState, ProgressBar } from '../../../ds/Feedback.tsx'
import { Kbd } from '../../../ds/Kbd.tsx'
import { formatBpm, formatTime, plural } from '../../../format.ts'
import { JOB_KINDS, runningJobs, useJobs } from '../../../state/jobs.ts'
import { bpmOf, hasSong, sectionKind, sectionsOf, songAnalysis, useProject } from '../../../state/project.ts'
import { openAssist, useUi, type AssistView } from '../../../state/ui.ts'
import { AnalysisView } from './Analysis.tsx'
import { AskBox } from './Ask.tsx'
import { AutocutBadge, AutocutView } from './Autocut.tsx'
import { BehindView } from './Behind.tsx'
import { CameraBadge, CameraView } from './Camera.tsx'
import { DirectorBadge, DirectorView } from './Director.tsx'
import { GenerateBadge, GenerateView } from './Generate.tsx'
import { etaText, pct } from './jobState.ts'
import { LyricsBadge, LyricsView } from './Lyrics.tsx'
import { MatchView } from './Match.tsx'
import { StemsBadge, StemsView } from './Stems.tsx'
import styles from './Assist.module.css'

/*
 * Assist: the tool list and a router to one view per tool. Each tool lives in its own file with its view and, when
 * it has one, the badge shown on its row here, so tools can change without touching each other.
 */

interface ToolDef {
  id: AssistView
  title: string
  desc: string
  icon: ReactNode
  status?: ReactNode
}

/** The tool view that shows a running job of each kind, for the Running list. */
const viewForKind: Record<string, AssistView> = {
  [JOB_KINDS.stems]: 'stems',
  [JOB_KINDS.director]: 'director',
  [JOB_KINDS.autocut]: 'autocut',
  [JOB_KINDS.camera]: 'camera',
}

function Running() {
  const items = runningJobs(useJobs()).filter((j) => viewForKind[j.kind])
  if (!items.length) return null
  return (
    <div className={styles.group}>
      <div className={styles.groupLabel}>Running</div>
      {items.map((j) => (
        <button key={j.id} className={styles.job} onClick={() => openAssist(viewForKind[j.kind])}>
          <div className={styles.jobTop}>
            <span>{j.title}</span>
            <span className={`${styles.jobPct} tnum`}>{pct(j)}%</span>
          </div>
          <ProgressBar value={j.progress.fraction ?? 0} label={j.title} />
          <div className={styles.jobEta}>{etaText(j) ?? j.progress.message}</div>
        </button>
      ))}
    </div>
  )
}

function SongStatus() {
  const project = useProject()
  const list = sectionsOf(project)
  const chorus = list.find((s) => sectionKind(s) === 'chorus')
  const stems = !!songAnalysis(project)?.stems
  return (
    <button className={styles.song} onClick={() => openAssist('analysis')}>
      <span className={styles.songIcon}>
        <AudioLines />
      </span>
      <span className={styles.songText}>
        <span className={styles.songTitle}>Song analyzed</span>
        <span className={`${styles.songMeta} tnum`}>
          {formatBpm(bpmOf(project) ?? 120)} · {plural(list.length, 'section')}
          {chorus ? ` · chorus at ${formatTime(chorus.start)}` : ''}
          {stems ? ' · stems ready' : ''}
        </span>
      </span>
      <ChevronRight className={styles.chev} />
    </button>
  )
}

function ToolRow({ tool, disabled }: { tool: ToolDef; disabled?: boolean }) {
  return (
    <button className={styles.tool} onClick={() => openAssist(tool.id)} disabled={disabled}>
      <span className={styles.toolIcon}>{tool.icon}</span>
      <span className={styles.toolText}>
        <span className={styles.toolTitle}>{tool.title}</span>
        <span className={styles.toolDesc}>{tool.desc}</span>
      </span>
      {tool.status}
      <ChevronRight className={styles.chev} />
    </button>
  )
}

const groups: { label: string; tools: ToolDef[] }[] = [
  {
    label: 'Create',
    tools: [
      {
        id: 'director',
        title: 'Director',
        desc: 'Draft a whole video from the song',
        icon: <Clapperboard />,
        status: <DirectorBadge />,
      },
      {
        id: 'generate',
        title: 'Generate',
        desc: 'AI images and video clips',
        icon: <Sparkles />,
        status: <GenerateBadge />,
      },
    ],
  },
  {
    label: 'Music',
    tools: [
      {
        id: 'autocut',
        title: 'Auto-cut',
        desc: 'Cut your clips to the beat',
        icon: <Scissors />,
        status: <AutocutBadge />,
      },
      {
        id: 'lyrics',
        title: 'Lyrics',
        desc: 'Paste, draft and time words',
        icon: <Mic2 />,
        status: <LyricsBadge />,
      },
      {
        id: 'stems',
        title: 'Stems',
        desc: 'Split vocals, drums, bass and other',
        icon: <Layers />,
        status: <StemsBadge />,
      },
    ],
  },
  {
    label: 'Visual',
    tools: [
      {
        id: 'behind',
        title: 'Behind the subject',
        desc: 'Put text between people and background',
        icon: <Users />,
      },
      {
        id: 'camera',
        title: '3D camera',
        desc: 'Depth motion on still images',
        icon: <Box />,
        status: <CameraBadge />,
      },
      {
        id: 'match',
        title: 'Match footage',
        desc: 'Find clips for each line or section',
        icon: <Search />,
      },
    ],
  },
]

function AssistHome() {
  const empty = !hasSong(useProject())
  return (
    <div className={`${styles.scroll} scroll`}>
      {!empty && <AskBox />}
      {empty && (
        <EmptyState
          compact
          icon={<Wand2 />}
          title="Add a song to unlock Assist"
          description="Smart tools use the song’s beats, sections and vocals. Drop a song anywhere to begin."
        />
      )}
      <Running />
      {!empty && (
        <div className={styles.group}>
          <SongStatus />
        </div>
      )}
      {groups.map((g) => (
        <div key={g.label} className={styles.group}>
          <div className={styles.groupLabel}>{g.label}</div>
          {g.tools.map((t) => (
            <ToolRow key={t.id} tool={t} disabled={empty} />
          ))}
        </div>
      ))}
      <div className={styles.footHint}>
        Every result lands on the timeline as normal clips, text and keyframes you can edit.{' '}
        <Kbd keys="Mod Z" /> undoes it.
      </div>
    </div>
  )
}

export function Assist() {
  const view = useUi((s) => s.assistView)
  const empty = !hasSong(useProject())
  if (empty || view === 'home') return <AssistHome />
  switch (view) {
    case 'director':
      return <DirectorView />
    case 'stems':
      return <StemsView />
    case 'lyrics':
      return <LyricsView />
    case 'autocut':
      return <AutocutView />
    case 'generate':
      return <GenerateView />
    case 'behind':
      return <BehindView />
    case 'camera':
      return <CameraView />
    case 'match':
      return <MatchView />
    case 'analysis':
      return <AnalysisView />
    default:
      return <AssistHome />
  }
}
