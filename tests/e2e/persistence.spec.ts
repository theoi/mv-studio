import fs from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, launchProfile, openApp, openHarness, test, waitForPreview } from './fixtures.ts'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

interface Kept {
  id: string
  name: string
  assets: { id: string; name: string; byteSize: number }[]
  clips: number
  bpm: number | undefined
  lyrics: string[]
}

/** The open project as the test compares it before and after: ids, media, analysis and lyrics. */
function snapshot(page: Page): Promise<Kept> {
  return page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    return {
      id: p.id,
      name: p.name,
      assets: Object.values(p.assets as Record<string, { id: string; name: string; byteSize: number }>)
        .map((a) => ({ id: a.id, name: a.name, byteSize: a.byteSize }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      clips: Object.keys(p.clips).length,
      bpm: p.songAssetId ? p.analysis.audio[p.songAssetId]?.tempo?.bpm : undefined,
      lyrics: (p.lyrics?.lines ?? []).map((l: { text: string }) => l.text),
    }
  })
}

/** Byte sizes of the open project's media as read back from browser storage. */
function storedSizes(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const p = window.mvStudio.app.project.editor.getProject()
    const assets = Object.values(p.assets as Record<string, { name: string }>).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    const files: Blob[] = await Promise.all(assets.map((a) => window.mvStudio.media.mediaStore.getFile(a)))
    return files.map((f) => f.size)
  })
}

function keptCount(page: Page): Promise<number> {
  return page.evaluate(() => window.mvStudio.media.projectStore.list().then((list: unknown[]) => list.length))
}

async function openBlank(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
}

async function importFiles(page: Page, files: string[]) {
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press(`${mod}+i`)
  await (await chooser).setFiles(files.map((f) => path.join(FIXTURE_DIR, f)))
}

async function renameOpenProject(page: Page, current: string, name: string) {
  await page.getByRole('button', { name: `Project: ${current}` }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const field = page.getByRole('textbox', { name: 'Project name' })
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('button', { name: `Project: ${name}` })).toBeVisible()
}

const saved = (page: Page) => page.getByRole('banner').getByText('Saved', { exact: true })

test('a project comes back after a reload: edits, imported media, analysis and lyrics', async ({ page }) => {
  test.setTimeout(120_000)
  await openBlank(page)
  await importFiles(page, ['song.mp3', 'image.png'])
  await expect(page.getByText(/0:08 · 1[12]\d BPM · \d+ sections?/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('image, image')).toBeVisible()
  await renameOpenProject(page, 'Song', 'Night drive')
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const songId = editor.getProject().songAssetId
    editor.dispatch({
      type: 'lyrics.set',
      lyrics: {
        audioAssetId: songId,
        source: 'pasted',
        lines: [
          { id: 'l1', text: 'Neon lights are calling', start: 1, end: 3, words: [] },
          { id: 'l2', text: 'We run until the morning', start: 4, end: 6, words: [] },
        ],
      },
    })
  })
  await expect(saved(page)).toBeVisible()
  const before = await snapshot(page)
  expect(before.assets.map((a) => a.name)).toEqual(['image.png', 'song.mp3'])
  expect(before.bpm).toBeGreaterThan(100)
  expect(page.url()).toContain(`project=${before.id}`)

  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await expect(page.getByRole('button', { name: 'Project: Night drive' })).toBeVisible()
  await expect(page.getByText(/0:08 · 1[12]\d BPM · \d+ sections?/)).toBeVisible()
  await expect(page.getByLabel('image, image')).toBeVisible()
  expect(await snapshot(page)).toEqual(before)
  expect(await storedSizes(page)).toEqual(before.assets.map((a) => a.byteSize))

  // A visit without a link reopens the project the user left from the editor.
  await openApp(page, './?e2e=1')
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await expect(page.getByRole('button', { name: 'Project: Night drive' })).toBeVisible()

  // Leaving for the start screen shows it among the recent projects, and the next visit starts there.
  await page.getByRole('button', { name: 'Home' }).click()
  const recent = page.getByRole('region', { name: 'Recent projects' })
  await expect(recent.getByRole('button', { name: /Night drive.*Edited just now/ })).toBeVisible()
  await openApp(page, './?e2e=1')
  await expect(page.getByRole('heading', { name: 'What are you making?' })).toBeVisible()
  await recent.getByRole('button', { name: /^Night drive/ }).click()
  await expect(page.getByRole('button', { name: 'Project: Night drive' })).toBeVisible()
  expect((await snapshot(page)).id).toBe(before.id)
})

