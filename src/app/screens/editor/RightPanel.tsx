import { Sparkles } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs.tsx'
import { ProgressRing } from '../../ds/Feedback.tsx'
import { set, useUi, type RightTab } from '../../state/ui.ts'
import { runningJobs, useJobs } from '../../state/jobs.ts'
import { Inspector } from './Inspector.tsx'
import { Assist } from './assist/Assist.tsx'
import styles from './RightPanel.module.css'

export function RightPanel() {
  const tab = useUi((s) => s.rightTab)
  const running = runningJobs(useJobs()).find((j) => !j.kind.startsWith('export'))
  return (
    <Tabs value={tab} onValueChange={(v) => set({ rightTab: v as RightTab })} className={styles.root}>
      <TabsList ariaLabel="Right panel">
        <TabsTrigger value="inspector">Inspector</TabsTrigger>
        <TabsTrigger
          value="assist"
          icon={<Sparkles className={styles.sparkle} />}
          trailing={
            running ? (
              <ProgressRing value={running.progress.fraction ?? 0} size={14} label={running.title} />
            ) : undefined
          }
        >
          Assist
        </TabsTrigger>
      </TabsList>
      <TabsContent value="inspector" className={styles.content}>
        <Inspector />
      </TabsContent>
      <TabsContent value="assist" className={styles.content}>
        <Assist />
      </TabsContent>
    </Tabs>
  )
}
