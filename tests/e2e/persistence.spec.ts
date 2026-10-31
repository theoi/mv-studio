import path from 'node:path'
import type { Page } from '@playwright/test'
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
  await renameOpenProject(page, 'song', 'Night drive')
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
  await expect(card(/^Neon Skyline \(copy\)/)).toBeVisible()

  await recent.getByRole('button', { name: 'More actions for Neon Skyline (copy)' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const field = recent.getByRole('textbox', { name: 'Project name' })
  await expect(field).toBeFocused()
  await field.fill('Tour cut')
  await field.press('Enter')
  await expect(card(/^Tour cut/)).toBeVisible()
  await expect(card(/^Neon Skyline \(copy\)/)).toHaveCount(0)

  await recent.getByRole('button', { name: 'More actions for Tour cut' }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete “Tour cut”?' })
  await confirm.getByRole('button', { name: 'Delete project' }).click()
  await expect(confirm).toBeHidden()
  await expect(card(/^Tour cut/)).toHaveCount(0)
  expect(await keptCount(page)).toBe(1)

  // The original kept its media: it opens and plays its own frames.
  await card(/^Neon Skyline(?! \(copy\))/).click()
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
  await renameOpenProject(page, 'song', 'Portable')
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
