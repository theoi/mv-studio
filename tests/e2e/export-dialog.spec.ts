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
  // With nothing done yet, the dialog goes back to the outputs and a toast says what happened.
  await expect(page.getByText('Export cancelled. Nothing was saved.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Export 2 files' })).toBeVisible()
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
  await expect(dialog.getByText('Export cancelled', { exact: true })).toBeVisible()
  await expect(
    dialog.getByText('1 of 2 files saved to your Downloads folder. The rest were not saved.'),
  ).toBeVisible()
  await expect(page.getByText('Export cancelled. 1 of 2 files was saved to Downloads.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Download' })).toHaveCount(1)
  const again = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download' }).click()
  expect((await again).suggestedFilename()).toBe('Neon Skyline - Canvas.mp4')
})

/** Start and length, in seconds, of the range written under the song lane ("1:04 – 1:34 · ..."). */
async function laneRange(dialog: Locator): Promise<{ start: number; length: number }> {
  const text = await dialog.getByText(/^\d+:\d\d – \d+:\d\d · /).textContent()
  const [, from, to] = /^(\d+:\d\d) – (\d+:\d\d)/.exec(text ?? '') ?? []
  return { start: seconds(from ?? ''), length: seconds(to ?? '') - seconds(from ?? '') }
}

test('a teaser runs 15 or 30 seconds, and its range moves along the song on bars', async ({ page }) => {
  const dialog = await openExport(page)
  await dialog.getByRole('button', { name: /Chorus teaser/ }).click()
  const length = dialog.getByRole('radiogroup', { name: 'Teaser length' })
  await expect(length.getByRole('radio', { name: 'Whole section' })).toBeChecked()

  await length.getByRole('radio', { name: 'Up to 15 s' }).click()
  await expect.poll(async () => (await laneRange(dialog)).length).toBeLessThanOrEqual(15)
  const short = await laneRange(dialog)
  expect(short.length).toBeGreaterThanOrEqual(10)
  await expect(dialog.getByText(new RegExp(`9:16 · 1080p · 30 fps · ${short.length} s$`))).toBeVisible()
  await length.getByRole('radio', { name: 'Up to 30 s' }).click()
  await expect.poll(async () => (await laneRange(dialog)).length).toBeGreaterThan(short.length + 10)
  const long = await laneRange(dialog)
  expect(long.length).toBeLessThanOrEqual(30)
  expect(long.start).toBe(short.start)

  // The arrow keys move the range a bar at a time, keeping its length.
  // Once placed by hand, the range is no longer the chorus pick and the row reads "Teaser".
  const range = dialog.getByRole('slider', { name: /^(Chorus teaser|Teaser) range$/ })
  await range.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await laneRange(dialog)).start).toBeGreaterThan(long.start)
  const stepped = await laneRange(dialog)
  expect(stepped.start - long.start).toBeLessThanOrEqual(4)
  expect(stepped.length).toBe(long.length)
  await expect(dialog.getByText(/ · the range you picked$/)).toBeVisible()

  // Dragging moves it further, and it stays as long.
  const box = (await range.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await laneRange(dialog)).start).toBeGreaterThan(stepped.start + 10)
  expect((await laneRange(dialog)).length).toBe(long.length)
  await expect(dialog.getByText(new RegExp(`9:16 · 1080p · 30 fps · ${long.length} s$`))).toBeVisible()
  await expect(dialog.getByLabel('Include Teaser')).toBeChecked()

  // Home and End go to either end of the song; a click on the lane centers the range there.
  await range.focus()
  await page.keyboard.press('End')
  await expect.poll(async () => (await laneRange(dialog)).start + long.length).toBeGreaterThan(200)
  await page.keyboard.press('Home')
  await expect.poll(async () => (await laneRange(dialog)).start).toBe(0)
  const lane = (await range.locator('xpath=..').boundingBox())!
  await page.mouse.click(lane.x + lane.width / 2, lane.y + lane.height / 2)
  await expect.poll(async () => (await laneRange(dialog)).start).toBeGreaterThan(70)
  const centered = await laneRange(dialog)
  expect(centered.start + centered.length / 2).toBeLessThan(115)
})

test('a loop is a chosen number of bars, with its last and first frames side by side', async ({ page }) => {
  const dialog = await openExport(page)
  await dialog.getByRole('button', { name: /Loop for Canvas/ }).click()
  await expect
    .poll(() => backgrounds(dialog.getByRole('img', { name: 'Last frame of the loop' })))
    .toContain('blob:')
  await expect
    .poll(() => backgrounds(dialog.getByRole('img', { name: 'First frame of the loop' })))
    .toContain('blob:')

  const lengths = dialog.getByRole('radiogroup', { name: 'Loop length' })
  const other = lengths.getByRole('radio', { checked: false }).first()
  const [, bars, secs] = /^(\d+) bars? · ([\d.]+) s$/.exec((await other.textContent()) ?? '') ?? []
  const start = (await laneRange(dialog)).start
  await other.click()
  await expect(lengths.getByRole('radio', { name: new RegExp(`^${bars} bars? · `) })).toBeChecked()
  await expect(dialog.getByText(new RegExp(` · ${bars} bars?, loops seamlessly on the beat$`))).toBeVisible()
  await expect(
    dialog.getByText(new RegExp(`9:16 · 1080p · 30 fps · ${Math.round(Number(secs))} s loop$`)),
  ).toBeVisible()
  expect((await laneRange(dialog)).start).toBe(start)
})

test('Section › Export as a teaser opens Export with a teaser of that section', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=20'
  })
  await waitForPreview(page)
  // A mouse pointerdown: one without a pointer type counts as touch, whose long press opens the section menu.
  await page
    .getByRole('button', { name: /^Section Verse 1, 0:16 to 0:48$/ })
    .dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  await page.getByRole('button', { name: 'Export as a teaser…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await expect(dialog.getByRole('slider', { name: 'Teaser range' })).toBeVisible()
  await expect(dialog.getByText(/^0:16 – 0:46 · starts on Verse 1$/)).toBeVisible()
  await expect(dialog.getByLabel('Include Teaser')).toBeChecked()

  // A shorter teaser still starts on the section; "Whole section" runs to its end again (30 s at most).
  const length = dialog.getByRole('radiogroup', { name: 'Teaser length' })
  await length.getByRole('radio', { name: 'Up to 15 s' }).click()
  await expect(dialog.getByText(/^0:16 – 0:30 · starts on Verse 1$/)).toBeVisible()
  await length.getByRole('radio', { name: 'Whole section' }).click()
  await expect(dialog.getByText(/^0:16 – 0:46 · starts on Verse 1$/)).toBeVisible()
})