test('a kept project opens at its start after a reload, and a link’s time stays within its song', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openBlank(page)
  await importFiles(page, ['song.mp3'])
  await expect(page.getByText(/0:08 · 1[12]\d BPM · \d+ sections?/)).toBeVisible({ timeout: 30_000 })
  await expect(saved(page)).toBeVisible()
  const { id } = await snapshot(page)
  expect(page.url()).toContain(`project=${id}`)
  const now = page.locator('[class*="tcNow"]')
  const total = page.locator('[class*="tcTotal"]')

  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await expect(page.getByRole('button', { name: 'Project: Song' })).toBeVisible()
  await expect(total).toHaveText(/00:0[78]\.\d\d$/)
  await expect(now).toHaveText('00:00.00')

  // From another project, a link to a time past the song's end opens the song at its end.
  await page.evaluate(() => (window.location.hash = '#/editor?project=empty&kind=blank'))
  await expect(page.getByText('Start with a song')).toBeVisible()
  await page.evaluate((projectId) => (window.location.hash = `#/editor?project=${projectId}&t=60`), id)
  await expect(page.getByRole('button', { name: 'Project: Song' })).toBeVisible()
  const end = ((await total.textContent()) ?? '').replace('/', '').trim()
  expect(end).toMatch(/^00:0[78]\.\d\d$/)
  await expect(now).toHaveText(end)
})

test('an edit made right before a reload or closing the tab is kept, and the project keeps its thumbnail', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  // Leaving with a change not saved yet asks first; the user leaves anyway.
  const leaveAnyway = (p: Page) =>
    p.on('dialog', (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()))
  const status = (p: Page) =>
    p.evaluate(() => window.mvStudio.app.persistence.usePersistence.getState().status as string)
  leaveAnyway(page)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    // Saves wait 5 s after the last change, so every edit below is still unsaved when the page goes away.
    localStorage.setItem('mv-studio.prefs', JSON.stringify({ autosaveSeconds: 30 }))
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
  await page.keyboard.press(`${mod}+s`)
  await expect(page.getByText('Saved in this browser')).toBeVisible()
  const { id } = await snapshot(page)
  expect(page.url()).toContain(`project=${id}`)
  // A fresh page: its first save makes the card's thumbnail from a frame of the footage.
  await page.reload()
  await waitForPreview(page)

  let current = 'Neon Skyline'
  let open = page
  for (const [i, leave] of (['reload', 'reload', 'close'] as const).entries()) {
    const name = `Night drive ${i + 1}`
    await renameOpenProject(open, current, name)
    expect(await status(open)).toBe('pending')
    if (leave === 'reload') {
      await open.reload()
    } else {
      const url = open.url()
      const closed = new Promise((resolve) => open.once('close', resolve))
      await open.close({ runBeforeUnload: true })
      await closed
      open = await context.newPage()
      leaveAnyway(open)
      await openApp(open, url.slice(url.indexOf('/mv-studio/') + '/mv-studio/'.length).replace(/^/, './'))
    }
    await open.waitForFunction(() => window.mvStudio?.ready === true)
    await expect(open.getByRole('button', { name: `Project: ${name}` })).toBeVisible()
    expect((await snapshot(open)).id).toBe(id)
    current = name
  }
  const thumbnail = await open.evaluate(
    async (projectId) =>
      ((await window.mvStudio.media.projectStore.list()) as { id: string; thumbnail?: Blob }[]).find(
        (s) => s.id === projectId,
      )?.thumbnail?.size ?? 0,
    id,
  )
  expect(thumbnail).toBeGreaterThan(0)
})

