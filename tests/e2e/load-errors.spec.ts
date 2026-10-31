import type { Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const VJ_CODE = /\/assets\/VjMode-[^/]+\.js$/
const EXPORT_CODE = /\/assets\/ExportDialog-[^/]+\.js$/
const GUIDE_CODE = /\/assets\/FirstRunGuide-[^/]+\.js$/
const VJ_FAILED = 'VJ mode couldn’t load. Check your connection and try again.'

/**
 * Makes the code at `blocked` fail to load, as when offline before the idle preload got it, and counts the requests
 * for it (each attempt to load it is one).
 */
async function block(page: Page, blocked: RegExp): Promise<{ count: number }> {
  const requests = { count: 0 }
  await page.context().route(blocked, (route) => {
    requests.count++
    return route.abort()
  })
  return requests
}

async function openAt(page: Page, hash: string) {
  await openApp(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
}

test('a press on VJ while its code can’t load stays in the editor and says so; the next press opens VJ mode', async ({
  page,
}) => {
  const requests = await block(page, VJ_CODE)
  await openAt(page, '#/editor?t=60')
  await waitForPreview(page)
  const vj = page.getByRole('button', { name: 'VJ', exact: true })
  await vj.click()
  await expect(page.getByText(VJ_FAILED)).toBeVisible()
  await expect(vj).toBeVisible()
  await expect(vj).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()

  // Another press that fails shows the same toast again, not a second one under it.
  const before = requests.count
  await vj.click()
  await expect.poll(() => requests.count).toBeGreaterThan(before)
  await expect(vj).not.toHaveAttribute('aria-busy', 'true')
  // Counted once: a toast leaves after a few seconds, so a waiting assertion would pass once a copy had gone.
  expect(await page.getByText(VJ_FAILED).count()).toBe(1)

  await page.context().unroute(VJ_CODE)
  await vj.click()
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible({ timeout: 10_000 })
})

test('VJ mode opened directly while its code can’t load says so, and Try again opens it once the code arrives', async ({
  page,
}) => {
  const requests = await block(page, VJ_CODE)
  await openAt(page, '#/vj?t=60')
  const alert = page.getByRole('alert').filter({ hasText: 'VJ mode couldn’t load' })
  await expect(alert).toBeVisible({ timeout: 15_000 })
  await expect(alert.getByText('Check your connection and try again. Your project is saved.')).toBeVisible()
  await expect(alert.getByRole('button', { name: 'Back to editor' })).toBeVisible()
  const tryAgain = alert.getByRole('button', { name: 'Try again' })
  await expect(tryAgain).toBeFocused()

  // Try again while the code still can't load: the card comes back with the focus on Try again again.
  const before = requests.count
  await page.keyboard.press('Enter')
  await expect.poll(() => requests.count).toBeGreaterThan(before)
  await expect(tryAgain).toBeFocused()

  await page.context().unroute(VJ_CODE)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible({ timeout: 10_000 })
  await expect(alert).toBeHidden()
})

test('Esc on the card of VJ mode that can’t load goes back to the editor', async ({ page }) => {
  await block(page, VJ_CODE)
  await openAt(page, '#/vj?t=60')
  const alert = page.getByRole('alert').filter({ hasText: 'VJ mode couldn’t load' })
  await expect(alert).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(alert).toBeHidden()
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
})

test('Export whose code can’t load closes with a toast, keeps the editor, and opens on the next try', async ({
  page,
}) => {
  await block(page, EXPORT_CODE)
  await openAt(page, '#/editor?t=60')
  await waitForPreview(page)
  await page.keyboard.press(`${mod}+e`)
  await expect(page.getByText('Export couldn’t load. Check your connection and try again.')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeHidden()

  await page.context().unroute(EXPORT_CODE)
  await page.keyboard.press(`${mod}+e`)
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible({ timeout: 10_000 })
})

test('a first-visit guide whose code can’t load fails quietly and stays unseen; asked for, it says so', async ({
  page,
}) => {
  const requests = await block(page, GUIDE_CODE)
  await openApp(page)
  await page.evaluate(() => localStorage.removeItem('mv-studio.guide-seen'))
  await page.getByRole('button', { name: /Lyric video/ }).click()
  const before = requests.count
  // Opening the first project starts the guide by itself.
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect.poll(() => requests.count).toBeGreaterThan(before)
  // Not marked as seen, so it starts by itself again next time.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mv-studio.guide-seen'))).toBeNull()
  await expect(page.getByText('Start with a song')).toBeVisible()
  const failed = page.getByText('The guide couldn’t load. Check your connection and try again.')
  // Counted once, after the failure was handled: a waiting assertion would pass once the toast had left.
  expect(await failed.count()).toBe(0)

  await page.getByRole('button', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: /Replay the guide/ }).click()
  await expect(failed).toBeVisible()
})
