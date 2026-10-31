import type { Asset, EditCommand, Id, Project, PropertyPath } from '../../model/index.ts'
import { importLut, isLutAsset } from '../../plugins/lut.ts'
import { JobError, jobs } from '../../shared/jobs.ts'
import { plural } from '../format.ts'
import { JOB_KINDS } from './jobs.ts'
import { undoAction } from './library.ts'
import { dispatch, editor } from './project.ts'
import { toast } from './ui.ts'

/** The LUT files imported into the project, oldest first (Undo of a removal adds one back last, so not asset order). */
export function lutFiles(project: Project): Asset[] {
  return Object.values(project.assets)
    .filter(isLutAsset)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** The effect settings set to a LUT file: one per color grade that uses it. */
export function lutUses(project: Project, assetId: Id): { clipId: Id; trackId: Id; path: PropertyPath }[] {
  const uses: { clipId: Id; trackId: Id; path: PropertyPath }[] = []
  for (const clip of Object.values(project.clips)) {
    if (clip.type === 'audio') continue
    clip.effects.forEach((effect, i) => {
      for (const [key, param] of Object.entries(effect.params))
        if (param.value === assetId)
          uses.push({ clipId: clip.id, trackId: clip.trackId, path: ['effects', i, 'params', key, 'value'] })
    })
  }
  return uses
}

/** "Used by 2 color grades", or "Not used". */
export function lutUsage(project: Project, assetId: Id): string {
  const uses = lutUses(project, assetId).length
  return uses ? `Used by ${plural(uses, 'color grade')}` : 'Not used'
}

/** Opens the file picker for one file; null when it is closed without one. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/** What the LUT file picker takes. */
export const LUT_FILE_TYPES = '.cube,image/*'

/**
 * Turns a .cube file or Hald CLUT image into one of the project's LUTs and applies `choose(assetId)` (commands that make
 * it a setting's value) in the same undo step. A file whose LUT the project already has adds nothing: `choose` gets
 * that LUT and the toast says it is already there.
 */
export async function loadLut(file: File, choose: (assetId: Id) => EditCommand[] = () => []): Promise<void> {
  let asset: Asset
  try {
    const { mediaStore } = await import('../../media/mediaStore.ts')
    asset = await jobs.run({
      kind: JOB_KINDS.import,
      title: `Loading ${file.name}`,
      run: () => importLut(file, mediaStore, lutFiles(editor.getProject())),
    }).promise
  } catch (error) {
    if (error instanceof JobError && error.code === 'cancelled') return
    toast(`${file.name} was not loaded: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const commands = choose(asset.id)
  if (editor.getProject().assets[asset.id]) {
    const label = `Choose LUT ${asset.name}`
    const chosen = commands.length > 0 && dispatch(commands, { label })
    toast(`“${asset.name}” is already in this project.`, chosen ? undoAction(label) : undefined)
    return
  }
  const label = `Add LUT ${asset.name}`
  if (dispatch([{ type: 'asset.add', asset }, ...commands], { label }))
    toast(`Added the LUT “${asset.name}”`, undoAction(label))
}

/**
 * Removes a LUT file from the project, putting the color grades that use it back to no LUT, as one undo step. False
 * when nothing was removed.
 */
export function removeLut(assetId: Id): boolean {
  const project = editor.getProject()
  const asset = project.assets[assetId]
  if (!asset || !isLutAsset(asset)) return false
  const uses = lutUses(project, assetId)
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  if (uses.some((u) => locked.has(u.trackId))) {
    toast('A color grade that uses it is on a locked track. Unlock it to remove this LUT.')
    return false
  }
  const label = `Remove LUT ${asset.name}`
  const commands: EditCommand[] = [
    ...uses.map((u): EditCommand => ({ type: 'clip.set', clipId: u.clipId, path: u.path, value: '' })),
    { type: 'asset.remove', assetId },
  ]
  if (!dispatch(commands, { label })) return false
  const grades = uses.length
    ? ` ${plural(uses.length, 'color grade')} no longer ${uses.length === 1 ? 'uses' : 'use'} it.`
    : ''
  toast(`Removed the LUT “${asset.name}”.${grades}`, undoAction(label))
  return true
}