test('a new sample never saves over a kept one, from a fresh #/editor or from Use a sample', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const kept = () =>
    page.evaluate(async () =>
      ((await window.mvStudio.media.projectStore.list()) as { id: string; name: string }[])
        .map((s) => `${s.id === 'demo-neon-skyline' ? 'legacy' : 'own'}:${s.name}`)
        .sort(),
    )
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
  // A sample kept before samples had ids of their own: every one had this id.
  await page.evaluate(async () => {
    const sample = window.mvStudio.app.project.editor.getProject()
    await window.mvStudio.media.projectStore.save({ ...sample, id: 'demo-neon-skyline', name: 'Mine A' })
  })
  await page.keyboard.press(`${mod}+s`)
  await expect(page.getByText('Saved in this browser')).toBeVisible()
  await renameOpenProject(page, 'Neon Skyline', 'Mine B')
  await expect.poll(kept).toEqual(['legacy:Mine A', 'own:Mine B'])

  // A fresh visit to #/editor shows a new sample; an edit keeps it as a project of its own.
  await page.evaluate(() => (window.location.hash = '#/editor'))
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await waitForPreview(page)
  await renameOpenProject(page, 'Neon Skyline', 'Other 1')
  await expect.poll(kept).toEqual(['legacy:Mine A', 'own:Mine B', 'own:Other 1'])

  // So does Use a sample on an empty project.
  await page.evaluate(() => (window.location.hash = '#/editor?project=empty&kind=blank'))
  await expect(page.getByText('Start with a song')).toBeVisible()
  await page.getByRole('button', { name: 'Use a sample' }).click()
  await waitForPreview(page)
  await renameOpenProject(page, 'Neon Skyline', 'Other 2')
  await expect.poll(kept).toEqual(['legacy:Mine A', 'own:Mine B', 'own:Other 1', 'own:Other 2'])

  // The kept sample with the old id still opens from a link.
  await page.evaluate(() => (window.location.hash = '#/editor?project=demo-neon-skyline'))
  await expect(page.getByRole('button', { name: 'Project: Mine A' })).toBeVisible()
})

