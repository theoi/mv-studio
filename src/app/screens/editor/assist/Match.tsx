import { useEffect, useState } from 'react'
import { AlertTriangle, Info, Lock, Plus, RotateCcw, Sparkles } from 'lucide-react'
import type { Asset, Project, SongSection } from '../../../../model/index.ts'
import type { FootageResult } from '../../../../vision/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatBytes, formatTime, plural } from '../../../format.ts'
import { autoCutClipCount, matchingDownloadBytes, unanalyzedClipCount } from '../../../state/autocut.ts'
import {
  analyzeFootageNow,
  clipTags,
  retryFootageAnalysis,
  startFootageAnalysis,
  useFootage,
  useFootageResults,
} from '../../../state/footage.ts'
import { addAsset, openImport } from '../../../state/importer.ts'
import { sectionKind, sectionName, sectionsOf, useProject } from '../../../state/project.ts'
import { useThumbnail } from '../../../state/thumbs.ts'
import { ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

const PICKS = 3

/** The first section of each kind (intro, verse, chorus, ...), in song order. */
function sectionGroups(project: Project): SongSection[] {
  const seen = new Set<string>()
  return sectionsOf(project).filter((s) => {
    const kind = sectionKind(s)
    if (seen.has(kind)) return false
    seen.add(kind)
    return true
  })
}

/** The tags the picks share most, up to three: why they fit the section. */
function sharedTags(project: Project, picks: readonly FootageResult[]): string[] {
  const counts = new Map<string, number>()
  for (const p of picks) for (const t of clipTags(project, p.assetId)) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t)
}

/** Bytes the matching model still needs to download, while `needed`; 0 once cached. */
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

function Pick({ asset, result, section }: { asset: Asset; result: FootageResult; section: SongSection }) {
  const project = useProject()
  const thumb = useThumbnail(asset)
  const name = asset.name.replace(/\.[^.]+$/, '')
  const tags = clipTags(project, asset.id)
  const best =
    asset.kind === 'video'
      ? `Best part ${formatTime(result.range.start)}–${formatTime(result.range.end)}`
      : ''
  const place = () =>
    addAsset(asset.id, {
      start: section.start,
      duration: Math.min(section.end - section.start, Math.max(2, result.range.end - result.range.start)),
      sourceStart: result.range.start,
    })
  return (
    <Tooltip
      label={name}
      description={
        best || tags.length ? (
          <>
            {best}
            {best && tags.length > 0 && <br />}
            {tags.join(' · ')}
          </>
        ) : undefined
      }
    >
      <button
        className={`${styles.matchThumb} ${styles.matchPick}`}
        style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
        aria-label={`Use ${name} in ${sectionName(section)}`}
        onClick={place}
      />
    </Tooltip>
  )
}

function SectionPicks({ section }: { section: SongSection }) {
  const project = useProject()
  const results = useFootageResults('section', section.id)
  const picks = (results ?? []).filter((r) => project.assets[r.assetId]).slice(0, PICKS)
  const why = sharedTags(project, picks)
  return (
    <div className={styles.matchGroup} role="group" aria-label={`Picks for ${sectionName(section)}`}>
      <div className={styles.matchHead}>
        <span className={styles.toolTitle}>{sectionName(section)}</span>
        {why.length > 0 && <span className={styles.muted}>{why.join(', ')}</span>}
      </div>
      {results && !picks.length ? (
        <div className={styles.muted}>No clip fits this section yet.</div>
      ) : (
        <div className={styles.matchRow}>
          {results
            ? picks.map((r) => {
                const asset = project.assets[r.assetId]
                return asset ? <Pick key={r.assetId} asset={asset} result={r} section={section} /> : null
              })
            : Array.from({ length: PICKS }, (_, i) => <span key={i} className={styles.matchThumb} />)}
        </div>
      )}
    </div>
  )
}

export function MatchView() {
  const project = useProject()
  const indexing = useFootage((s) => s.indexing)
  const clipCount = autoCutClipCount(project)
  const unanalyzed = unanalyzedClipCount(project)
  const analyzed = clipCount - unanalyzed
  const analyzing = indexing?.status === 'indexing'
  const failed = indexing?.status === 'error'
  const offer = clipCount > 0 && unanalyzed > 0 && !analyzing && !failed
  const download = useMatchingDownload(offer)
  const groups = sectionGroups(project)
  useEffect(startFootageAnalysis, [])

  if (!clipCount)
    return (
      <ToolView
        title="Match footage"
        subtitle="No clips yet"
        footer={
          <Button variant="primary" block icon={<Plus />} onClick={() => openImport()}>
            Import media
          </Button>
        }
      >
        <p className={styles.lede}>
          Import video clips or images. They are tagged on this device by what’s in them, their mood and
          motion, and matched to each part of the song.
        </p>
      </ToolView>
    )

  const footer = failed ? (
    <Button variant="primary" block icon={<RotateCcw />} onClick={retryFootageAnalysis}>
      Try again
    </Button>
  ) : offer ? (
    <>
      <Button variant="primary" block icon={<Sparkles />} onClick={analyzeFootageNow}>
        {analyzed ? `Analyze ${plural(unanalyzed, 'more clip')}` : 'Analyze footage'}
      </Button>
      <div className={styles.costLine}>
        <Lock /> Runs on this device · free{download ? ` · ${formatBytes(download)} download, once` : ''}
      </div>
    </>
  ) : undefined

  return (
    <ToolView
      title="Match footage"
      subtitle={`${plural(analyzed, 'clip')} tagged on this device`}
      {...(footer ? { footer } : {})}
    >
      <p className={styles.lede}>
        Clips are tagged by what’s in them, their mood and motion. Search in Media, or click a pick to place
        its best part in that section.
      </p>
      {failed ? (
        <div className={styles.failure} role="alert">
          <span className={styles.failureIcon}>
            <AlertTriangle />
          </span>
          <div>
            <div className={styles.successTitle}>
              {indexing?.error?.message ?? 'Footage analysis stopped.'}
            </div>
            <div className={styles.muted}>Your project is unchanged.</div>
          </div>
        </div>
      ) : analyzing ? (
        <div className={styles.callout}>
          <Info />
          <div>
            Analyzing your footage… {indexing?.done ?? 0} of {indexing?.total ?? clipCount} clips. Picks
            update as clips finish.
          </div>
        </div>
      ) : offer ? (
        <div className={styles.callout}>
          <Info />
          <div>
            {unanalyzed === clipCount ? 'Your clips aren’t' : `${plural(unanalyzed, 'clip')} aren’t`} analyzed
            yet. Analyze them to see the best picks for each part of the song.
          </div>
        </div>
      ) : null}
      {analyzed > 0 && groups.map((s) => <SectionPicks key={s.id} section={s} />)}
      {analyzed > 0 && !groups.length && (
        <p className={styles.muted}>Picks appear once the song’s sections are found.</p>
      )}
    </ToolView>
  )
}
