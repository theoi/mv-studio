import { useEffect, useId, useRef, useState } from 'react'
import type { Asset, Id } from '../../../../model/index.ts'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Lock,
  Minus,
  RotateCcw,
  Scissors,
  Undo2,
  Upload,
} from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { Segmented, Select, Switch } from '../../../ds/Fields.tsx'
import { formatBytes, formatTime, plural } from '../../../format.ts'
import {
  autoCutAssets,
  autoCutClipCount,
  autoCutOptions,
  clipChoice,
  DEFAULT_AUTOCUT_CHOICES,
  matchesMood,
  matchingDownloadBytes,
  selectedAssets,
  setAutoCutChoices,
  setClipChoice,
  startAutoCut,
  analysisBacklog,
  targetSection,
  undoAutoCut,
  usedAssetIds,
  useAutoCut,
} from '../../../state/autocut.ts'
import { analyzeFootageNow, cancelFootageAnalysis, useFootage } from '../../../state/footage.ts'
import { openImport } from '../../../state/importer.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import { editor, sectionName, useProject } from '../../../state/project.ts'
import { useThumbnail } from '../../../state/thumbs.ts'
import { toast, useUi } from '../../../state/ui.ts'
import { dismiss, pct, revealInTool, useJob } from './jobState.ts'
import { CancelButton, Field, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Auto-cut row of Assist's tool list. */
export function AutocutBadge() {
  const { job, phase } = useJob(JOB_KINDS.autocut)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  return null
}

/** Bytes the matching model still needs to download when this cut starts footage analysis, else 0. */
/** "Video track", or the name alone when it already ends in "track" ("Main track"). */
const trackPhrase = (name: string) => (/\btrack$/i.test(name.trim()) ? name.trim() : `${name} track`)

/** One clip in "Choose clips": a tick, its picture, name and length. */
function ClipChoice({ asset, on, onChange }: { asset: Asset; on: boolean; onChange: (on: boolean) => void }) {
  const thumb = useThumbnail(asset)
  return (
    <label className={styles.pickRow}>
      <span className={styles.check}>
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <Check />
        </span>
      </span>
      <span className={styles.pickThumb} style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} />
      <span className={styles.pickName}>{asset.name}</span>
      <span className={`${styles.pickMeta} tnum`}>
        {asset.kind === 'image' ? 'Image' : formatTime(asset.duration ?? 0)}
      </span>
    </label>
  )
}

/** "Choose clips": every clip the cut can use, ticked unless the user left it out. */
function ClipChoices({ assets, leftOut }: { assets: Asset[]; leftOut: readonly Id[] }) {
  const out = new Set(leftOut)
  const chosen = assets.filter((a) => !out.has(a.id)).length
  const all = chosen === assets.length
  const some = chosen > 0 && !all
  return (
    <div className={styles.pickList} role="group" aria-label="Clips to cut">
      <label className={styles.pickRow}>
        <span className={styles.check}>
          <input
            type="checkbox"
            checked={all}
            ref={(el) => {
              if (el) el.indeterminate = some
            }}
            onChange={() => setClipChoice({ leftOut: all ? assets.map((a) => a.id) : [] })}
          />
          <span>{some ? <Minus /> : <Check />}</span>
        </span>
        <span className={styles.pickName}>All clips</span>
        <span className={`${styles.pickMeta} tnum`}>
          {chosen} of {assets.length}
        </span>
      </label>
      <div className={styles.pickScroll}>
        {assets.map((a) => (
          <ClipChoice
            key={a.id}
            asset={a}
            on={!out.has(a.id)}
            onChange={(on) =>
              setClipChoice({ leftOut: on ? leftOut.filter((id) => id !== a.id) : [...leftOut, a.id] })
            }
          />
        ))}
      </div>
    </div>
  )
}

function useMatchingDownload(needed: boolean): number {
  const [bytes, setBytes] = useState(0)
  useEffect(() => {
    if (!needed) return
    let live = true
    void matchingDownloadBytes().then((b) => {
      if (live) setBytes(b)
    })
    return () => {
      live = false
    }
  }, [needed])
  return needed ? bytes : 0
}

