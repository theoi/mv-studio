import { readFileSync } from 'node:fs'
import { expect, openHarness, test } from './fixtures.ts'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

test('a production build has no design-preview pill, and review links start no stand-in jobs', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash =
      '#/editor?tab=assist&assist=stems&stems=running&director=running&autocut=done&dialog=export&export=exporting&review=1&t=73.6'
  })
  const exportDialog = page.getByRole('dialog', { name: 'Export' })
  // No export is running, so a link to one in progress opens the export setup.
  await expect(exportDialog.getByRole('button', { name: /^Export \d+ files?$/ })).toBeVisible()
  await expect(exportDialog.getByText('Exporting 2 videos')).toHaveCount(0)
  expect(
    await page.evaluate(() => window.mvStudio.shared.jobs.list().map((j: { kind: string }) => j.kind)),
  ).toEqual([])
  await expect(page.getByRole('button', { name: 'Design preview' })).toHaveCount(0)

  await page.evaluate(() => {
    window.location.hash = '#/editor?dialog=settings&page=about&review=1'
  })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByText(`Version ${version}`, { exact: true })).toBeVisible()
  await expect(page.getByText(/design preview/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Design preview' })).toHaveCount(0)
})
