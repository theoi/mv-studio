import { useState, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  AudioLines,
  Box,
  Check,
  ChevronRight,
  Clapperboard,
  Cpu,
  Eye,
  Info,
  KeyRound,
  Layers,
  Lock,
  Mic2,
  RotateCcw,
  Scissors,
  Search,
  Sparkles,
  Undo2,
  Users,
  Wand2,
  X,
} from 'lucide-react'
import type { JobSnapshot } from '../../../../shared/jobs.ts'
import { jobs } from '../../../../shared/jobs.ts'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { Badge, EmptyState, ProgressBar, Spinner } from '../../../ds/Feedback.tsx'
import { Segmented, Select, Slider, Switch, TextArea } from '../../../ds/Fields.tsx'
import { Kbd } from '../../../ds/Kbd.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatTime } from '../../../format.ts'
import { startAutocut, startDirector, startStems } from '../../../mock/actions.ts'
import { sceneThumb } from '../../../mock/art.ts'
import { FEATURED_CLIP_ID } from '../../../mock/demoProject.ts'
import { media } from '../../../mock/media.ts'
import { peaks } from '../../../mock/song.ts'
import { JOB_KINDS, latestJob, runningJobs, useJobs } from '../../../state/jobs.ts'
import {
  bpmOf,
  hasSong,
  lyricLines,
  sectionKind,
  sectionsOf,
  songAnalysis,
  useProject,
} from '../../../state/project.ts'
import { openAssist, set, toast, useUi, type AssistView } from '../../../state/ui.ts'
import styles from './Assist.module.css'

type Phase = 'idle' | 'running' | 'done' | 'failed'

/** Latest job of a kind and the state its tool view shows. A dismissed result returns the view to idle. */
function useJob(kind: string): { job?: JobSnapshot; phase: Phase } {
  const job = latestJob(useJobs(), kind)
  const dismissed = useUi((s) => s.dismissed)
  if (!job || dismissed.includes(job.id)) return { phase: 'idle' }
  if (job.status === 'queued' || job.status === 'running') return { job, phase: 'running' }
  if (job.status === 'succeeded') return { job, phase: 'done' }
  if (job.status === 'failed') return { job, phase: 'failed' }
  return { phase: 'idle' }
}

function dismiss(job?: JobSnapshot) {
  if (job) set((s) => ({ dismissed: [...s.dismissed, job.id] }))
}

const pct = (job?: JobSnapshot) => Math.round((job?.progress.fraction ?? 0) * 100)

function etaText(job?: JobSnapshot): string | undefined {
  const s = job?.progress.etaSeconds
  if (s === undefined) return undefined
  if (s < 50) return 'Less than a minute left'
  return `About ${Math.round(s / 60)} min left`
}

interface ToolDef {
  id: AssistView
  title: string
  desc: string
  icon: ReactNode
  status?: ReactNode
}

