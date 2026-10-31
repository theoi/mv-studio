import type { Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const VJ_CODE = /\/assets\/VjMode-[^/]+\.js$/
const EXPORT_CODE = /\/assets\/ExportDialog-[^/]+\.js$/

/** Opens the app with the code at `blocked` failing to load, as when offline before the idle preload got it. */
async function openWithout(page: Page, blocked: RegExp, hash: string) {
  await page.context().route(blocked, (route) => route.abort())
  await openApp(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
}

test('a press on VJ while its code can’t load stays in the editor and says so; the next press opens VJ mode', async ({
  page,
}) => {
  await openWithout(page, VJ_CODE, '#/editor?t=60')
  await waitForPreview(page)
  const vj = page.getByRole('button', { name: 'VJ', exact: true })
  await vj.click()
  await expect(page.getByText('VJ mode couldn’t load. Check your connection and try again.')).toBeVisible()
  await expect(vj).toBeVisible()
  await expect(vj).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()

  await page.context().unroute(VJ_CODE)
  await vj.click()
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible({ timeout: 10_000 })
})

test('VJ mode opened directly while its code can’t load says so, and Try again opens it once the code arrives', async ({
  page,
}) => {
  await openWithout(page, VJ_CODE, '#/vj?t=60')
  const alert = page.getByRole('alert').filter({ hasText: 'VJ mode couldn’t load' })
  await expect(alert).toBeVisible({ timeout: 15_000 })
  await expect(alert.getByText('Check your connection and try again. Your project is saved.')).toBeVisible()
  await expect(alert.getByRole('button', { name: 'Back to editor' })).toBeVisible()

  await page.context().unroute(VJ_CODE)
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible({ timeout: 10_000 })
  await expect(alert).toBeHidden()
})

test('Export whose code can’t load closes with a toast, keeps the editor, and opens on the next try', async ({
  page,
}) => {
  await openWithout(page, EXPORT_CODE, '#/editor?t=60')
  await waitForPreview(page)
  await page.keyboard.press(`${mod}+e`)
  await expect(page.getByText('Export couldn’t load. Check your connection and try again.')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeHidden()

  await page.context().unroute(EXPORT_CODE)
  await page.keyboard.press(`${mod}+e`)
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible({ timeout: 10_000 })
})