test('the sample is only kept once it changes or Mod S is pressed', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
  await expect(saved(page)).toBeVisible()
  // Looking around and background analysis don't keep it.
  await page.waitForTimeout(1500)
  expect(await keptCount(page)).toBe(0)

  await page.keyboard.press(`${mod}+s`)
  await expect(page.getByText('Saved in this browser')).toBeVisible()
  expect(await keptCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Home' }).click()
  const card = page
    .getByRole('region', { name: 'Recent projects' })
    .getByRole('button', { name: /^Neon Skyline/ })
  await expect(card).toBeVisible()
  // The card shows a frame of the project's footage.
  await expect(card.locator('span').first()).toHaveAttribute('style', /background-image: url\("data:image/)
})

test('recent projects can be duplicated, renamed and deleted from the start screen', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
  await page.keyboard.press(`${mod}+s`)
  await expect(page.getByText('Saved in this browser')).toBeVisible()
  await page.getByRole('button', { name: 'Home' }).click()
  const recent = page.getByRole('region', { name: 'Recent projects' })
  const card = (name: string | RegExp) => recent.getByRole('button', { name })

  await recent.getByRole('button', { name: 'More actions for Neon Skyline' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(card(/^Neon Skyline \(2\)/)).toBeVisible()
  // A copy of a copy takes the next number, so no two tiles (or their exports) share a name.
  await recent.getByRole('button', { name: 'More actions for Neon Skyline (2)' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(card(/^Neon Skyline \(3\)/)).toBeVisible()

  await recent.getByRole('button', { name: 'More actions for Neon Skyline (3)' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const field = recent.getByRole('textbox', { name: 'Project name' })
  await expect(field).toBeFocused()
  await field.fill('Tour cut')
  await field.press('Enter')
  await expect(card(/^Tour cut/)).toBeVisible()
  await expect(card(/^Neon Skyline \(3\)/)).toHaveCount(0)

  await recent.getByRole('button', { name: 'More actions for Tour cut' }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete “Tour cut”?' })
  await confirm.getByRole('button', { name: 'Delete project' }).click()
  await expect(confirm).toBeHidden()
  await expect(card(/^Tour cut/)).toHaveCount(0)
  expect(await keptCount(page)).toBe(2)

  // The original kept its media: it opens and plays its own frames.
  await card(/^Neon Skyline(?! \()/).click()
  await waitForPreview(page)
  await expect(page.getByRole('button', { name: 'Project: Neon Skyline' })).toBeVisible()
})

test('a project file carries the project and its media into another browser profile', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  await openBlank(page)
  await importFiles(page, ['song.mp3', 'image.png'])
  await expect(page.getByLabel('image, image')).toBeVisible()
  await renameOpenProject(page, 'Song', 'Portable')
  await expect(saved(page)).toBeVisible()
  const before = await snapshot(page)

  await page.getByRole('button', { name: 'Project: Portable' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /Download project file/ }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('Portable.mvstudio')
  const saveTo = testInfo.outputPath('Portable.mvstudio')
  await file.saveAs(saveTo)

  const other = await launchProfile(testInfo.outputPath('second-profile'), baseURL)
  try {
    const page2 = other.pages()[0] ?? (await other.newPage())
    await openHarness(page2)
    await expect(page2.getByRole('heading', { name: 'What are you making?' })).toBeVisible()
    await expect(page2.getByRole('region', { name: 'Recent projects' })).toHaveCount(0)
    const chooser = page2.waitForEvent('filechooser')
    await page2.getByRole('button', { name: 'Open project file' }).click()
    await (await chooser).setFiles(saveTo)
    await expect(page2.getByRole('button', { name: 'Project: Portable' })).toBeVisible({ timeout: 30_000 })
    const opened = await snapshot(page2)
    expect(opened).toEqual(before)
    expect(await storedSizes(page2)).toEqual(before.assets.map((a) => a.byteSize))
    expect(await keptCount(page2)).toBe(1)
  } finally {
    await other.close()
  }
})

/** A WAV file of a tone, about 21 MB, so restoring it takes several 8 MB writes. */
function writeLongWav(file: string): void {
  const rate = 44100
  const samples = 120 * rate * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples * 2, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples * 2, 40)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(8000 * Math.sin((i >> 1) * 0.0627)), i * 2)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

/** A copy of the project file `file` without the entry whose name ends with `suffix`. */
function withoutEntry(file: string, suffix: string, out: string): void {
  const tar = fs.readFileSync(file)
  const text = (from: number, length: number) =>
    tar.toString('latin1', from, from + length).replace(/\0.*$/s, '')
  const kept: Buffer[] = []
  let offset = 0
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some((b) => b !== 0)) {
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8)
    const prefix = text(offset + 345, 155)
    const name = `${prefix ? `${prefix}/` : ''}${text(offset, 100)}`
    const end = offset + 512 + Math.ceil(size / 512) * 512
    if (!name.endsWith(suffix)) kept.push(tar.subarray(offset, end))
    offset = end
  }
  fs.writeFileSync(out, Buffer.concat([...kept, Buffer.alloc(1024)]))
}

/**
 * Makes a project of a long song (about 21 MB), a clip and an image, in that order, and downloads its project file.
 * Returns the file and the media's names.
 */
async function downloadPortable(page: Page, testInfo: TestInfo): Promise<{ file: string; names: string[] }> {
  const wav = testInfo.outputPath('long.wav')
  writeLongWav(wav)
  await openBlank(page)
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press(`${mod}+i`)
  await (await chooser).setFiles(wav)
  await expect(page.getByRole('button', { name: 'Project: long' })).toBeVisible({ timeout: 30_000 })
  await importFiles(page, ['clip.mp4', 'image.png'])
  await expect(page.getByLabel('image, image')).toBeVisible()
  await expect(page.getByLabel('clip, video')).toBeVisible()
  await renameOpenProject(page, 'long', 'Portable')
  await expect(saved(page)).toBeVisible()
  const names = (await snapshot(page)).assets.map((a) => a.name)
  await page.getByRole('button', { name: 'Project: Portable' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /Download project file/ }).click()
  const file = testInfo.outputPath('Portable.mvstudio')
  await (await download).saveAs(file)
  await page.keyboard.press('Escape')
  return { file, names }
}

/** Makes each write to browser storage on `page` wait until `release()` lets it through. */
async function holdWrites(page: Page): Promise<{ release(): Promise<void> }> {
  await page.evaluate(() => {
    const w = window as unknown as { held: (() => void)[] }
    w.held = []
    const proto = FileSystemWritableFileStream.prototype
    const write = proto.write
    proto.write = function (this: FileSystemWritableFileStream, ...args: Parameters<typeof write>) {
      return new Promise<void>((resolve, reject) =>
        w.held.push(() => write.apply(this, args).then(resolve, reject)),
      )
    }
  })
  return {
    async release() {
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { held: unknown[] }).held.length))
        .toBe(1)
      await page.evaluate(() => (window as unknown as { held: (() => void)[] }).held.shift()?.())
    },
  }
}

async function openProjectFileIn(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open project file' }).click()
  await (await chooser).setFiles(file)
}

/** How many media folders the profile's browser storage holds. */
function mediaFolders(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const media = await root.getDirectoryHandle('media').catch(() => null)
    let n = 0
    if (media) for await (const _ of media.keys()) n++
    return n
  })
}

/** The opening card's restore line ("long.wav · 1 of 3 files") and percentage. */
async function restoreStep(page: Page): Promise<{ line: string; percent: number }> {
  const text = await page.getByRole('region', { name: /^Opening / }).innerText()
  return { line: /Restoring (.+ files)/.exec(text)?.[1] ?? '', percent: Number(/(\d+)%/.exec(text)?.[1]) }
}

test('opening a project file shows how far each file is, and a Cancel part way through a file leaves nothing behind', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000)
  const { file, names } = await downloadPortable(page, testInfo)
  const longName = `${'Portable tour cut '.repeat(6)}final.mvstudio`
  const longFile = testInfo.outputPath(longName)
  fs.copyFileSync(file, longFile)
  const other = await launchProfile(testInfo.outputPath('second-profile'), baseURL)
  try {
    const page2 = other.pages()[0] ?? (await other.newPage())
    await openHarness(page2)
    const writes = await holdWrites(page2)
    const opening = page2.getByRole('region', { name: /^Opening / })
    const openButton = page2.getByRole('button', { name: 'Open project file' })

    await openProjectFileIn(page2, longFile)
    await expect(opening).toContainText('Restoring long.wav · 1 of 3 files')
    await expect(openButton).toBeDisabled()
    // Starting another project now would be replaced by the file's project when it is in.
    await expect(page2.getByRole('button', { name: /^Lyric video/ })).toBeDisabled()
    await expect(page2.getByRole('button', { name: /^Blank project/ })).toBeDisabled()
    // The cut-off title gives the whole file name on hover.
    await opening.getByRole('heading').hover()
    await expect(opening.getByRole('heading')).toHaveAttribute('title', `Opening ${longName}`)
    expect((await restoreStep(page2)).percent).toBe(0)
    // The song's first 8 MB are in: the percentage moves within the file.
    await writes.release()
    await expect.poll(async () => (await restoreStep(page2)).percent).toBeGreaterThan(0)
    expect((await restoreStep(page2)).line).toBe('long.wav · 1 of 3 files')
    await opening.getByRole('button', { name: 'Cancel' }).click()
    await expect(openButton).toBeFocused()
    await writes.release()
    await expect(opening).toBeHidden()
    await expect(openButton).toBeEnabled()
    await expect(page2.getByRole('button', { name: /^Lyric video/ })).toBeEnabled()
    await expect(page2.getByRole('heading', { name: 'What are you making?' })).toBeVisible()
    expect(await keptCount(page2)).toBe(0)
    expect(await mediaFolders(page2)).toBe(0)

    await openProjectFileIn(page2, file)
    const steps: { line: string; percent: number }[] = []
    for (let i = 0; i < 5; i++) {
      await expect(opening).toContainText('Restoring')
      if (i === 0) {
        await opening.getByRole('heading').hover()
        await expect(opening.getByRole('heading')).toHaveAttribute('title', '')
      }
      const step = await restoreStep(page2)
      steps.push(step)
      await writes.release()
      if (i < 4)
        await expect.poll(async () => (await restoreStep(page2)).percent).toBeGreaterThan(step.percent)
    }
    await expect(page2.getByRole('button', { name: 'Project: Portable' })).toBeVisible()
    await expect(page2.getByText('Opened “Portable”')).toBeVisible()
    // Three writes for the song, one each for the clip and the image, with the percentage rising at every one.
    expect(steps.slice(0, 3).map((s) => s.line)).toEqual(Array(3).fill('long.wav · 1 of 3 files'))
    expect(steps[3]?.line).toMatch(/ · 2 of 3 files$/)
    expect(steps[4]?.line).toMatch(/ · 3 of 3 files$/)
    expect(
      steps
        .map((s) => /^(.+) · /.exec(s.line)?.[1])
        .slice(2)
        .sort(),
    ).toEqual([...names].sort())
    const percents = steps.map((s) => s.percent)
    expect(percents[0]).toBe(0)
    expect(percents).toEqual([...new Set(percents)].sort((a, b) => a - b))
    expect(await storedSizes(page2)).toEqual((await snapshot(page2)).assets.map((a) => a.byteSize))
  } finally {
    await other.close()
  }
})

