import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Info, RotateCcw } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { Segmented, Select, TextArea } from '../../../ds/Fields.tsx'
import { plural } from '../../../format.ts'
import { JOB_KINDS } from '../../../state/jobs.ts'
import {
  DRAFT_LANGUAGES,
  draftLooksUnreliable,
  languageName,
  linesToCheck,
  lyricsResultKind,
  markAllChecked,
  showFirstToCheck,
} from '../../../state/lyricChecks.ts'
import { estimateLyrics, lastLyricsRequest, lyricsCost, startLyrics } from '../../../state/lyrics.ts'
import {
  hasSong,
  lyricLines,
  sectionKind,
  sectionsOf,
  songAnalysis,
  useProject,
} from '../../../state/project.ts'
import { select, set } from '../../../state/ui.ts'
import { dismiss, pct, useJob } from './jobState.ts'
import { CancelButton, Field, RunCard, ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

/** Status on the Lyrics row of Assist's tool list. */
export function LyricsBadge() {
  const project = useProject()
  const { job, phase } = useJob(JOB_KINDS.lyrics)
  if (phase === 'running') return <Badge tone="accent">{pct(job)}%</Badge>
  if (phase === 'failed') return <Badge tone="danger">Failed</Badge>
  if (lyricLines(project).some((l) => l.start !== undefined)) return <Badge tone="success">Timed</Badge>
  return null
}

type LyricsMode = 'paste' | 'draft'

const lyricsKind = (mode: LyricsMode) => (mode === 'paste' ? 'time' : 'draft')

const DETECTED = 'detected'

let languageOptions: { value: string; label: string }[] | undefined

/** Whisper's languages by name, for drafting again in another language. */
function draftLanguageOptions() {
  languageOptions ??= DRAFT_LANGUAGES.map((code) => ({ value: code, label: languageName(code) })).sort(
    (a, b) => a.label.localeCompare(b.label),
  )
  return languageOptions
}

/**
 * After a draft or timing: how many lines there are and how many are left to check, with Show on timeline and Mark
 * all as checked, then, for a draft that is probably mostly wrong, a warning with other ways to get the lyrics (and
 * no Mark all as checked: confirming such a draft is the wrong nudge).
 */
function LyricsResult({ onPaste }: { onPaste: () => void }) {
  const project = useProject()
  // Radix Select takes no empty value, so the detected language has a value of its own.
  const [language, setLanguage] = useState(DETECTED)
  const kind = lyricsResultKind(project)
  const doc = project.lyrics
  if (!kind || !doc) return null
  const toCheck = linesToCheck(project).length
  const detected = doc.language ? languageName(doc.language) : undefined
  // A pick that the last draft already used is the detected language now.
  const picked = language === doc.language ? DETECTED : language
  const count = toCheck ? `${toCheck} to check` : 'all checked'
  const summary =
    kind === 'draft'
      ? `Drafted ${plural(doc.lines.length, 'line')} from the vocals · ${count}`
      : `Timed ${plural(doc.lines.filter((l) => l.start !== undefined).length, 'line')} · ${count}`
  const unreliable = kind === 'draft' && toCheck > 0 && draftLooksUnreliable(doc)
  return (
    <div className={styles.draftResult}>
      {/* A draft that is probably wrong gets the warning below instead of a success card. */}
      {unreliable ? (
        <div className={styles.draftSummary}>{summary}</div>
      ) : (
        <div className={styles.success}>
          <span className={styles.successIcon}>
            <Check />
          </span>
          <div className={styles.successTitle}>{summary}</div>
        </div>
      )}
      {toCheck > 0 && (
        <div className={styles.linkRow}>
          <Button size="sm" variant="ghost" onClick={showFirstToCheck}>
            Show on timeline
          </Button>
          {!unreliable && (
            <Button size="sm" variant="ghost" onClick={markAllChecked}>
              Mark all as checked
            </Button>
          )}
        </div>
      )}
      {unreliable && (
        <div className={[styles.callout, styles.calloutWarning].join(' ')}>
          <AlertTriangle />
          <div className={styles.warningBody}>
            <div className={styles.warningTitle}>Most of this draft is probably wrong</div>
            <div>
              {detected
                ? `The vocals were hard to make out, or the song isn’t in ${detected}. Paste the lyrics if you have them, or pick the song’s language and draft again.`
                : 'The vocals were hard to make out. Paste the lyrics if you have them, or pick the song’s language and draft again.'}
            </div>
            <div>
              <Button size="sm" variant="secondary" onClick={onPaste}>
                Paste lyrics
              </Button>
            </div>
            <div className={styles.languageRow}>
              <Select
                size="sm"
                ariaLabel="Language"
                value={picked}
                onChange={setLanguage}
                options={[
                  { value: DETECTED, label: detected ? `Detected: ${detected}` : 'Detected automatically' },
                  ...draftLanguageOptions().filter((o) => o.value !== doc.language),
                ]}
              />
              {picked !== DETECTED && (
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void startLyrics({ kind: 'draft', language: picked })}
                  >
                    Draft again in {languageName(picked)}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function LyricsView() {
  const project = useProject()
  const lines = lyricLines(project)
  const { job, phase } = useJob(JOB_KINDS.lyrics)
  // Timing separates stems first when the song has none; two separations at once would need twice the memory.
  const separating = useJob(JOB_KINDS.stems).phase === 'running'
  const [mode, setMode] = useState<LyricsMode>('paste')
  const [text, setText] = useState(() => lines.map((l) => l.text).join('\n'))
  const textRef = useRef<HTMLTextAreaElement>(null)
  const pasteInstead = () => {
    setMode('paste')
    setText('')
    requestAnimationFrame(() => textRef.current?.focus())
  }
  // Both modes at once, so switching between them shows the line at once instead of a stand-in.
  const [estimates, setEstimates] = useState<
    Partial<Record<LyricsMode, Awaited<ReturnType<typeof estimateLyrics>>>>
  >({})
  const stemsReady = !!songAnalysis(project)?.stems
  useEffect(() => {
    let live = true
    for (const m of ['paste', 'draft'] as const)
      estimateLyrics(lyricsKind(m)).then(
        (value) => live && setEstimates((e) => ({ ...e, [m]: value })),
        () => live && setEstimates((e) => ({ ...e, [m]: null })),
      )
    return () => {
      live = false
    }
  }, [project.songAssetId, stemsReady, phase])
  // The highlight is a setting of a line's clip: open the first chorus line that has one, else the first such line.
  const shown = new Set(
    Object.values(project.clips).flatMap((c) => (c.type === 'text' && c.lyricLineId ? [c.lyricLineId] : [])),
  )
  const choruses = sectionsOf(project).filter((s) => sectionKind(s) === 'chorus')
  const withClip = lines.filter((l) => shown.has(l.id))
  const karaokeLine =
    withClip.find((l) => {
      const t = l.start
      return t !== undefined && choruses.some((s) => t >= s.start && t < s.end)
    }) ?? withClip[0]
  const timed = lines.some((l) => l.start !== undefined)

  if (phase === 'running') {
    return (
      <ToolView
        title="Lyrics"
        subtitle={
          lastLyricsRequest?.kind === 'draft' ? 'Drafting from the vocals' : 'Timing words to the vocals'
        }
        footer={<CancelButton job={job} />}
      >
        <RunCard job={job} label="Lyrics progress" />
        <p className={styles.muted}>
          Keep editing; the lines land on the Lyrics track when they are ready, as one step you can undo.
        </p>
      </ToolView>
    )
  }
  if (phase === 'failed') {
    return (
      <ToolView
        title="Lyrics"
        subtitle="Stopped"
        footer={
          <div className={styles.footerRow}>
            <Button variant="secondary" onClick={() => dismiss(job)}>
              Edit lyrics
            </Button>
            <Button
              variant="primary"
              icon={<RotateCcw />}
              className={styles.grow}
              onClick={() => lastLyricsRequest && void startLyrics(lastLyricsRequest)}
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
              Your lyrics are unchanged.
              {stemsReady ? ' The separated stems are kept, so trying again is quicker.' : ''}
            </div>
          </div>
        </div>
      </ToolView>
    )
  }

  const cost = separating ? { text: 'Waiting for the stems to finish…' } : lyricsCost(estimates[mode])
  const canRun = hasSong(project) && !separating && (mode === 'draft' || text.trim().length > 0)
  return (
    <ToolView
      title="Lyrics"
      subtitle={
        lines.length
          ? `${plural(lines.length, 'line')} · ${timed ? 'every word timed' : 'not timed yet'}`
          : 'Not added yet'
      }
      footer={
        <>
          <Button
            variant="primary"
            block
            disabled={!canRun}
            onClick={() => void startLyrics(mode === 'paste' ? { kind: 'time', text } : { kind: 'draft' })}
          >
            {mode === 'paste' ? 'Time words to the vocals' : 'Draft lyrics from the vocals'}
          </Button>
          <div className={styles.costLine} title={cost.detail}>
            <Info /> {cost.text}
          </div>
        </>
      }
    >
      <LyricsResult onPaste={pasteInstead} />
      <Segmented
        block
        value={mode}
        onChange={(v) => setMode(v as LyricsMode)}
        ariaLabel="Lyrics source"
        options={[
          { value: 'paste', label: 'Paste lyrics' },
          { value: 'draft', label: 'Draft from vocals' },
        ]}
      />
      {mode === 'paste' ? (
        <Field label="Lyrics" hint="Each line becomes a lyric line on the Lyrics track.">
          <TextArea
            ref={textRef}
            rows={8}
            aria-label="Lyrics"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
      ) : (
        <div className={styles.callout}>
          <Info />
          <div>
            A draft is written and timed from the vocals on this device. Sung lyrics are tricky, so check each
            line afterwards.
            {lines.length
              ? ` It replaces the ${plural(lines.length, 'line')} you have; you can undo it.`
              : ''}
          </div>
        </div>
      )}
      <Field label="Look of the lyrics">
        <div className={styles.linkRow}>
          <Button size="sm" variant="ghost" onClick={() => set({ libraryTab: 'text' })}>
            Kinetic presets
          </Button>
          {karaokeLine && (
            <Button size="sm" variant="ghost" onClick={() => select({ type: 'lyric', id: karaokeLine.id })}>
              Karaoke highlight
            </Button>
          )}
        </div>
      </Field>
    </ToolView>
  )
}
