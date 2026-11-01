import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openApp, openHarness, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const saved = (page: Page) => page.getByRole('banner').getByText('Saved', { exact: true })
const history = (page: Page) =>
  page.evaluate(() => window.mvStudio.app.project.editor.history() as { undo: string[]; redo: string[] })

async function renameOpenProject(page: Page, current: string, name: string): Promise<void> {
  await page.getByRole('button', { name: `Project: ${current}` }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const field = page.getByRole('textbox', { name: 'Project name' })
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('button', { name: `Project: ${name}` })).toBeVisible()
}

/** The app's address relative to the base URL, to open it again as a reload would. */
function relative(page: Page): string {
  const url = page.url()
  return `./${url.slice(url.indexOf('/mv-studio/') + '/mv-studio/'.length)}`
}

test('the undo history comes back with the project after a reload and after the tab crashed', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
  await renameOpenProject(page, 'Neon Skyline', 'Night drive')
  await renameOpenProject(page, 'Night drive', 'Night drive 2')
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByRole('button', { name: 'Project: Night drive' })).toBeVisible()
  await expect(saved(page)).toBeVisible()
  const before = await history(page)
  expect(before).toEqual({ undo: ['Rename project'], redo: ['Rename project'] })

  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await expect(page.getByRole('button', { name: 'Project: Night drive' })).toBeVisible()
  expect(await history(page)).toEqual(before)
  await page.keyboard.press(`${mod}+Shift+z`)
  await expect(page.getByRole('button', { name: 'Project: Night drive 2' })).toBeVisible()
  await expect(saved(page)).toBeVisible()

  // The renderer dies, as when the browser runs out of memory; the project reopens in a new tab.
  const url = relative(page)
  const cdp = await context.newCDPSession(page)
  const crashed = page.waitForEvent('crash')
  void cdp.send('Page.crash').catch(() => undefined)
  await crashed
  const next = await context.newPage()
  await openApp(next, url)
  await next.waitForFunction(() => window.mvStudio?.ready === true)
  await expect(next.getByRole('button', { name: 'Project: Night drive 2' })).toBeVisible()
  expect(await history(next)).toEqual({ undo: ['Rename project', 'Rename project'], redo: [] })
  await next.keyboard.press(`${mod}+z`)
  await next.keyboard.press(`${mod}+z`)
  await expect(next.getByRole('button', { name: 'Project: Neon Skyline' })).toBeVisible()
})

test('deleting a project keeps the media whose removal another project can still undo', async ({ page }) => {
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'image.png')])
  const kept = await page.evaluate(async () => {
    const { model, media } = window.mvStudio
    const image = await media.mediaStore.importFile(window.mvStudio.files()[0])
    const editor = new model.ProjectEditor(model.createProject({ name: 'Original' }))
    editor.dispatch({ type: 'asset.add', asset: image })
    // A duplicate shares the media of the project it was made from.
    const copy = { ...model.createProject({ name: 'Copy' }), assets: editor.getProject().assets }
    await media.projectStore.save(copy)
    editor.dispatch({ type: 'asset.remove', assetId: image.id })
    await media.projectStore.save(editor.getProject(), undefined, undefined, editor.savedHistory())
    await media.projectStore.remove(copy.id)
    return media.mediaStore.has(image) as Promise<boolean>
  })
  expect(kept).toBe(true)
})

test('a project file that carries an undo history opens without it', async ({ page }) => {
  await openHarness(page)
  const history = await page.evaluate(async () => {
    const { model, media } = window.mvStudio
    const editor = new model.ProjectEditor(model.createProject({ name: 'Made elsewhere' }))
    editor.dispatch({ type: 'project.rename', name: 'Renamed elsewhere' })
    // As written by a build that passed the stored history through unread.
    const project = { ...editor.getProject(), undoHistory: editor.savedHistory() }
    const file = new File([await media.projectStore.exportPortable(project)], 'elsewhere.mvstudio')
    const imported = await media.projectStore.importPortable(file)
    return (await media.projectStore.loadWithHistory(imported.id)).history ?? null
  })
  expect(history).toBeNull()
})