function AskBox() {
  const [value, setValue] = useState('')
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'done'>('idle')
  const [asked, setAsked] = useState('')
  const submit = () => {
    if (!value.trim()) return
    setAsked(value.trim())
    setValue('')
    setPhase('thinking')
    window.setTimeout(() => setPhase('done'), 1400)
  }
  return (
    <div className={styles.ask}>
      <div className={styles.askBox}>
        <textarea
          className={styles.askInput}
          rows={2}
          value={value}
          placeholder="Ask for a change, like “make the chorus more intense”"
          aria-label="Ask Assist for a change"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className={styles.askFoot}>
          <Tooltip
            label="Plain-language edits use your LLM"
            description="Ollama on this computer. Change it in Settings › AI and cloud."
          >
            <span className={styles.askModel}>
              <Cpu /> Ollama · llama3.2
            </span>
          </Tooltip>
          <IconButton
            label="Send"
            shortcut="Enter"
            size="sm"
            variant="secondary"
            onClick={submit}
            disabled={!value.trim()}
          >
            <ArrowUp />
          </IconButton>
        </div>
      </div>
      {phase === 'thinking' && (
        <div className={styles.askResult}>
          <div className={styles.askQ}>“{asked}”</div>
          <div className={styles.thinking}>
            <Spinner size={12} /> Planning changes…
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className={styles.askResult}>
          <div className={styles.askQ}>“{asked}”</div>
          <div className={styles.changed}>
            <Check /> Changed 3 things in both choruses
          </div>
          <ul className={styles.changes}>
            <li>Cuts every beat instead of every bar (32 clips)</li>
            <li>Contrast +15% and Glow on the Video track</li>
            <li>Zoom pulse follows the kick drum</li>
          </ul>
          <div className={styles.rowActions}>
            <Button
              size="sm"
              variant="subtle"
              icon={<Eye />}
              onClick={() => set({ selection: { type: 'section', id: 's-c1' }, rightTab: 'assist' })}
            >
              Show changes
            </Button>
            <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => setPhase('idle')}>
              Undo
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

const viewForKind: Record<string, AssistView> = {
  [JOB_KINDS.stems]: 'stems',
  [JOB_KINDS.director]: 'director',
  [JOB_KINDS.autocut]: 'autocut',
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
          {bpmOf(project)} BPM · {list.length} sections
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

function AssistHome() {
  const project = useProject()
  const empty = !hasSong(project)
  const director = useJob(JOB_KINDS.director)
  const stems = useJob(JOB_KINDS.stems)
  const stemsReady = !!songAnalysis(project)?.stems
  const stemsStatus =
    stems.phase === 'running' ? (
      <Badge tone="accent">{pct(stems.job)}%</Badge>
    ) : stems.phase === 'failed' ? (
      <Badge tone="danger">Failed</Badge>
    ) : stemsReady ? (
      <Badge tone="success">Ready</Badge>
    ) : undefined
  const groups: { label: string; tools: ToolDef[] }[] = [
    {
      label: 'Create',
      tools: [
        {
          id: 'director',
          title: 'Director',
          desc: 'Draft a whole video from the song',
          icon: <Clapperboard />,
          status:
            director.phase === 'running' ? (
              <Badge tone="accent">{pct(director.job)}%</Badge>
            ) : director.phase === 'done' ? (
              <Badge tone="success">Done</Badge>
            ) : undefined,
        },
        {
          id: 'generate',
          title: 'Generate',
          desc: 'AI images and video clips',
          icon: <Sparkles />,
          status: <Badge icon={<KeyRound />}>fal.ai</Badge>,
        },
      ],
    },
    {
      label: 'Music',
      tools: [
        { id: 'autocut', title: 'Auto-cut', desc: 'Cut your clips to the beat', icon: <Scissors /> },
        {
          id: 'lyrics',
          title: 'Lyrics',
          desc: 'Paste, draft and time words',
          icon: <Mic2 />,
          status: lyricLines(project).length ? <Badge tone="success">Timed</Badge> : undefined,
        },
        {
          id: 'stems',
          title: 'Stems',
          desc: 'Split vocals, drums, bass and other',
          icon: <Layers />,
          status: stemsStatus,
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
        { id: 'camera', title: '3D camera', desc: 'Depth motion on still images', icon: <Box /> },
        {
          id: 'match',
          title: 'Match footage',
          desc: 'Find clips for each line or section',
          icon: <Search />,
        },
      ],
    },
  ]
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

function ToolView({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className={styles.view}>
      <div className={styles.viewHeader}>
        <IconButton label="All tools" size="sm" onClick={() => openAssist('home')} tooltipSide="bottom">
          <ArrowLeft />
        </IconButton>
        <div className={styles.viewTitles}>
          <div className={styles.viewTitle}>{title}</div>
          {subtitle && <div className={styles.viewSub}>{subtitle}</div>}
        </div>
      </div>
      <div className={`${styles.viewBody} scroll`}>{children}</div>
      {footer && <div className={styles.viewFooter}>{footer}</div>}
    </div>
  )
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldLabel}>{label}</div>
      {children}
      {hint && <div className={styles.fieldHint}>{hint}</div>}
    </div>
  )
}

function Steps({ steps, active }: { steps: string[]; active: number }) {
  return (
    <ol className={styles.steps}>
      {steps.map((s, i) => (
        <li key={s} className={i < active ? styles.stepDone : i === active ? styles.stepActive : undefined}>
          <span className={styles.stepMark}>
            {i < active ? <Check /> : i === active ? <Spinner size={11} /> : null}
          </span>
          {s}
        </li>
      ))}
    </ol>
  )
}

function RunCard({ job, label }: { job?: JobSnapshot; label: string }) {
  return (
    <div className={styles.runCard}>
      <div className={styles.jobTop}>
        <span>{job?.progress.message ?? label}</span>
        <span className={`${styles.jobPct} tnum`}>{pct(job)}%</span>
      </div>
      <ProgressBar value={job?.progress.fraction ?? 0} label={label} />
      {etaText(job) && <div className={styles.jobEta}>{etaText(job)}</div>}
    </div>
  )
}

function CancelButton({ job }: { job?: JobSnapshot }) {
  return (
    <Button variant="secondary" block icon={<X />} onClick={() => job && jobs.cancel(job.id)}>
      Cancel
    </Button>
  )
}

const directorSteps = [
  'Read the song’s structure',
  'Match your clips to sections',
  'Write the creative plan',
  'Place shots and lyrics',
  'Apply looks and effects',
]

function DirectorView() {
  const { job, phase } = useJob(JOB_KINDS.director)
  const [shots, setShots] = useState('mine')
  if (phase === 'running') {
    const active = Math.min(
      directorSteps.length - 1,
      Math.floor((job?.progress.fraction ?? 0) * directorSteps.length),
    )
    return (
      <ToolView title="Director" subtitle="Drafting your video" footer={<CancelButton job={job} />}>
        <RunCard job={job} label="Drafting progress" />
        <Steps steps={directorSteps} active={active} />
        <p className={styles.muted}>
          You can keep editing while this runs. Nothing changes on the timeline until the draft is ready.
        </p>
      </ToolView>
    )
  }
  if (phase === 'done') {
    const plan = [
      { s: 'Intro', d: 'Slow drift over the night city, title fades in' },
      { s: 'Verse 1', d: 'Singer close-ups, cuts every 2 bars, lyrics lower third' },
      { s: 'Pre-chorus', d: 'Cuts tighten to every bar, energy builds' },
      { s: 'Chorus', d: 'Crowd and neon on every beat, spectrum overlay, kick-driven zoom' },
      { s: 'Bridge', d: 'Aurora and sunset stills with 3D camera, lyrics behind the singer' },
      { s: 'Outro', d: 'Back to the city, slow fade to black' },
    ]
    return (
      <ToolView
        title="Director"
        subtitle="Draft ready"
        footer={
          <div className={styles.footerRow}>
            <Button
              variant="secondary"
              icon={<Undo2 />}
              onClick={() => {
                dismiss(job)
                toast('Draft removed from the timeline')
              }}
            >
              Undo draft
            </Button>
            <Button
              variant="primary"
              onClick={() => set({ selection: { type: 'none' }, playhead: 0, playing: true })}
              className={styles.grow}
            >
              Play the draft
            </Button>
          </div>
        }
      >
        <div className={styles.success}>
          <span className={styles.successIcon}>
            <Check />
          </span>
          <div>
            <div className={styles.successTitle}>Placed 64 clips, 31 lyric lines and 3 looks</div>
            <div className={styles.muted}>
              All of it is normal content on the timeline. Change anything by hand.
            </div>
          </div>
        </div>
        <div className={styles.groupLabelInset}>The plan</div>
        <ol className={styles.plan}>
          {plan.map((p) => (
            <li key={p.s}>
              <span className={styles.planSection}>{p.s}</span>
              <span className={styles.planDesc}>{p.d}</span>
            </li>
          ))}
        </ol>
        <Field label="Refine the draft">
          <TextArea
            rows={2}
            placeholder="For example: fewer crowd shots, more of the singer in verse 2"
            aria-label="Refine the draft"
          />
        </Field>
      </ToolView>
    )
  }
  return (
    <ToolView
      title="Director"
      subtitle="Drafts a complete, editable video"
      footer={
        <>
          <Button variant="primary" block icon={<Clapperboard />} onClick={() => startDirector()}>
            Draft video
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device with your clips · free
          </div>
        </>
      }
    >
      <Field label="Idea" hint="Optional. Without one, the director follows the song’s mood and your clips.">
        <TextArea
          rows={3}
          defaultValue="A dreamy night drive through a neon city that ends at sunrise"
          aria-label="Idea for the video"
        />
      </Field>
      <Field label="Shots">
        <Segmented
          block
          value={shots}
          onChange={setShots}
          ariaLabel="Where shots come from"
          options={[
            { value: 'mine', label: 'My clips' },
            { value: 'mix', label: 'Mix' },
            { value: 'gen', label: 'Generate' },
          ]}
        />
      </Field>
      {shots !== 'mine' && (
        <div className={styles.callout}>
          <KeyRound />
          <div>
            <div>Generating shots needs a fal.ai key.</div>
            <Button
              size="sm"
              variant="ghost"
              className={styles.calloutBtn}
              onClick={() => set({ dialog: 'settings', settingsPage: 'ai' })}
            >
              Connect fal.ai
            </Button>
          </div>
        </div>
      )}
      <Field label="Planner">
        <div className={styles.plannerRow}>
          <Cpu />
          <span>Ollama · llama3.2 writes the creative plan</span>
        </div>
      </Field>
    </ToolView>
  )
}

function StemsView() {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.stems)
  const ready = !!songAnalysis(project)?.stems
  if (phase === 'running') {
    const stage = job?.progress.stage
    const active = stage === 'download' ? 0 : stage === 'save' ? 2 : 1
    return (
      <ToolView
        title="Stems"
        subtitle="Separating vocals, drums, bass and other"
        footer={<CancelButton job={job} />}
      >
        <RunCard job={job} label="Stem separation progress" />
        <Steps
          steps={['Download the model (180 MB, once)', 'Separate the song', 'Save stems with the project']}
          active={active}
        />
        <p className={styles.muted}>
          Keep editing; you’ll get a notice when the stems are ready. Precise lyric timing and stem-driven
          effects unlock afterwards.
        </p>
      </ToolView>
    )
  }
  if (phase === 'failed') {
    return (
      <ToolView
        title="Stems"
        subtitle="Separation stopped"
        footer={
          <div className={styles.footerRow}>
            <Button variant="secondary" onClick={() => set({ dialog: 'settings', settingsPage: 'local' })}>
              Device settings
            </Button>
            <Button
              variant="primary"
              icon={<RotateCcw />}
              className={styles.grow}
              onClick={() => startStems(job?.progress.fraction ?? 0)}
            >
              Try again
            </Button>
          </div>
        }
      >
        <div className={styles.failure} role="alert">
          <span className={styles.failureIcon}>
            <AlertTriangle />
          </span>
          <div>
            <div className={styles.successTitle}>{job?.error?.message ?? 'Something went wrong.'}</div>
            <div className={styles.muted}>
              Your project is unchanged. The part already separated is kept, so trying again picks up at{' '}
              {pct(job)}%.
            </div>
          </div>
        </div>
        <div className={styles.groupLabelInset}>Things that help</div>
        <ul className={styles.tips}>
          <li>Close other browser tabs that play video</li>
          <li>Use fewer threads in Settings › This device</li>
          <li>Or separate stems with Replicate, about $0.02 per song</li>
        </ul>
      </ToolView>
    )
  }
  if (ready) {
    return (
      <ToolView title="Stems" subtitle="Ready · shown under the song track">
        {['Vocals', 'Drums', 'Bass', 'Other'].map((s, i) => (
          <div key={s} className={styles.stemRow}>
            <span className={styles.stemName}>{s}</span>
            <span className={styles.stemWave} aria-hidden>
              {Array.from({ length: 36 }, (_, k) => (
                <i
                  key={k}
                  style={{ height: `${10 + (peaks[(k * 280 + i * 977) % peaks.length] ?? 0) * 90}%` }}
                />
              ))}
            </span>
            <Button size="sm" variant="ghost">
              Solo
            </Button>
          </div>
        ))}
        <p className={styles.muted}>
          Effects and visualizers can now react to one stem, like the kick in Drums.
        </p>
      </ToolView>
    )
  }
  return (
    <ToolView
      title="Stems"
      subtitle="Split the song into four parts"
      footer={
        <>
          <Button variant="primary" block onClick={() => startStems()}>
            Separate stems
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device · free
          </div>
        </>
      }
    >
      <p className={styles.lede}>
        Vocals, drums, bass and other become separate lanes under the song. Effects can react to a single
        stem, and lyrics can be timed precisely to the vocals.
      </p>
      <div className={styles.facts}>
        <div>
          <span>Time</span>
          <span>About 3–5 min on this computer</span>
        </div>
        <div>
          <span>Download</span>
          <span>180 MB once, then offline</span>
        </div>
        <div>
          <span>Memory</span>
          <span>Up to 4 GB while running</span>
        </div>
      </div>
    </ToolView>
  )
}

function LyricsView() {
  const project = useProject()
  const lines = lyricLines(project)
  const [mode, setMode] = useState('paste')
  const firstChorusLine = lines.find((l) => l.id.startsWith('l-c1'))
  return (
    <ToolView
      title="Lyrics"
      subtitle={lines.length ? `${lines.length} lines · every word timed` : 'Not added yet'}
      footer={
        <>
          <Button variant="primary" block onClick={() => toast('Words re-timed to the vocals')}>
            Time words to the vocals
          </Button>
          <div className={styles.costLine}>
            <Info /> Uses the vocals stem for precise timing
          </div>
        </>
      }
    >
      <Segmented
        block
        value={mode}
        onChange={setMode}
        ariaLabel="Lyrics source"
        options={[
          { value: 'paste', label: 'Paste lyrics' },
          { value: 'draft', label: 'Draft from vocals' },
        ]}
      />
      {mode === 'paste' ? (
        <Field label="Lyrics" hint="Each line becomes a lyric line on the Lyrics track.">
          <TextArea rows={8} aria-label="Lyrics" defaultValue={lines.map((l) => l.text).join('\n')} />
        </Field>
      ) : (
        <div className={styles.callout}>
          <Info />
          <div>
            A draft is written from the vocals on this device. Sung lyrics are tricky, so check each line
            before timing.
          </div>
        </div>
      )}
      <Field label="Look of the lyrics">
        <div className={styles.linkRow}>
          <Button size="sm" variant="ghost" onClick={() => set({ libraryTab: 'text' })}>
            Kinetic presets
          </Button>
          {firstChorusLine && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ selection: { type: 'lyric', id: firstChorusLine.id } })}
            >
              Karaoke highlight
            </Button>
          )}
        </div>
      </Field>
    </ToolView>
  )
}

