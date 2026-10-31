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
