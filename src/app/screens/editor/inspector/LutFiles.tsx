import { Trash2 } from 'lucide-react'
import { useRef } from 'react'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { Dialog } from '../../../ds/Dialog.tsx'
import { LUT_FILE_TYPES, loadLut, lutFiles, lutUsage, pickFile, removeLut } from '../../../state/luts.ts'
import { useProject } from '../../../state/project.ts'
import styles from './LutFiles.module.css'

/** The LUT files imported into the project: which color grades use each, Remove, and Load a LUT file…. */
export function LutFilesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const project = useProject()
  const files = lutFiles(project)
  const removes = useRef(new Map<string, HTMLButtonElement>())
  const load = useRef<HTMLButtonElement>(null)
  const remove = (index: number) => {
    const next = files[index + 1]?.id ?? files[index - 1]?.id
    if (!removeLut(files[index]!.id)) return
    requestAnimationFrame(() => (next ? removes.current.get(next) : load.current)?.focus())
  }
  const loadFile = async () => {
    const file = await pickFile(LUT_FILE_TYPES)
    if (file) await loadLut(file)
    load.current?.focus()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="LUT files"
      description="Removing one puts the color grades that use it back to no LUT."
      width={420}
      footer={
        <Button ref={load} onClick={() => void loadFile()}>
          Load a LUT file…
        </Button>
      }
    >
      {files.length ? (
        <ul className={styles.list}>
          {files.map((asset, i) => (
            <li key={asset.id} className={styles.row}>
              <span className={styles.text}>
                <span className={styles.name}>{asset.name}</span>
                <span className={styles.usage}>{lutUsage(project, asset.id)}</span>
              </span>
              <IconButton
                ref={(el) => {
                  if (el) removes.current.set(asset.id, el)
                  else removes.current.delete(asset.id)
                }}
                label={`Remove ${asset.name}`}
                size="sm"
                tooltipSide="left"
                onClick={() => remove(i)}
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>No LUT files in this project.</p>
      )}
    </Dialog>
  )
}