function AutocutView() {
  const { job, phase } = useJob(JOB_KINDS.autocut)
  const [pace, setPace] = useState('bar')
  const [follow, setFollow] = useState(true)
  const [match, setMatch] = useState(true)
  return (
    <ToolView
      title="Auto-cut"
      subtitle="Cut your clips to the music"
      footer={
        phase === 'running' ? (
          <RunCard job={job} label="Cutting to the beat" />
        ) : phase === 'done' ? (
          <div className={styles.footerRow}>
            <Button
              variant="secondary"
              icon={<Undo2 />}
              onClick={() => {
                dismiss(job)
                toast('Cuts removed')
              }}
            >
              Undo
            </Button>
            <Button variant="primary" className={styles.grow} icon={<Check />} onClick={() => dismiss(job)}>
              Keep 72 cuts
            </Button>
          </div>
        ) : (
          <Button variant="primary" block icon={<Scissors />} onClick={() => startAutocut()}>
            Cut to the beat
          </Button>
        )
      }
    >
      <Field label="Cut every">
        <Segmented
          block
          value={pace}
          onChange={setPace}
          ariaLabel="Cut pace"
          options={[
            { value: 'beat', label: 'Beat' },
            { value: '2', label: '2 beats' },
            { value: 'bar', label: 'Bar' },
            { value: 'phrase', label: 'Phrase' },
          ]}
        />
      </Field>
      <label className={styles.switchRow}>
        <span>
          <span className={styles.switchTitle}>Follow the song’s energy</span>
          <span className={styles.fieldHint}>Faster cuts in choruses, slower in verses</span>
        </span>
        <Switch checked={follow} onCheckedChange={setFollow} ariaLabel="Follow the song’s energy" />
      </label>
      <label className={styles.switchRow}>
        <span>
          <span className={styles.switchTitle}>Match clips to the mood</span>
          <span className={styles.fieldHint}>Uses footage tags, like “crowd” for choruses</span>
        </span>
        <Switch checked={match} onCheckedChange={setMatch} ariaLabel="Match clips to the mood" />
      </label>
      <Field label="Range">
        <Select
          value="all"
          onChange={() => undefined}
          ariaLabel="Range"
          options={[
            { value: 'all', label: 'Whole song' },
            { value: 'sel', label: 'Selected section' },
          ]}
        />
      </Field>
      <Field label="Clips">
        <Select
          value="all"
          onChange={() => undefined}
          ariaLabel="Clips to use"
          options={[
            { value: 'all', label: `All ${media.length} clips in the library` },
            { value: 'sel', label: 'Selected clips' },
          ]}
        />
      </Field>
    </ToolView>
  )
}

