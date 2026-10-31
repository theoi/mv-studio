import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

test('the activity indicator opens the panel that shows the running job, never the Export dialog', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=text'
  })
  await waitForPreview(page)
  const start = (kind: string, title: string) =>
    page.evaluate(
      ([k, t]) => {
        const w = window as unknown as { finishJob?: () => void }
        window.mvStudio.shared.jobs.run({
          kind: k,
          title: t,
          run: () =>
            new Promise<void>((resolve) => {
              w.finishJob = resolve
            }),
        })
      },
      [kind, title] as const,
    )
  const finish = () => page.evaluate(() => (window as unknown as { finishJob: () => void }).finishJob())
  const activity = page.getByRole('banner').getByRole('button', { name: /Analyzing your footage/ })

  await start('vision.index', 'Analyzing your footage')
  await activity.click()
  await expect(page.getByRole('tab', { name: 'Media', selected: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: /Export/ })).toHaveCount(0)
  await finish()

  await start('analysis.lyrics', 'Timing lyrics')
  await page
    .getByRole('banner')
    .getByRole('button', { name: /Timing lyrics/ })
    .click()
  await expect(
    page.getByRole('tabpanel', { name: 'Assist' }).getByText('Lyrics', { exact: true }).first(),
  ).toBeVisible()
  await finish()

  // A kind without a panel of its own opens Assist's home.
  await start('something.new', 'Doing something new')
  await page
    .getByRole('banner')
    .getByRole('button', { name: /Doing something new/ })
    .click()
  await expect(page.getByRole('tabpanel', { name: 'Assist' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: /Export/ })).toHaveCount(0)
  await finish()
})

test('a job that took a Cancel says Stopping… in the top bar, in Assist’s Running list and on its tool’s progress card until it ends', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?tab=assist'
  })
  await waitForPreview(page)
  await page.evaluate(() => {
    const w = window as unknown as { finishJob?: () => void }
    window.mvStudio.shared.jobs.run({
      kind: 'analysis.lyrics',
      title: 'Timing lyrics',
      // Like a job keeping a result it already paid for: it doesn't end the moment Cancel is pressed.
      run: (ctx: { progress: (p: { fraction: number }) => void }) =>
        new Promise<void>((resolve) => {
          ctx.progress({ fraction: 0.4 })
          w.finishJob = resolve
        }),
    })
  })
  const chip = page.getByRole('banner').getByRole('button', { name: /Timing lyrics/ })
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const running = panel.getByText('Running', { exact: true }).locator('..')
  await expect(chip).toContainText('Timing lyrics')
  await expect(chip).toContainText('40%')
  await expect(running).toContainText('Timing lyrics')
  await expect(running).toContainText('40%')

  await page.evaluate(() => window.mvStudio.shared.jobs.cancelAll('analysis.lyrics'))
  await expect(chip).toContainText('Stopping…')
  await expect(chip).not.toContainText('%')
  await expect(chip).toHaveAccessibleName('Stopping: Timing lyrics')
  await expect(running.getByText('Stopping…', { exact: true })).toBeVisible()
  await expect(running).not.toContainText('%')
  // The row still says which job is stopping.
  await expect(running).toContainText('Timing lyrics')

  // The Lyrics tool's card has a spinner where the percentage was.
  await chip.click()
  const card = panel
    .getByRole('progressbar', { name: 'Lyrics progress' })
    .locator('xpath=preceding-sibling::div[1]')
  await expect(card).toHaveText('Stopping…')

  await page.evaluate(() => (window as unknown as { finishJob: () => void }).finishJob())
  await expect(chip).toHaveCount(0)
  await expect(card).toHaveCount(0)
})
