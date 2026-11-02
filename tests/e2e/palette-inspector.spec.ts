import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/index.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openEditor(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=lyric&t=73'
  })
  await waitForPreview(page)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
}

/** Selects the first clip of a type, or the first lyric line or section, and returns its id. */
async function select(page: Page, what: 'video' | 'text' | 'lyric' | 'section'): Promise<string> {
  return page.evaluate((what) => {
    const { app } = window.mvStudio
    const project: Project = app.project.editor.getProject()
    if (what === 'lyric') {
      const id: string = app.project.lyricLines(project)[0].id
      app.ui.select({ type: 'lyric', id })
      return id
    }
    if (what === 'section') {
      app.ui.select({ type: 'section', id: 's-intro' })
      return 's-intro'
    }
    const clip = Object.values(project.clips).find(
      (c) => c.type === what && !('lyricLineId' in c && c.lyricLineId),
    )!
    app.ui.select({ type: 'clip', id: clip.id })
    return clip.id
  }, what)
}

function palette(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  return {
    dialog,
    input: dialog.getByRole('combobox'),
    selected: dialog.locator('[cmdk-item][data-selected="true"]'),
    run: async (search: string) => {
      await page.keyboard.press('ControlOrMeta+k')
      await dialog.getByRole('combobox').fill(search)
      await page.keyboard.press('Enter')
    },
  }
}

const playbackRate = (page: Page, id: string) =>
  page.evaluate((id) => window.mvStudio.app.project.editor.getProject().clips[id].playbackRate as number, id)

test('a value with common choices opens a page of them for the selection, and the one picked is one undo step', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, input, selected, run } = palette(page)

  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('slow motion')
  await expect(selected).toHaveText(/^Speed…\s*Select a video clip first$/)
  await page.keyboard.press('Escape')

  const id = await select(page, 'video')
  await run('slow motion')
  await expect(input).toHaveAttribute('placeholder', 'Search speeds')
  // The speed it has now is marked.
  await expect(dialog.locator('[cmdk-item]', { hasText: /^100%/ }).locator('.lucide-check')).toBeVisible()
  await input.fill('half')
  await expect(selected).toContainText('50%')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await playbackRate(page, id)).toBe(0.5)
  const toast = page.getByRole('status').filter({ hasText: 'Speed: 50%' })
  await toast.getByRole('button', { name: 'Undo' }).click()
  expect(await playbackRate(page, id)).toBe(1)
})

test('a value without common choices puts focus on its Inspector control and marks the row', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, run } = palette(page)
  const focused = page.locator('[data-inspector] :focus')

  for (const [what, search, control] of [
    ['video', 'position', 'Position X'],
    ['text', 'text color', 'Text color'],
    ['lyric', 'line start time', 'Start time'],
    ['section', 'rename the section', 'Section name'],
  ] as const) {
    await select(page, what)
    await page.getByRole('tab', { name: 'Assist' }).click()
    await run(search)
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true')
    await expect(focused, search).toHaveAttribute('aria-label', control)
    await expect(focused.locator('xpath=ancestor::*[@data-field-row][1]')).toHaveAttribute('data-flash', '')
    await page.keyboard.press('Escape')
  }
})

test('the palette opens VJ mode with Record on, and the start screen asking to delete the project', async ({
  page,
}) => {
  await openEditor(page)
  const { run } = palette(page)
  const name = await page.evaluate(() => window.mvStudio.app.project.editor.getProject().name as string)

  await run('record a vj performance')
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: /^Record/ })).toHaveText('Recording · 0 events')
  await page.getByRole('button', { name: 'Back to editor' }).click()
  await waitForPreview(page)

  // An untouched sample isn't kept in the browser, so there is nothing to delete until it is saved.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('banner').getByText('Saved')).toBeVisible()
  await run('delete this project')
  const confirm = page.getByRole('dialog', { name: `Delete “${name}”?` })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
})

test('Record and the mapping view last the one visit the palette opened: Back into VJ mode later is a rehearsal', async ({
  page,
}) => {
  await openEditor(page)
  const { run } = palette(page)
  const live = page.getByRole('img', { name: 'Live output' })
  const record = page.getByRole('button', { name: /^Record/ })
  const mapping = page.getByText('Click a pad, then press a key or a MIDI pad to map it.')
  const shown = () => expect(live).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 })
  const toEditor = async () => {
    await page.getByRole('button', { name: 'Back to editor' }).click()
    await waitForPreview(page)
  }

  await run('record a vj performance')
  await shown()
  await expect(record).toHaveAttribute('aria-pressed', 'true')
  await toEditor()
  await page.goBack()
  await shown()
  await expect(record).toHaveAttribute('aria-pressed', 'false')
  await page.goForward()
  await waitForPreview(page)
  await page.goBack()
  await shown()
  await expect(record).toHaveAttribute('aria-pressed', 'false')
  await toEditor()

  await run('map keys and midi pads')
  await shown()
  await expect(mapping).toBeVisible()
  await toEditor()
  await page.goBack()
  await shown()
  await expect(record).toHaveAttribute('aria-pressed', 'false')
  await expect(mapping).toHaveCount(0)
})

test('Delete this project… asks even when the project’s card is beyond the ones the start screen shows, and once', async ({
  page,
}) => {
  await openEditor(page)
  const { run } = palette(page)
  const name = await page.evaluate(() => window.mvStudio.app.project.editor.getProject().name as string)
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('banner').getByText('Saved')).toBeVisible()
  // Six newer copies put this project's card after the six recent ones shown.
  await page.evaluate(async () => {
    const { app } = window.mvStudio
    const id: string = app.project.editor.getProject().id
    for (let i = 0; i < 6; i++) await app.persistence.duplicateProject(id)
  })
  const card = page.getByRole('button', { name: `More actions for ${name}`, exact: true })

  await run('delete this project')
  const confirm = page.getByRole('dialog', { name: `Delete “${name}”?` })
  await expect(confirm).toBeVisible()
  await expect(card).toHaveCount(0)
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()
  await page.getByRole('button', { name: /^Show all \d+$/ }).click()
  await expect(card).toBeVisible()
  await expect(confirm).toHaveCount(0)
})
