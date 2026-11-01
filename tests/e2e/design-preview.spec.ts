import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditorAt(page: Page, hash: string) {
  await openApp(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
}

test('a new user goes from the start screen to the editor and sees the guide once', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: /^Lyric video/ }).click()
  await expect(page.getByRole('heading', { name: 'Lyric video' })).toBeVisible()

  const open = page.getByRole('button', { name: 'Open the editor' })
  await expect(open).toBeDisabled()
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await open.click()

  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
  const guide = page.getByRole('dialog', { name: 'Getting started guide' })
  await expect(guide).toBeVisible()
  await guide.getByRole('button', { name: 'Skip' }).click()
  await expect(guide).toBeHidden()

  await page.getByRole('button', { name: 'Home' }).click()
  await page.getByRole('button', { name: /^Lyric video/ }).click()
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByText('Start with a song')).toBeVisible()
  await expect(guide).toBeHidden()
})

test('split at the playhead is one undoable edit', async ({ page }) => {
  await openEditorAt(page, '#/editor?sel=clip:c-s-c1-1&t=67')
  const whole = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  await expect(whole).toBeVisible()

  await page.keyboard.press('s')
  await expect(page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:07.0' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Singer close-up, 1:07.0 to 1:08.0' })).toBeVisible()
  await expect(whole).toBeHidden()

  await page.keyboard.press(`${mod}+z`)
  await expect(whole).toBeVisible()
})

test('the command palette finds tools and opens them in Assist', async ({ page }) => {
  await openEditorAt(page, '#/editor?t=73.6')
  await page.keyboard.press(`${mod}+k`)
  const palette = page.getByRole('dialog')
  await palette.getByRole('combobox').fill('stems')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByRole('button', { name: 'Separate stems' })).toBeVisible()
})

test('export runs as cancellable jobs', async ({ page }) => {
  await openEditorAt(page, '#/editor?t=73.6')
  await page.keyboard.press(`${mod}+e`)
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await dialog.getByLabel('Include Vertical').check()
  await dialog.getByRole('button', { name: 'Export 2 files' }).click()
  await expect(dialog.getByText('Exporting 2 files')).toBeVisible()
  await expect(dialog.getByRole('progressbar', { name: 'Full video progress' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Cancel all' }).click()
  await expect(dialog.getByRole('button', { name: 'Export 2 files' })).toBeVisible()
})