export function AutocutView() {
  const { job, phase } = useJob(JOB_KINDS.autocut)
  const project = useProject()
  const selection = useUi((s) => s.selection)
  const playhead = useUi((s) => s.playhead)
  const choices = useAutoCut((s) => s.choices)
  const result = useAutoCut((s) => (job ? s.results[job.id] : undefined))
  const indexing = useFootage((s) => s.indexing)
  const clipCount = autoCutClipCount(project)
  const section = targetSection(project, selection, playhead)
  const selected = selectedAssets(project, selection)
  const range = choices.range === 'section' && section ? 'section' : 'all'
  const saved = clipChoice(project)
  const clips =
    (saved.clips === 'selected' && selected.length) || (saved.clips === 'chosen' && clipCount > 1)
      ? saved.clips
      : 'all'
  const used = usedAssetIds({ clips, leftOut: saved.leftOut }, project, selection)
  const usedCount = used?.length ?? clipCount
  // Clips analysis could not read are not offered again here; Assist › Match retries them.
  const unanalyzed = analysisBacklog(project, indexing, used).waiting
  const analyzing = indexing?.status === 'indexing'
  const willAnalyze = matchesMood(choices) && unanalyzed > 0 && !analyzing
  const story = choices.clipOrder === 'story'
  const sectionsOnly = choices.cutOn === 'sections'
  // Open when a choice inside differs from the default, so a changed option never hides.
  const [more, setMore] = useState(
    () =>
      choices.cutOn !== DEFAULT_AUTOCUT_CHOICES.cutOn ||
      choices.clipOrder !== DEFAULT_AUTOCUT_CHOICES.clipOrder,
  )
  const moreId = useId()
  const revealMore = useRef(false)
  const revealClips = useRef(false)
  const cutButton = useRef<HTMLButtonElement>(null)
  const download = useMatchingDownload(willAnalyze)
  const cut = () => {
    if (willAnalyze) analyzeFootageNow()
    startAutoCut(
      autoCutOptions({ ...choices, range, clips, leftOut: saved.leftOut }, project, selection, playhead),
    )
  }

  if (phase === 'running')
    return (
      <ToolView title="Auto-cut" subtitle="Cutting to the beat" footer={<CancelButton job={job} />}>
        <RunCard job={job} label="Auto-cut progress" />
        <p className={styles.muted}>Nothing changes on the timeline until the cut is ready.</p>
      </ToolView>
    )

  if (phase === 'failed')
    return (
      <ToolView
        title="Auto-cut"
        subtitle="Cut stopped"
        footer={
          clipCount ? (
            <Button variant="primary" block icon={<RotateCcw />} onClick={cut}>
              Try again
            </Button>
          ) : (
            <Button variant="primary" block icon={<Upload />} onClick={() => openImport('media')}>
              Import clips
            </Button>
          )
        }
      >
        <div className={styles.failure} role="alert">
          <span className={styles.failureIcon}>
            <AlertTriangle />
          </span>
          <div>
            <div className={styles.successTitle}>{job?.error?.message ?? 'Something went wrong.'}</div>
            <div className={styles.muted}>Your project is unchanged.</div>
          </div>
        </div>
      </ToolView>
    )

  if (phase === 'done' && result) {
    const cuts = result.stats.cuts
    const { start, end } = result.plan.range
    const songEnd = project.songAssetId ? (project.assets[project.songAssetId]?.duration ?? end) : end
    const whole = start < 0.05 && end > songEnd - 0.05
    const canUndo = editor.undoLabel() === result.label
    const undoButton = (
      <Button
        variant="secondary"
        icon={<Undo2 />}
        disabled={!canUndo}
        onClick={() => {
          if (undoAutoCut(result)) toast('Cuts removed')
          dismiss(job)
        }}
      >
        Undo
      </Button>
    )
    return (
      <ToolView
        title="Auto-cut"
        subtitle="Cut ready"
        footer={
          <div className={styles.footerRow}>
            {canUndo ? (
              undoButton
            ) : (
              <Tooltip
                label="You changed the project after this cut"
                description="Step back through your changes with Undo in the top bar."
                side="top"
              >
                <span tabIndex={0}>{undoButton}</span>
              </Tooltip>
            )}
            <Button variant="primary" className={styles.grow} icon={<Check />} onClick={() => dismiss(job)}>
              Keep {plural(cuts, 'cut')}
            </Button>
          </div>
        }
      >
        <div className={styles.success}>
          <span className={styles.successIcon}>
            <Check />
          </span>
          <div>
            <div className={styles.successTitle}>
              {whole
                ? `Cut the song into ${plural(cuts, 'shot')}`
                : `Cut ${formatTime(start)}–${formatTime(end)} into ${plural(cuts, 'shot')}`}
            </div>
            <div className={styles.muted}>
              On the {trackPhrase(result.track.name)}. Cutting again replaces only the clips you haven’t
              changed.
            </div>
          </div>
        </div>
        {result.warnings.length > 0 && (
          <div className={styles.callout} role="status">
            <Info />
            <div>
              {result.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          </div>
        )}
      </ToolView>
    )
  }

  const showAnalyzing = clipCount > 0 && matchesMood(choices) && analyzing
  const which =
    unanalyzed === usedCount
      ? `Your ${unanalyzed === 1 ? 'clip isn’t' : 'clips aren’t'}`
      : `${plural(unanalyzed, 'clip')} ${unanalyzed === 1 ? 'isn’t' : 'aren’t'}`
  const note = !clipCount
    ? 'Import video clips or images first. Auto-cut cuts them to the song.'
    : showAnalyzing
      ? `Analyzing your footage… ${indexing?.done ?? 0} of ${indexing?.total ?? clipCount} clips. Cut again when it’s done to match the mood.`
      : willAnalyze
        ? `${which} analyzed yet, so this cut picks ${unanalyzed === 1 ? 'it' : 'them'} for variety and starts the analysis. Cut again when it’s done to match the mood.`
        : undefined
  return (
    <ToolView
      title="Auto-cut"
      subtitle="Cut your clips to the music"
      footer={
        <>
          <Button
            ref={cutButton}
            variant="primary"
            block
            icon={<Scissors />}
            onClick={cut}
            disabled={!usedCount}
          >
            Cut to the beat
          </Button>
          <div className={styles.costLine}>
            <Lock /> Runs on this device&nbsp;·&nbsp;free
            {download ? `\u00a0· ${formatBytes(download)} download, once` : ''}
          </div>
        </>
      }
    >
      {note && (
        <div className={styles.callout}>
          <Info />
          <div>
            <div>{note}</div>
            {showAnalyzing && (
              <div className={styles.calloutBtn}>
                <CancelButton
                  inline
                  onCancel={() => {
                    cancelFootageAnalysis()
                    cutButton.current?.focus()
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
      <Field label="Cut every" {...(sectionsOnly ? { hint: 'Not used while each section is one shot' } : {})}>
        <Segmented
          block
          value={choices.pace}
          onChange={(pace) => setAutoCutChoices({ pace })}
          ariaLabel="Cut pace"
          options={[
            { value: 'beat', label: 'Beat' },
            { value: '2-beats', label: '2 beats' },
            { value: 'bar', label: 'Bar' },
            { value: 'phrase', label: 'Phrase' },
          ]}
        />
      </Field>
      <label className={styles.switchRow}>
        <span>
          <span className={styles.switchTitle}>Follow the song’s energy</span>
          <span className={styles.fieldHint}>
            {sectionsOnly
              ? `Off while each section is one shot${more ? '' : ' (More options)'}`
              : 'Faster cuts in choruses, slower in verses'}
          </span>
        </span>
        <Switch
          checked={choices.followEnergy && !sectionsOnly}
          onCheckedChange={(followEnergy) => setAutoCutChoices({ followEnergy })}
          disabled={sectionsOnly}
          ariaLabel="Follow the song’s energy"
        />
      </label>
      <label className={styles.switchRow}>
        <span>
          <span className={styles.switchTitle}>Match clips to the mood</span>
          <span className={styles.fieldHint}>
            {story
              ? `Off while clips play in story order${more ? '' : ' (More options)'}`
              : 'Uses footage tags, like “crowd” for choruses'}
          </span>
        </span>
        <Switch
          checked={choices.matchMood && !story}
          onCheckedChange={(matchMood) => setAutoCutChoices({ matchMood })}
          disabled={story}
          ariaLabel="Match clips to the mood"
        />
      </label>
      <Field label="Range">
        <Select
          value={range}
          onChange={(value) => setAutoCutChoices({ range: value })}
          ariaLabel="Range"
          options={[
            { value: 'all', label: 'Whole song' },
            ...(section
              ? [
                  {
                    value: 'section' as const,
                    label: selection.type === 'section' ? 'Selected section' : 'Section at the playhead',
                    description: `${sectionName(section)} · ${formatTime(section.start)}–${formatTime(section.end)}`,
                  },
                ]
              : []),
          ]}
        />
      </Field>
      <Field label="Clips">
        <Select
          value={clips}
          onChange={(value) => {
            revealClips.current = value === 'chosen'
            setClipChoice({ clips: value })
          }}
          ariaLabel="Clips to use"
          options={[
            { value: 'all', label: `All ${plural(clipCount, 'clip')} in the library` },
            ...(selected.length
              ? [
                  {
                    value: 'selected' as const,
                    label: 'Selected clips',
                    description: selected.length === 1 ? selected[0]!.name : plural(selected.length, 'clip'),
                  },
                ]
              : []),
            ...(clipCount > 1
              ? [{ value: 'chosen' as const, label: 'Choose clips', description: 'Pick the ones to cut' }]
              : []),
          ]}
        />
        {clips === 'chosen' && !usedCount && (
          <div className={styles.fieldHint}>Pick at least one clip to cut.</div>
        )}
        {clips === 'chosen' && (
          <div
            ref={(el) => {
              if (el && revealClips.current) revealInTool(el)
              revealClips.current = false
            }}
          >
            <ClipChoices assets={autoCutAssets(project)} leftOut={saved.leftOut} />
          </div>
        )}
      </Field>
      <Button
        variant="ghost"
        size="sm"
        className={styles.moreToggle}
        icon={more ? <ChevronDown /> : <ChevronRight />}
        aria-expanded={more}
        aria-controls={moreId}
        onClick={() => {
          revealMore.current = !more
          setMore(!more)
        }}
      >
        More options
      </Button>
      {more && (
        <div
          id={moreId}
          className={styles.moreFields}
          ref={(el) => {
            // The options open below the fold of the panel, so bring them into view when the user opens them.
            if (el && revealMore.current) revealInTool(el)
            revealMore.current = false
          }}
        >
          <Field label="Cut on">
            <Select
              value={choices.cutOn}
              onChange={(cutOn) => setAutoCutChoices({ cutOn })}
              ariaLabel="Cut on"
              options={[
                { value: 'beats', label: 'Pace', description: 'Cuts land on the beats of the pace above' },
                {
                  value: 'downbeats',
                  label: 'Bar lines only',
                  description: 'Every cut lands on the first beat of a bar, a bar or more apart',
                },
                {
                  value: 'sections',
                  label: 'Section changes only',
                  description: 'One shot per section, for slow songs',
                },
              ]}
            />
          </Field>
          <Field label="Clip order">
            <Select
              value={choices.clipOrder}
              onChange={(clipOrder) => setAutoCutChoices({ clipOrder })}
              ariaLabel="Clip order"
              options={[
                {
                  value: 'mood',
                  label: choices.matchMood ? 'Match the mood' : 'Shuffle',
                  description: 'Follows “Match clips to the mood” above',
                },
                { value: 'story', label: 'Story order', description: 'Clips in the order you imported them' },
              ]}
            />
          </Field>
        </div>
      )}
    </ToolView>
  )
}