function GenerateView() {
  const [type, setType] = useState('video')
  return (
    <ToolView
      title="Generate"
      subtitle="AI images and clips with fal.ai"
      footer={
        <>
          <Button
            variant="primary"
            block
            icon={<KeyRound />}
            onClick={() => set({ dialog: 'settings', settingsPage: 'ai' })}
          >
            Connect fal.ai to generate
          </Button>
          <div className={styles.costLine}>
            <Info /> {type === 'video' ? 'About $0.35 per 5 s clip' : 'About $0.01 per image'}, charged by
            fal.ai to your key
          </div>
        </>
      }
    >
      <Segmented
        block
        value={type}
        onChange={setType}
        ariaLabel="What to generate"
        options={[
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video clip' },
        ]}
      />
      <Field label="Describe the shot">
        <TextArea
          rows={3}
          defaultValue="Slow aerial over a neon city at night, light rain, cinematic"
          aria-label="Describe the shot"
        />
      </Field>
      {type === 'video' && (
        <Field label="Start from" hint="Optional. Animate one of your images.">
          <Select
            value="none"
            onChange={() => undefined}
            ariaLabel="Start image"
            options={[
              { value: 'none', label: 'Text only' },
              { value: 'sunset', label: 'Rooftop sunset (image)' },
            ]}
          />
        </Field>
      )}
      <div className={styles.twoCol}>
        <Field label="Model">
          <Select
            value="fast"
            onChange={() => undefined}
            ariaLabel="Model"
            options={[
              { value: 'fast', label: type === 'video' ? 'Video · fast' : 'Image · fast' },
              { value: 'hq', label: type === 'video' ? 'Video · high quality' : 'Image · high quality' },
            ]}
          />
        </Field>
        <Field label={type === 'video' ? 'Length' : 'Count'}>
          <Select
            value="5"
            onChange={() => undefined}
            ariaLabel={type === 'video' ? 'Length' : 'Count'}
            options={[{ value: '5', label: type === 'video' ? '5 s' : '4 images' }]}
          />
        </Field>
      </div>
      <p className={styles.muted}>Results land in Media › Generated and at the playhead as normal clips.</p>
    </ToolView>
  )
}

