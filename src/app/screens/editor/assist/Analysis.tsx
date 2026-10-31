import { Activity, Check } from 'lucide-react'
import { Button } from '../../../ds/Button.tsx'
import { Badge } from '../../../ds/Feedback.tsx'
import { formatBpm } from '../../../format.ts'
import { sectionKind, sectionsOf, songAnalysis, useProject } from '../../../state/project.ts'
import { ToolView } from './ToolView.tsx'
import styles from './Assist.module.css'

export function AnalysisView() {
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
          <span className="tnum">
            {analysis?.tempo ? `${formatBpm(analysis.tempo.bpm)} · 4/4` : 'Not found'}
          </span>
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
