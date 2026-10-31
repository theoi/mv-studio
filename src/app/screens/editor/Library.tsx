import type { ReactNode } from 'react'
import { AudioWaveform, Film, PanelLeftClose, PanelLeftOpen, Type, Wand2 } from 'lucide-react'
import { IconButton } from '../../ds/Button.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ds/Tabs.tsx'
import { set, useUi, type LibraryTab } from '../../state/ui.ts'
import { EffectsTab } from './library/Effects.tsx'
import { MediaTab } from './library/Media.tsx'
import { TextTab } from './library/Text.tsx'
import { VisualsTab } from './library/Visuals.tsx'
import styles from './Library.module.css'

export function Library() {
  const tab = useUi((s) => s.libraryTab)
  return (
    <Tabs value={tab} onValueChange={(v) => set({ libraryTab: v as LibraryTab })} className={styles.root}>
      <TabsList
        ariaLabel="Library"
        trailing={
          <IconButton
            label="Collapse library"
            shortcut="Mod B"
            size="sm"
            onClick={() => set({ libraryOpen: false })}
          >
            <PanelLeftClose />
          </IconButton>
        }
      >
        <TabsTrigger value="media">Media</TabsTrigger>
        <TabsTrigger value="text">Text</TabsTrigger>
        <TabsTrigger value="visuals">Visuals</TabsTrigger>
        <TabsTrigger value="effects">Effects</TabsTrigger>
      </TabsList>
      <TabsContent value="media" className={styles.content}>
        <MediaTab />
      </TabsContent>
      <TabsContent value="text" className={styles.content}>
        <TextTab />
      </TabsContent>
      <TabsContent value="visuals" className={styles.content}>
        <VisualsTab />
      </TabsContent>
      <TabsContent value="effects" className={styles.content}>
        <EffectsTab />
      </TabsContent>
    </Tabs>
  )
}

const railTabs: { value: LibraryTab; label: string; icon: ReactNode }[] = [
  { value: 'media', label: 'Media', icon: <Film /> },
  { value: 'text', label: 'Text', icon: <Type /> },
  { value: 'visuals', label: 'Visuals', icon: <AudioWaveform /> },
  { value: 'effects', label: 'Effects', icon: <Wand2 /> },
]

/** The collapsed library: a slim rail that gives the preview more room and reopens on any tab. */
export function LibraryRail() {
  const tab = useUi((s) => s.libraryTab)
  return (
    <nav className={styles.rail} aria-label="Library">
      <IconButton
        label="Expand library"
        shortcut="Mod B"
        tooltipSide="right"
        onClick={() => set({ libraryOpen: true })}
      >
        <PanelLeftOpen />
      </IconButton>
      <span className={styles.railDivider} />
      {railTabs.map((t) => (
        <IconButton
          key={t.value}
          label={t.label}
          tooltipSide="right"
          className={t.value === tab ? styles.railOn : undefined}
          onClick={() => set({ libraryOpen: true, libraryTab: t.value })}
        >
          {t.icon}
        </IconButton>
      ))}
    </nav>
  )
}