test('a project file opens whole after a tab was closed part way through opening it', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000)
  const { file } = await downloadPortable(page, testInfo)
  const other = await launchProfile(testInfo.outputPath('second-profile'), baseURL)
  try {
    const page2 = other.pages()[0] ?? (await other.newPage())
    await openHarness(page2)
    const writes = await holdWrites(page2)
    await openProjectFileIn(page2, file)
    await writes.release()
    await expect.poll(async () => (await restoreStep(page2)).percent).toBeGreaterThan(0)
    // Closed while the song's second chunk is being written: the song's file stays behind, empty.
    await page2.close()

    const page3 = await other.newPage()
    await openHarness(page3)
    await openProjectFileIn(page3, file)
    await expect(page3.getByRole('button', { name: 'Project: Portable' })).toBeVisible({ timeout: 30_000 })
    expect(await storedSizes(page3)).toEqual((await snapshot(page3)).assets.map((a) => a.byteSize))
  } finally {
    await other.close()
  }
})

test('a project file that lacks a media file fails to open and leaves no media of its own behind', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000)
  const { file } = await downloadPortable(page, testInfo)
  const broken = testInfo.outputPath('Broken.mvstudio')
  withoutEntry(file, '/image.png', broken)
  const missing = 'The project file is missing media for "image.png"'

  const other = await launchProfile(testInfo.outputPath('second-profile'), baseURL)
  try {
    const page2 = other.pages()[0] ?? (await other.newPage())
    await openHarness(page2)
    await openProjectFileIn(page2, broken)
    await expect(page2.getByText(missing)).toBeVisible({ timeout: 30_000 })
    await expect(page2.getByRole('heading', { name: 'What are you making?' })).toBeVisible()
    expect(await keptCount(page2)).toBe(0)
    expect(await mediaFolders(page2)).toBe(0)
  } finally {
    await other.close()
  }

  // Where the project is kept, the failed open keeps the files that were already there.
  await page.getByRole('button', { name: 'Project: Portable' }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: /Open project file/ }).click()
  await (await chooser).setFiles(broken)
  await page
    .getByRole('dialog', { name: '“Portable” is already in this browser' })
    .getByRole('button', { name: 'Keep a copy' })
    .click()
  await expect(page.getByText(missing)).toBeVisible({ timeout: 30_000 })
  expect(await storedSizes(page)).toEqual((await snapshot(page)).assets.map((a) => a.byteSize))
  expect(await keptCount(page)).toBe(1)
})
async function openFromMenu(page: Page, current: string, file: string) {
  await page.getByRole('button', { name: `Project: ${current}` }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: /Open project file/ }).click()
  await (await chooser).setFiles(file)
}