function BehindView() {
  const byId = Object.fromEntries(media.map((m) => [m.id, m]))
  const rows = [
    { m: byId['m-singer'], ok: true, note: 'Person fills the frame' },
    { m: byId['m-dancer'], ok: true, note: 'Person found' },
    { m: byId['m-crowd'], ok: false, note: 'People are too small in this wide shot' },
  ].filter((r) => r.m)
  return (
    <ToolView
      title="Behind the subject"
      subtitle="Text sits between the person and the background"
      footer={
        <Button
          variant="primary"
          block
          onClick={() =>
            set({ behindSubject: true, selection: { type: 'clip', id: FEATURED_CLIP_ID }, playhead: 64.6 })
          }
        >
          Apply to suitable clips
        </Button>
      }
    >
      <p className={styles.lede}>
        People are cut out automatically on this device. For other objects, click them in the preview.
      </p>
      <div className={styles.groupLabelInset}>Clips on the timeline</div>
      {rows.map(({ m, ok, note }) =>
        m ? (
          <div key={m.id} className={styles.suitRow}>
            <span className={styles.suitThumb} style={{ backgroundImage: `url(${sceneThumb(m.scene)})` }} />
            <span className={styles.suitText}>
              <span className={styles.toolTitle}>{m.name}</span>
              <span className={ok ? styles.okText : styles.warnText}>{note}</span>
            </span>
            {ok ? <Badge tone="success">Suitable</Badge> : <Badge tone="warning">Not suitable</Badge>}
          </div>
        ) : null,
      )}
    </ToolView>
  )
}

