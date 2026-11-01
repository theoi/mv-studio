/**
 * What the browser clearing the site's storage cost, as the note after it says. Browsers clear it when the disk is
 * nearly full and storage isn't persistent: every kept project and all media go at once, while the open project stays
 * in memory.
 */
import type { Asset, Id, Project, SavedHistory } from '../../model/index.ts'
import { plural } from '../format.ts'
import { isSampleAsset } from '../mock/sampleMedia.ts'
import { isLutAsset } from '../../plugins/lut.ts'

export interface StorageLoss {
  /** The open project: written again, failed to be written again, or not one worth keeping. */
  project: 'saved' | 'not-saved' | 'not-kept'
  /** Its imported files and recordings that are gone. */
  files: number
  /** Its generated clips and images that are gone. */
  clips: number
  images: number
  /** Other kept projects that are gone. */
  others: number
}

/**
 * The project's media that are gone, by what bringing them back takes: import the file again, or generate it again.
 * Stems, masks and other media made from them are left out, since they are made again from what they came from. LUTs
 * are made from an imported file too, but only importing it again brings them back.
 */
export async function lostMedia(
  project: Project,
  has: (asset: Asset) => Promise<boolean>,
): Promise<Pick<StorageLoss, 'files' | 'clips' | 'images'>> {
  const assets = Object.values(project.assets).filter(
    (a) => !isSampleAsset(a) && (isLutAsset(a) || (a.origin.type !== 'stem' && a.origin.type !== 'derived')),
  )
  const present = await Promise.all(assets.map((a) => has(a).catch(() => false)))
  const gone = assets.filter((_, i) => !present[i])
  const generated = gone.filter((a) => a.origin.type === 'generated')
  return {
    files: gone.length - generated.length,
    clips: generated.filter((a) => a.kind !== 'image').length,
    images: generated.filter((a) => a.kind === 'image').length,
  }
}

function list(parts: (string | false)[]): string {
  const shown = parts.filter((p): p is string => !!p)
  return shown.length < 2 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** The note that says the browser cleared the site's storage, what of it was kept and lost, and what to do; null when nothing was lost. */
export function storageClearedMessage(loss: StorageLoss): string | null {
  const { files, clips, images, others } = loss
  const lostCount = files + clips + images
  const lost = list([
    files > 0 && plural(files, 'media file'),
    clips > 0 && plural(clips, 'generated clip'),
    images > 0 && plural(images, 'generated image'),
  ])
  if (!lostCount && !others && loss.project !== 'not-saved') return null
  const are = lostCount === 1 ? 'is' : 'are'
  const project =
    loss.project === 'saved'
      ? lost
        ? `This project’s edits are kept, but its ${lost} ${are} gone.`
        : 'This project is kept.'
      : loss.project === 'not-saved'
        ? `This project is still open but couldn’t be saved again${lost ? `, and its ${lost} ${are} gone` : ''}.`
        : lost
          ? `This project’s ${lost} ${are} gone.`
          : ''
  const otherProjects = !others
    ? ''
    : loss.project === 'not-kept'
      ? `${others === 1 ? 'Your project' : `Your ${others} projects`} in this browser ${others === 1 ? 'was' : 'were'} cleared.`
      : `${others === 1 ? 'Your other project' : `Your ${others} other projects`} in this browser ${others === 1 ? 'was' : 'were'} cleared too.`
  const generated = list([
    clips > 0 && (clips === 1 ? 'clip' : 'clips'),
    images > 0 && (images === 1 ? 'image' : 'images'),
  ])
  const imported = files === 1 ? 'file' : 'files'
  const remake = !lostCount
    ? ''
    : !generated
      ? `import the ${imported} again`
      : !files
        ? `generate the ${generated} again`
        : `import the ${imported} and generate the ${generated} again,`
  // The clips that showed them still point at the media that went, so new ones have to take their place.
  const todo = remake
    ? `Free some disk space, then ${remake} and put ${lostCount === 1 ? 'it' : 'them'} back in the timeline.`
    : 'Free some disk space before you go on.'
  return [
    'The browser cleared MV Studio’s storage, as it does when the disk is nearly full.',
    project,
    otherProjects,
    todo,
  ]
    .filter(Boolean)
    .join(' ')
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs `run`, which uses the database, trying again for a few seconds: opening it fails while the browser is still
 * deleting it.
 */
export async function whenReopened<T>(run: () => Promise<T>, wait = sleep): Promise<T> {
  for (let ms = 50; ; ms *= 2) {
    try {
      return await run()
    } catch (error) {
      if (ms > 1600) throw error
      await wait(ms)
    }
  }
}

/**
 * Writes the open project again once the browser cleared its record, trying again as `whenReopened` does. Each try
 * writes the project as `open` gives it then, with its own undo history, so an edit autosave wrote meanwhile is never
 * written over by an older copy; once another project is open, it stops. Says whether it wrote the project.
 */
export async function writeAgain(
  id: Id,
  open: () => { project: Project; history?: SavedHistory },
  write: (project: Project, history?: SavedHistory) => Promise<void>,
  wait = sleep,
): Promise<boolean> {
  let wrote = false
  await whenReopened(async () => {
    const { project, history } = open()
    if (project.id !== id) return
    await write(project, history)
    wrote = true
  }, wait)
  return wrote
}
