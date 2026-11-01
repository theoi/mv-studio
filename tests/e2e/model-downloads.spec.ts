import path from 'node:path'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const DEPTH_LINE = 'Downloading the depth estimator (27 MB, once)'

test('a first 3D camera move shows the depth estimator downloading, and names it when it cannot download', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?tab=assist&assist=camera&t=28'
  })
  await waitForPreview(page)
  const assist = page.getByRole('tabpanel', { name: 'Assist' })

  await context.route('https://huggingface.co/**', (route) => route.abort())
  await assist.getByRole('button', { name: /^Apply to \d+ images$/ }).click()
  const failure = assist.getByRole('alert')
  await expect(failure).toContainText('Could not download the depth estimator')
  await expect(failure).not.toContainText('https://')
  await context.unroute('https://huggingface.co/**')

  // Every line the run shows, however briefly, in order.
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { runLines: string[] }).runLines = seen
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[role="tabpanel"] span')) {
        const line = el.textContent ?? ''
        if (/^(Downloading |Estimating depth · )/.test(line) && seen.at(-1) !== line) seen.push(line)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await assist.getByRole('button', { name: 'Try again' }).click()
  await expect(assist.getByText(/^Added a 3D camera move to \d+ images$/)).toBeVisible({ timeout: 200_000 })
  const lines = await page.evaluate(() => (window as unknown as { runLines: string[] }).runLines)
  expect(lines).toContain(DEPTH_LINE)
  // The run's own line comes back once the download is in.
  expect(lines.findLastIndex((l) => l.startsWith('Estimating depth · '))).toBeGreaterThan(
    lines.indexOf(DEPTH_LINE),
  )
})

test('putting text behind the subject names the person finder when its models cannot download', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=10'
  })
  await waitForPreview(page)
  await context.route('https://storage.googleapis.com/mediapipe-models/**', (route) => route.abort())

  await page
    .getByLabel('Import media files')
    .setInputFiles(path.resolve('tests/fixtures/people-interview.webm'))
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('people-interview, video')
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const block = page.getByRole('button', { name: /^people-interview, \d/ })
  await expect(block).toHaveCount(1)
  await block.focus()
  await page.keyboard.press('Enter')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  await inspector.getByRole('switch', { name: 'Put text and effects behind the subject' }).click()
  await expect(inspector.getByText('Could not download the person finder').first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(inspector.getByText(/https?:\/\//)).toHaveCount(0)
})