function CameraView() {
  const [motion, setMotion] = useState('push')
  const [strength, setStrength] = useState(40)
  return (
    <ToolView
      title="3D camera"
      subtitle="Depth motion on still images"
      footer={
        <Button variant="primary" block onClick={() => toast('3D camera added to 1 image')}>
          Apply to 1 image
        </Button>
      }
    >
      <Field label="Motion">
        <Segmented
          block
          value={motion}
          onChange={setMotion}
          ariaLabel="Camera motion"
          options={[
            { value: 'push', label: 'Push in' },
            { value: 'orbit', label: 'Orbit' },
            { value: 'drift', label: 'Drift' },
          ]}
        />
      </Field>
      <Field label="Strength">
        <Slider value={strength} onChange={setStrength} ariaLabel="Strength" />
      </Field>
      <div className={styles.suitRow}>
        <span className={styles.suitThumb} style={{ backgroundImage: `url(${sceneThumb('sunset')})` }} />
        <span className={styles.suitText}>
          <span className={styles.toolTitle}>Rooftop sunset</span>
          <span className={styles.muted}>Image · on the timeline at 0:28</span>
        </span>
      </div>
      <p className={styles.muted}>Depth is estimated on this device. First use downloads a 25 MB model.</p>
    </ToolView>
  )
}

