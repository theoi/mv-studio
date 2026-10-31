import type { Locator, Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openExport(page: Page) {
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await expect(page.getByText('Preparing the preview')).toBeHidden({ timeout: 30_000 })
  await page.keyboard.press(`${mod}+e`)
  return page.getByRole('dialog', { name: 'Export' })
}

/** The CSS background images of an element and its descendants. */
function backgrounds(locator: Locator): Promise<string> {
  return locator.evaluate((el) =>
    [el, ...el.querySelectorAll('*')].map((e) => getComputedStyle(e).backgroundImage).join(' '),
  )
}

function megabytes(text: string | null): number {
  const m = /About ([\d.]+) (MB|GB)/.exec(text ?? '')
  return m ? Number(m[1]) * (m[2] === 'GB' ? 1000 : 1) : Number.NaN
}

function seconds(t: string): number {
  const [m, s] = t.split(':')
  return Number(m) * 60 + Number(s)
}

test('the export dialog plans every output from the project', async ({ page }) => {
  const dialog = await openExport(page)

  // The selected output is previewed with a frame the engine draws from the project.
  await expect
    .poll(() => backgrounds(dialog.getByRole('img', { name: 'Preview of Full video' })))
    .toContain('blob:')

  // The size estimate follows the output's resolution.
  const size = dialog.getByText(/About [\d.]+ (MB|GB)$/)
  const at1080 = megabytes(await size.textContent())
  await dialog.getByRole('radio', { name: '4K' }).click()
  await expect.poll(async () => megabytes(await size.textContent())).toBeGreaterThan(at1080 * 2)

  // The vertical version is reframed; the sample's clips have no subject analysis, so their center is used.
  await dialog.getByRole('button', { name: /Vertical.*9:16/ }).click()
  await expect(dialog.getByText(/clips without subject analysis are cropped in the center/)).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Framing' }).click()
  await page.getByRole('option', { name: 'Fit with bars' }).click()
  await expect(dialog.getByText(/^Shows the whole picture with bars/)).toBeVisible()

  // A chorus teaser starts on the chorus and runs 15 to 30 seconds; its row reports the planned length.
  await dialog.getByRole('button', { name: /Chorus teaser/ }).click()
  const range = await dialog.getByText(/ · starts on the strongest chorus$/).textContent()
  const [, from, to] = /^(\d+:\d\d) – (\d+:\d\d)/.exec(range ?? '') ?? []
  const length = seconds(to ?? '') - seconds(from ?? '')
  expect(length).toBeGreaterThanOrEqual(15)
  expect(length).toBeLessThanOrEqual(30)
  await expect(dialog.getByText(new RegExp(`9:16 · 1080p · 30 fps · ${length} s$`))).toBeVisible()
})

test('the outputs of an export are saved with the project for next time', async ({ page }) => {
  const dialog = await openExport(page)
  await dialog.getByLabel('Include Vertical').uncheck({ force: true })
  await dialog.getByRole('button', { name: /Square/ }).click()
  await dialog.getByLabel('Name').fill('Square for feed')
  await dialog.getByRole('button', { name: 'Export 2 files' }).click()
  await expect(dialog.getByText('Exporting 2 files')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel all' }).click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.keyboard.press(`${mod}+e`)
  await expect(dialog.getByLabel('Include Full video')).toBeChecked()
  await expect(dialog.getByLabel('Include Square')).toBeChecked()
  await expect(dialog.getByLabel('Include Vertical')).toHaveCount(0)
  await dialog.getByRole('button', { name: /Square.*1:1/ }).click()
  await expect(dialog.getByLabel('Name')).toHaveValue('Square for feed')
})
