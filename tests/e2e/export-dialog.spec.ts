import type { Locator, Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openExport(page: Page) {
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
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
  await expect(dialog.getByText(/clips without subject analysis are centered/)).toBeVisible()
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
  await dialog.getByLabel('Include Vertical').uncheck()
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

test('dragging the frame adjusts the framing of the shot shown, one shot at a time', async ({ page }) => {
  const dialog = await openExport(page)
  await dialog.getByRole('button', { name: /Vertical.*9:16/ }).click()
  const preview = dialog.getByRole('img', { name: 'Preview of Vertical' })
  const frame = dialog.getByLabel(/^Framing of shot/)
  const shotLabel = dialog.getByText(/^Shot \d+ of \d+$/)
  await expect.poll(() => backgrounds(preview)).toContain('blob:')
  const shot = await shotLabel.textContent()
  const before = (await frame.boundingBox())!

  // Drag the frame left: the framing override moves the crop, and the output is drawn again from the project.
  const stillBefore = await backgrounds(frame)
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 - 60, before.y + before.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect(dialog.getByText('Adjusted by hand. Double-click the frame to reset this shot.')).toBeVisible()
  await expect.poll(async () => (await frame.boundingBox())!.x).toBeLessThan(before.x - 50)
  await expect
    .poll(
      async () => (await backgrounds(frame)) !== stillBefore && (await backgrounds(frame)).includes('blob:'),
    )
    .toBe(true)

  // Arrow keys nudge it back to the right.
  const dragged = (await frame.boundingBox())!.x
  await frame.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(async () => (await frame.boundingBox())!.x).toBeGreaterThan(dragged + 5)

  // The next shot has its own framing, still automatic.
  await dialog.getByRole('button', { name: 'Next shot' }).click()
  await expect(shotLabel).not.toHaveText(shot ?? '')
  await expect(dialog.getByText(/clips without subject analysis are centered/)).toBeVisible()

  // Back on the adjusted shot, a double-click resets it.
  await dialog.getByRole('button', { name: 'Previous shot' }).click()
  await expect(shotLabel).toHaveText(shot ?? '')
  await expect(dialog.getByText(/^Adjusted by hand/)).toBeVisible()
  await frame.dblclick()
  await expect(dialog.getByText(/clips without subject analysis are centered/)).toBeVisible()
  await expect.poll(async () => Math.abs((await frame.boundingBox())!.x - before.x)).toBeLessThan(2)
})

test('cancelling an export keeps the files that are already done', async ({ page }) => {
  test.setTimeout(180_000)
  const dialog = await openExport(page)
  await dialog.getByLabel('Include Full video').uncheck()
  await dialog.getByLabel('Include Vertical').uncheck()
  await dialog.getByRole('button', { name: /Loop for Canvas/ }).click()
  await dialog.getByRole('radio', { name: '720p' }).click()
  await dialog.getByRole('button', { name: /Square.*reframed/ }).click()
  const download = page.waitForEvent('download', { timeout: 150_000 })
  await dialog.getByRole('button', { name: 'Export 2 files' }).click()

  // The loop renders first and downloads as soon as it is done, while the square is still rendering.
  expect((await download).suggestedFilename()).toBe('Neon Skyline - Canvas.mp4')
  await dialog.getByRole('button', { name: 'Cancel all' }).click()
  await expect(dialog.getByText('Export cancelled')).toBeVisible()
  await expect(dialog.getByText('1 file saved to your Downloads folder.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Download' })).toHaveCount(1)
  const again = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download' }).click()
  expect((await again).suggestedFilename()).toBe('Neon Skyline - Canvas.mp4')
})
