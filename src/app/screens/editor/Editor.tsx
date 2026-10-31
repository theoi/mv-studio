import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Upload } from 'lucide-react'
import { closeWithToast, guideLoadFailed, set, useUi } from '../../state/ui.ts'
import { TopBar } from './TopBar.tsx'
import { Library, LibraryRail } from './Library.tsx'
import { Preview } from './Preview.tsx'
import { RightPanel } from './RightPanel.tsx'
import { Timeline } from './timeline/Timeline.tsx'
import { CommandPalette, ExportDialog, FirstRunGuide } from '../../lazy.ts'
import { Deferred } from '../common/Deferred.tsx'
import { Splitter } from './Splitter.tsx'
import { analyzeImportsInBackground } from '../../state/footage.ts'
import { findBarsInBackground } from '../../state/songAnalysis.ts'
import { importFiles, registerImportInput } from '../../state/importer.ts'
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

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')

/** Files dragged over the editor import on drop; the overlay shows while they hover. */
function DropImport() {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let timer = 0
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setOver(true)
      // dragleave fires for every child element, so hide only once dragover stops arriving.
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setOver(false), 150)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      window.clearTimeout(timer)
      setOver(false)
      void importFiles([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
  return (
    <>
      <input
        ref={registerImportInput}
        type="file"
        multiple
        hidden
        aria-label="Import media files"
        onChange={(e) => {
          void importFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      {over && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropCard}>
            <Upload />
            <span className={styles.dropTitle}>Drop to import</span>
            <span className={styles.dropHint}>Songs, video clips and images. Files stay on this device.</span>
          </div>
        </div>
      )}
    </>
  )
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
    // After the preview's first frames, so analysis does not compete with opening the editor.
    let stop = () => {}
    const timer = window.setTimeout(() => {
      const stopFootage = analyzeImportsInBackground()
      const stopBars = findBarsInBackground()
      stop = () => {
        stopFootage()
        stopBars()
      }
    }, 1500)
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [])
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
      <Deferred when={exportOpen} onFail={closeWithToast('Export', () => set({ dialog: null }))}>
        <ExportDialog />
      </Deferred>
      <Deferred when={paletteOpen} onFail={closeWithToast('Search', () => set({ paletteOpen: false }))}>
        <CommandPalette />
      </Deferred>
      <Deferred when={guideOn} onFail={guideLoadFailed}>
        <FirstRunGuide />
      </Deferred>
      <DropImport />
    </div>
  )
}