/** A copy of a project file whose project has another id of the same length: another project of the same name. */
function withOtherId(file: string, id: string, out: string): void {
  const other = (id[0] === 'a' ? 'b' : 'a') + id.slice(1)
  fs.writeFileSync(out, Buffer.from(fs.readFileSync(file).toString('latin1').replaceAll(id, other), 'latin1'))
}

test('opening a project file of a project already here asks whether to open that one or keep a copy', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  await openBlank(page)
  await importFiles(page, ['song.mp3', 'image.png'])
  await expect(page.getByLabel('image, image')).toBeVisible()
  await renameOpenProject(page, 'song', 'Portable')
  await expect(saved(page)).toBeVisible()
  const before = await snapshot(page)
  await page.getByRole('button', { name: 'Project: Portable' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /Download project file/ }).click()
  const file = testInfo.outputPath('Portable.mvstudio')
  await (await download).saveAs(file)
  await page.keyboard.press('Escape')
  // An edit after the download: the project here is newer than the file's.
  await page.keyboard.press('t')
  await expect.poll(async () => (await snapshot(page)).clips).toBe(before.clips + 1)
  await expect(saved(page)).toBeVisible()
  const folders = await mediaFolders(page)

  await page.getByRole('button', { name: 'Home' }).click()
  const ask = page.getByRole('dialog', { name: '“Portable” is already in this browser' })
  const openButton = page.getByRole('button', { name: 'Open project file' })
  await openProjectFileIn(page, file)
  await expect(ask).toContainText('keep the file’s version too, as “Portable (2)”')
  // Both were edited "just now", so the times are clock times.
  await expect(ask.getByRole('definition').first()).toHaveText(
    /^Edited \d{1,2}:\d{2}(:\d{2})? [AP]M · newer$/,
  )
  await expect(ask).toContainText('“Portable.mvstudio” holds a project you already have here.')
  await expect(ask.getByRole('term').nth(1)).toHaveText('In the file')
  await page.keyboard.press('Escape')
  await expect(ask).toBeHidden()
  await expect(openButton).toBeFocused()
  await expect(page.getByRole('heading', { name: 'What are you making?' })).toBeVisible()
  expect(await keptCount(page)).toBe(1)

  await openProjectFileIn(page, file)
  await ask.getByRole('button', { name: 'Open the one here' }).click()
  await expect(page.getByRole('button', { name: 'Project: Portable' })).toBeVisible()
  expect(await snapshot(page)).toEqual({ ...before, clips: before.clips + 1 })
  expect(await keptCount(page)).toBe(1)
  // Asked again while editing it, the one here is already open.
  await openFromMenu(page, 'Portable', file)
  await ask.getByRole('button', { name: 'Open the one here' }).click()
  await expect(page.getByText('“Portable” is already open')).toBeVisible()
  expect(await snapshot(page)).toEqual({ ...before, clips: before.clips + 1 })

  // Keep a copy: nothing is restored while the question is up, then only the file missing here.
  await page.evaluate(async () => {
    const p = window.mvStudio.app.project.editor.getProject()
    const image = Object.values(p.assets as Record<string, { name: string }>).find(
      (a) => a.name === 'image.png',
    )
    await window.mvStudio.media.mediaStore.remove(image)
  })
  const writes = await holdWrites(page)
  await openFromMenu(page, 'Portable', file)
  await expect(ask).toContainText('keep the file’s version too, as “Portable (2)”')
  // A restore started before the answer would have a write held by now.
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as unknown as { held: unknown[] }).held.length)).toBe(0)
  await ask.getByRole('button', { name: 'Keep a copy' }).click()
  await writes.release()
  await expect(page.getByRole('button', { name: 'Project: Portable (2)' })).toBeVisible({ timeout: 30_000 })
  const copy = await snapshot(page)
  expect(copy.id).not.toBe(before.id)
  expect(copy).toEqual({ ...before, id: copy.id, name: 'Portable (2)' })
  expect(await storedSizes(page)).toEqual(copy.assets.map((a) => a.byteSize))
  expect(await keptCount(page)).toBe(2)
  // The copy uses the media already here instead of storing it twice.
  expect(await mediaFolders(page)).toBe(folders)

  // A second copy gets a name of its own too.
  await openFromMenu(page, 'Portable (2)', file)
  await expect(ask).toContainText('as “Portable (3)”')
  await ask.getByRole('button', { name: 'Keep a copy' }).click()
  await expect(page.getByRole('button', { name: 'Project: Portable (3)' })).toBeVisible({ timeout: 30_000 })
  expect(await keptCount(page)).toBe(3)

  // Another project of the same name opens without the question, under a name no kept project has.
  const others = testInfo.outputPath('Others.mvstudio')
  withOtherId(file, before.id, others)
  await openFromMenu(page, 'Portable (3)', others)
  await expect(page.getByRole('button', { name: 'Project: Portable (4)' })).toBeVisible({ timeout: 30_000 })
  expect(await keptCount(page)).toBe(4)
})
test('a failed save says so, and saving again works', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
  await page.evaluate(() => window.mvStudio.app.persistence.failSavesForTests('storage-quota'))
  await page.keyboard.press('t')
  const notSaved = page.getByRole('button', { name: 'Not saved' })
  await expect(notSaved).toBeVisible()
  await expect(page.getByText('This browser’s storage is full.', { exact: false }).first()).toBeVisible()
  expect(await keptCount(page)).toBe(0)

  await page.evaluate(() => window.mvStudio.app.persistence.failSavesForTests(null))
  await notSaved.click()
  await expect(saved(page)).toBeVisible()
  expect(await keptCount(page)).toBe(1)
})
