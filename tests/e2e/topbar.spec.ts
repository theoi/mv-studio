import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openEditor(page: Page, hash = '#/editor?t=67') {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

test('the top bar Undo and Redo buttons name the edit they step through', async ({ page }) => {
  await openEditor(page, '#/editor?sel=clip:c-s-c1-1&t=67')
  const bar = page.getByRole('banner')
  const whole = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  const firstHalf = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:07.0' })
  await expect(bar.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  await expect(bar.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled()

  await page.keyboard.press('s')
  await expect(firstHalf).toBeVisible()
  await bar.getByRole('button', { name: 'Undo split clip' }).click()
  await expect(whole).toBeVisible()
  await expect(firstHalf).toBeHidden()
  await expect(bar.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()

  await bar.getByRole('button', { name: 'Redo split clip' }).click()
  await expect(firstHalf).toBeVisible()
  await expect(whole).toBeHidden()
  await expect(bar.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled()
  await expect(bar.getByRole('button', { name: 'Undo split clip' })).toBeEnabled()
})

test('the search field opens the command palette, which runs the action picked and gives focus back', async ({
  page,
}) => {
  await openEditor(page)
  const bar = page.getByRole('banner')
  const search = bar.getByRole('button', { name: /^Search actions, tools and settings/ })
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByRole('combobox')

  await search.click()
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(search).toBeFocused()

  // A dialog opened from the palette gives focus back to what opened the palette.
  await search.click()
  await input.fill('keyboard shortcuts')
  await page.keyboard.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'Shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(search).toBeFocused()

  await search.click()
  await input.fill('add text')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(bar.getByRole('button', { name: 'Undo add text' })).toBeEnabled()
  await expect(page.getByRole('button', { pressed: true, name: /^Text, / })).toBeVisible()
})

test('the activity indicator shows the first task’s progress, counts the others and goes away when they finish', async ({
  page,
}) => {
  await openEditor(page)
  type Hooks = { finish: Record<string, () => void>; report: (f: number) => void }
  const start = (kind: string, title: string, fraction?: number) =>
    page.evaluate(
      ([k, t, f]) => {
        const w = window as unknown as Hooks
        w.finish ??= {}
        window.mvStudio.shared.jobs.run({
          kind: k,
          title: t,
          run: (ctx: { progress: (p: { fraction?: number }) => void }) =>
            new Promise<void>((resolve) => {
              if (f !== null) {
                ctx.progress({ fraction: f })
                w.report = (next) => ctx.progress({ fraction: next })
              }
              w.finish[k] = resolve
            }),
        })
      },
      [kind, title, fraction ?? null] as const,
    )
  const finish = (kind: string) => page.evaluate((k) => (window as unknown as Hooks).finish[k]!(), kind)
  const bar = page.getByRole('banner')
  const measuring = bar.getByRole('button', { name: /Measuring the song/ })
  const thinking = bar.getByRole('button', { name: /Thinking it over/ })

  await start('test.measured', 'Measuring the song', 0.25)
  await expect(measuring).toContainText('25%')
  await page.evaluate(() => (window as unknown as Hooks).report(0.6))
  await expect(measuring).toContainText('60%')

  // A second task adds a count; the indicator keeps showing the first.
  await start('test.unmeasured', 'Thinking it over')
  await expect(measuring).toContainText('+1')
  await expect(thinking).toHaveCount(0)

  // A task that can't measure its progress shows no percentage.
  await finish('test.measured')
  await expect(thinking).toBeVisible()
  await expect(thinking).not.toContainText('%')
  await expect(thinking).not.toContainText('+')

  await finish('test.unmeasured')
  await expect(thinking).toHaveCount(0)
  await expect(measuring).toHaveCount(0)
})

test('Help › Replay the guide and Settings › General › Replay show the guide again from its first step', async ({
  page,
}) => {
  await openEditor(page)
  const bar = page.getByRole('banner')
  const guide = page.getByRole('dialog', { name: 'Getting started guide' })
  await expect(guide).toBeHidden()

  await bar.getByRole('button', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: 'Replay the guide' }).click()
  await expect(guide).toContainText('1 of 4')
  await expect(guide).toContainText('Your song, mapped')
  await guide.getByRole('button', { name: 'Next' }).click()
  await expect(guide).toContainText('2 of 4')
  await page.keyboard.press('Escape')
  await expect(guide).toBeHidden()
  await expect(bar.getByRole('button', { name: 'Help' })).toBeFocused()

  await bar.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'General' }).click()
  await settings.getByRole('button', { name: 'Replay' }).click()
  await expect(settings).toBeHidden()
  await expect(guide).toContainText('1 of 4')
  // Replayed from inside Settings, which closed: focus goes back to what opened Settings.
  await guide.getByRole('button', { name: 'Skip' }).click()
  await expect(guide).toBeHidden()
  await expect(bar.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
})

test('the guide takes focus on Next, and closing a guide that opened by itself puts focus on the search field', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    // As after the setup screen: the guide opens with the editor, before anything has focus.
    window.location.hash = '#/editor?t=67&guide=0'
  })
  const guide = page.getByRole('dialog', { name: 'Getting started guide' })
  await expect(guide).toContainText('1 of 4')
  await expect(guide.getByRole('button', { name: 'Next' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(guide).toBeHidden()
  // Opened by itself on the first visit: focus lands on the search field the guide ends on.
  await expect(page.getByRole('banner').getByRole('button', { name: /^Search actions/ })).toBeFocused()
})

test('the gear opens Settings where it was left, Help › Keyboard shortcuts opens Shortcuts, and closing gives focus back', async ({
  page,
}) => {
  await openEditor(page)
  const bar = page.getByRole('banner')
  const gear = bar.getByRole('button', { name: 'Settings', exact: true })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const current = settings.locator('nav [aria-current="page"]')

  await gear.click()
  await expect(settings.getByRole('heading', { name: 'AI and cloud' })).toBeVisible()
  await expect(current).toHaveText('AI and cloud')
  await settings.getByRole('button', { name: 'Storage' }).click()
  await expect(settings.getByRole('heading', { name: 'Storage' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(gear).toBeFocused()

  await gear.click()
  await expect(current).toHaveText('Storage')
  await settings.getByRole('button', { name: 'Close' }).click()
  await expect(settings).toBeHidden()
  await expect(gear).toBeFocused()

  await bar.getByRole('button', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click()
  await expect(settings.getByRole('heading', { name: 'Shortcuts' })).toBeVisible()
  await expect(current).toHaveText('Shortcuts')
  await expect(settings.getByRole('textbox', { name: 'Search shortcuts' })).toBeVisible()
})