function MatchView() {
  return (
    <ToolView title="Match footage" subtitle={`${media.length} clips tagged on this device`}>
      <p className={styles.lede}>
        Clips are tagged by what’s in them, their mood and motion. Search in Media, or use these picks.
      </p>
      {[
        { s: 'Chorus', picks: ['crowd', 'neon', 'dancer'] as const, why: 'energetic, crowd, motion' },
        { s: 'Verse', picks: ['portrait', 'city', 'rain'] as const, why: 'calm, close-up, night' },
        { s: 'Bridge', picks: ['aurora', 'sunset', 'ocean'] as const, why: 'dreamy, slow, wide' },
      ].map((g) => (
        <div key={g.s} className={styles.matchGroup}>
          <div className={styles.matchHead}>
            <span className={styles.toolTitle}>{g.s}</span>
            <span className={styles.muted}>{g.why}</span>
          </div>
          <div className={styles.matchRow}>
            {g.picks.map((p) => (
              <span
                key={p}
                className={styles.matchThumb}
                style={{ backgroundImage: `url(${sceneThumb(p)})` }}
              />
            ))}
          </div>
        </div>
      ))}
    </ToolView>
  )
}

function AnalysisView() {
  const project = useProject()
  const analysis = songAnalysis(project)
  const list = sectionsOf(project)
  const choruses = list.filter((s) => sectionKind(s) === 'chorus').length
  const name = project.songAssetId ? project.assets[project.songAssetId]?.name : undefined
  return (
    <ToolView title="Song analysis" subtitle={name}>
      <div className={styles.facts}>
        <div>
          <span>Tempo</span>
          <span className="tnum">{analysis?.tempo ? `${analysis.tempo.bpm} BPM · 4/4` : 'Not found'}</span>
        </div>
        <div>
          <span>Beats</span>
          <span>
            <Badge tone="success" icon={<Check />}>
              {analysis?.beats?.length ?? 0} found
            </Badge>
          </span>
        </div>
        <div>
          <span>Bar starts</span>
          <span>
            <Badge tone="success" icon={<Check />}>
              {analysis?.downbeats?.length ?? 0} found
            </Badge>
          </span>
        </div>
        <div>
          <span>Sections</span>
          <span>
            {list.length}
            {choruses > 1 ? `, chorus repeats ${choruses}×` : ''}
          </span>
        </div>
        <div>
          <span>Energy curve</span>
          <span>Shown in the song lane</span>
        </div>
      </div>
      <div className={styles.linkRow}>
        <Button size="sm" variant="secondary" icon={<Activity />}>
          Tap tempo
        </Button>
        <Button size="sm" variant="ghost">
          Set first beat
        </Button>
        <Button size="sm" variant="ghost">
          Analyze again
        </Button>
      </div>
      <p className={styles.muted}>
        Section names are best guesses. Rename them by double-clicking on the timeline.
      </p>
    </ToolView>
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
