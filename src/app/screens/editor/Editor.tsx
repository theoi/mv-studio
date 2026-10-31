import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useUi } from '../../state/ui.ts'
import { TopBar } from './TopBar.tsx'
import { Library, LibraryRail } from './Library.tsx'
import { Preview } from './Preview.tsx'
import { RightPanel } from './RightPanel.tsx'
import { Timeline } from './timeline/Timeline.tsx'
import { CommandPalette, ExportDialog, FirstRunGuide } from '../../lazy.ts'
import { Deferred } from '../common/Deferred.tsx'
import { Splitter } from './Splitter.tsx'
import styles from './Editor.module.css'

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

type PanelSizes = { lib?: number; right?: number; tl?: number }
const SIZES_KEY = 'mv-studio.panel-sizes'

function storedSizes(): PanelSizes {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as PanelSizes) : {}
  } catch {
    return {}
  }
}

export function Editor() {
  const libraryOpen = useUi((s) => s.libraryOpen)
  const exportOpen = useUi((s) => s.dialog === 'export')
  const paletteOpen = useUi((s) => s.paletteOpen)
  const guideOn = useUi((s) => s.guideStep !== null)
  const libRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<PanelSizes>(storedSizes)
  useEffect(() => {
    try {
      localStorage.setItem(SIZES_KEY, JSON.stringify(sizes))
    } catch {
      // Not remembered when storage is unavailable.
    }
  }, [sizes])

  const style = {
    '--lib-w': sizes.lib ? `${sizes.lib}px` : undefined,
    '--right-w': sizes.right ? `${sizes.right}px` : undefined,
    '--tl-h': sizes.tl ? `${sizes.tl}px` : undefined,
  } as CSSProperties

  return (
    <div
      className={[styles.editor, !libraryOpen && styles.noLibrary].filter(Boolean).join(' ')}
      style={style}
    >
      <TopBar />
      {!libraryOpen && (
        <div className={styles.library} data-guide="library">
          <LibraryRail />
        </div>
      )}
      {libraryOpen && (
        <div ref={libRef} className={styles.library} data-guide="library">
          <Library />
          <Splitter
            orientation="vertical"
            className={styles.splitLib}
            label="Resize library"
            getStart={() => libRef.current?.getBoundingClientRect().width ?? 280}
            onDrag={(dx, start) => setSizes((s) => ({ ...s, lib: clamp(start + dx, 232, 420) }))}
          />
        </div>
      )}
      <div className={styles.preview}>
        <Preview />
      </div>
      <div ref={rightRef} className={styles.right} data-guide="right">
        <Splitter
          orientation="vertical"
          className={styles.splitRight}
          label="Resize inspector"
          getStart={() => rightRef.current?.getBoundingClientRect().width ?? 300}
          onDrag={(dx, start) => setSizes((s) => ({ ...s, right: clamp(start - dx, 272, 440) }))}
        />
        <RightPanel />
      </div>
      <div ref={timelineRef} className={styles.timeline} data-guide="timeline">
        <Splitter
          orientation="horizontal"
          className={styles.splitTimeline}
          label="Resize timeline"
          getStart={() => timelineRef.current?.getBoundingClientRect().height ?? 260}
          onDrag={(_dx, start, dy) =>
            setSizes((s) => ({ ...s, tl: clamp(start - dy, 200, window.innerHeight * 0.62) }))
          }
        />
        <Timeline />
      </div>
      <Deferred when={exportOpen}>
        <ExportDialog />
      </Deferred>
      <Deferred when={paletteOpen}>
        <CommandPalette />
      </Deferred>
      <Deferred when={guideOn}>
        <FirstRunGuide />
      </Deferred>
    </div>
  )
}
