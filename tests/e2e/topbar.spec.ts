import type { Locator, Page } from '@playwright/test'
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

test('the activity indicator shows the first task’s progress, counts the others, says Stopping… after a Cancel and goes away when they finish', async ({
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
  const measuring = bar.getByRole('button', { name: /^Measuring the song/ })
  const thinking = bar.getByRole('button', { name: /^Thinking it over/ })

  await start('test.measured', 'Measuring the song', 0.25)
  await expect(measuring).toContainText('25%')
  await page.evaluate(() => (window as unknown as Hooks).report(0.6))
  await expect(measuring).toContainText('60%')

  // A second task adds a count; the indicator keeps showing the first.
  await start('test.unmeasured', 'Thinking it over')
  await expect(measuring).toContainText('+1')
  await expect(measuring).toHaveAccessibleName('Measuring the song 60% +1')
  await expect(thinking).toHaveCount(0)

  // A task that can't measure its progress shows no percentage.
  await finish('test.measured')
  await expect(thinking).toBeVisible()
  await expect(thinking).not.toContainText('%')
  await expect(thinking).not.toContainText('+')
  await expect(thinking).toHaveAccessibleName('Thinking it over')

  await finish('test.unmeasured')
  await expect(thinking).toHaveCount(0)
  await expect(measuring).toHaveCount(0)

  // A task that took a Cancel but has not ended (keeping a result it paid for) says so, without a percentage. Its
  // name keeps the title the chip no longer shows.
  const stopping = bar.getByRole('button', { name: 'Stopping: Measuring the song', exact: true })
  await start('test.measured', 'Measuring the song', 0.4)
  await expect(measuring).toContainText('40%')
  await page.evaluate(() => window.mvStudio.shared.jobs.cancelAll('test.measured'))
  await expect(stopping).toBeVisible()
  await expect(stopping).toContainText('Stopping…')
  await expect(stopping).not.toContainText('%')
  await expect(measuring).toHaveCount(0)
  await finish('test.measured')
  await expect(stopping).toHaveCount(0)
})

test('at 1280 wide a task with a long title gets its title cut off, keeping its percentage, its count and the buttons beside it whole', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openEditor(page)
  const title = 'Separating the vocals, drums and bass of the whole song'
  await page.evaluate((t) => {
    const w = window as unknown as { finish: (() => void)[] }
    w.finish = []
    const tasks = [
      ['cloud.generate', t, 0.33],
      ['analysis.lyrics', 'Timing lyrics', 0.5],
    ] as const
    for (const [kind, title, fraction] of tasks)
      window.mvStudio.shared.jobs.run({
        kind,
        title,
        run: (ctx: { progress: (p: { fraction: number }) => void }) =>
          new Promise<void>((resolve) => {
            ctx.progress({ fraction })
            w.finish.push(resolve)
          }),
      })
  }, title)
  const bar = page.getByRole('banner')
  const chip = bar.getByRole('button', { name: `${title} 33% +1`, exact: true })
  await expect(chip).toBeVisible()
  // It slides in from the right.
  await chip.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const box = async (l: Locator) => (await l.boundingBox())!
  const c = await box(chip)
  const search = await box(bar.getByRole('button', { name: /^Search actions/ }))
  const vj = await box(bar.getByRole('button', { name: 'VJ', exact: true }))
  const help = await box(bar.getByRole('button', { name: 'Help' }))
  expect(c.x).toBeGreaterThanOrEqual(search.x + search.width)
  expect(c.x + c.width).toBeLessThanOrEqual(vj.x)
  expect(help.width).toBeCloseTo(28, 0)
  for (const shown of ['33%', '+1']) {
    const b = await box(chip.getByText(shown, { exact: true }))
    expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width)
  }
  const cut = await chip.getByText(title, { exact: true }).evaluate((el) => el.scrollWidth > el.clientWidth)
  expect(cut).toBe(true)
  await chip.hover()
  await expect(page.getByRole('tooltip')).toContainText(title)
  await page.evaluate(() => (window as unknown as { finish: (() => void)[] }).finish.forEach((f) => f()))
  await expect(chip).toHaveCount(0)
})

for (const shown of ['Generating 12 clips', 'Generating 4 images', 'Generating an image'])
  for (const others of [0, 1, 2])
    test(`at 1280 wide the activity indicator shows “${shown}” whole without its price${others ? ` beside +${others}` : ''}, and keeps the price in the name and the tooltip`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 720 })
      await openEditor(page)
      const title = `${shown} · about $3.04`
      await page.evaluate(
        ({ t, others }) => {
          const w = window as unknown as { finish: (() => void)[] }
          w.finish = []
          const tasks: [string, string][] = [['cloud.generate', t]]
          for (let i = 1; i <= others; i++) tasks.push([`test.other${i}`, `Other task ${i}`])
          for (const [kind, title] of tasks)
            window.mvStudio.shared.jobs.run({
              kind,
              title,
              run: (ctx: { progress: (p: { fraction: number }) => void }) =>
                new Promise<void>((resolve) => {
                  ctx.progress({ fraction: 0.33 })
                  w.finish.push(resolve)
                }),
            })
        },
        { t: title, others },
      )
      const name = others ? `${title} 33% +${others}` : `${title} 33%`
      const chip = page.getByRole('banner').getByRole('button', { name, exact: true })
      await expect(chip).toBeVisible()
      await chip.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
      const text = chip.getByText(shown, { exact: true })
      await expect(text).toBeVisible()
      // scrollWidth is a whole number of pixels, so it misses an ellipsis that cuts a fraction of one: compare the
      // text's own width with the box it gets.
      const [needs, gets] = await text.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return [range.getBoundingClientRect().width, el.getBoundingClientRect().width]
      })
      expect(needs).toBeLessThanOrEqual(gets + 0.01)
      await expect(chip).not.toContainText('$3.04')
      await chip.hover()
      await expect(page.getByRole('tooltip')).toContainText(title)
      await page.evaluate(() => (window as unknown as { finish: (() => void)[] }).finish.forEach((f) => f()))
      await expect(chip).toHaveCount(0)
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
