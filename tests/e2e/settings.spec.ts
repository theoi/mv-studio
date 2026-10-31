import { expect, openHarness, test, waitForPreview } from './fixtures.ts'
import type { Page } from '@playwright/test'

async function openSettings(page: Page, settingsPage: string) {
  await page.evaluate((p) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = `#/editor?dialog=settings&page=${p}`
  }, settingsPage)
  return page.getByRole('dialog', { name: 'Settings' })
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test('the CPU thread limit for AI is saved and read again by a fresh page', async ({ page }) => {
  await openHarness(page)
  const dialog = await openSettings(page, 'local')
  await choose(page, 'CPU threads for AI', '1')
  await expect(dialog.getByText(/^AI and analysis use 1 of \d+ CPU threads\.$/)).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.mvStudio.shared.detectCapabilities().then((c: { wasmThreads: number }) => c.wasmThreads),
      ),
    )
    .toBe(1)

  // A reload is a new realm, like the workers that run the models.
  await page.reload()
  await openHarness(page)
  await openSettings(page, 'local')
  await expect(page.getByRole('combobox', { name: 'CPU threads for AI' })).toHaveText('1')
  const fresh = await page.evaluate(() => window.mvStudio.shared.detectCapabilities())
  expect(fresh.wasmThreads).toBe(1)

  await choose(page, 'CPU threads for AI', `Automatic (${fresh.autoWasmThreads})`)
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.mvStudio.shared.detectCapabilities().then((c: { wasmThreads: number }) => c.wasmThreads),
      ),
    )
    .toBe(fresh.autoWasmThreads)
})

test('General and Editing settings apply where they belong and are remembered', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?sel=clip:c-s-c1-1&t=67.2'
  })
  await waitForPreview(page)
  const suggestion = page.getByRole('note').filter({ hasText: 'Put the lyrics behind them?' })
  await expect(suggestion).toBeVisible()

  const dialog = await openSettings(page, 'general')
  await dialog.getByRole('switch', { name: 'Inline suggestions' }).click()
  await dialog.getByRole('switch', { name: 'Reduce motion' }).click()
  const duration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--dur').trim(),
  )
  expect(parseFloat(duration)).toBe(0)
  await choose(page, 'Default frame rate', '24 fps')
  await dialog.getByRole('button', { name: 'Editing' }).click()
  await dialog.getByRole('switch', { name: 'Snap to beats by default' }).click()
  await choose(page, 'Default text duration', '1 bar')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(suggestion).toBeHidden()

  // Text is one bar long at the sample's 120 BPM.
  await page.keyboard.press('t')
  const text = await page.evaluate(() => {
    const clips = Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
      name?: string
      duration: number
    }[]
    return clips.find((c) => c.name === 'Text')!
  })
  expect(text.duration).toBe(2)

  await page.reload()
  await openHarness(page)
  await page.evaluate(() => {
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByRole('button', { name: 'Import' }).first()).toBeVisible()
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.getProject().settings.fps)).toBe(24)
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-reduce-motion'))).toBe(true)
  await openSettings(page, 'editing')
  await expect(page.getByRole('switch', { name: 'Snap to beats by default' })).not.toBeChecked()
  await expect(page.getByRole('combobox', { name: 'Default text duration' })).toHaveText('1 bar')
})

test('About opens the third-party notices', async ({ page, context }) => {
  await context.route('https://github.com/**', (route) => route.fulfill({ body: 'notices' }))
  await openHarness(page)
  const dialog = await openSettings(page, 'about')
  const [notices] = await Promise.all([
    context.waitForEvent('page'),
    dialog.getByRole('button', { name: 'View' }).click(),
  ])
  await notices.waitForURL(/THIRD_PARTY_NOTICES\.md$/)
})
