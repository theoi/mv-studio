import type { Locator, Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openExport(page: Page, path = './') {
  await openApp(page, path)
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
  const m = /Up to about ([\d.]+) (MB|GB)/.exec(text ?? '')
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
  const size = dialog.getByText(/Up to about [\d.]+ (MB|GB)$/)
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

test('the export dialog shows the editor’s frame at once, without waiting for a preview of its own', async ({
  page,
}) => {
  await openApp(page, './?e2e=1')
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
  // Previews started from now on cannot draw, so the dialog's own stills never arrive.
  await page.evaluate(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      options?: unknown,
    ) {
      return type === 'webgl2' ? null : getContext.call(this, type, options)
    } as typeof getContext
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { value: undefined })
  })
  await page.keyboard.press(`${mod}+e`)
  const preview = page
    .getByRole('dialog', { name: 'Export' })
    .getByRole('img', { name: 'Preview of Full video' })
  await expect.poll(() => backgrounds(preview)).toContain('blob:')

  // It is the frame the editor's preview shows at the playhead.
  const difference = await preview.evaluate(async (el) => {
    const url = /url\("?(blob:[^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage)?.[1] ?? ''
    const shown = await createImageBitmap(await (await fetch(url)).blob())
    const stage = await window.mvStudio.app.stagePreview().captureFrame()
    const pixels = (image: ImageBitmap) => {
      const ctx = new OffscreenCanvas(32, 18).getContext('2d')!
      ctx.drawImage(image, 0, 0, 32, 18)
      return ctx.getImageData(0, 0, 32, 18).data
    }
    const a = pixels(shown)
    const b = pixels(stage)
    let sum = 0
    for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c]! - b[i + c]!)
    return sum / ((a.length / 4) * 3)
  })
  expect(difference).toBeLessThan(6)
})

test('with a stage smaller than the dialog’s frame, the editor’s frame shows first and a sharper one replaces it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 640 })
  await openApp(page, './?e2e=1')
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
  const stageHeight = await page.evaluate(async () => {
    const preview = window.mvStudio.app.stagePreview()
    await preview.rendered()
    return preview.stats().height
  })
  expect(stageHeight).toBeLessThan(360)

  await page.keyboard.press(`${mod}+e`)
  const preview = page
    .getByRole('dialog', { name: 'Export' })
    .getByRole('img', { name: 'Preview of Full video' })
  await expect.poll(() => backgrounds(preview)).toContain('blob:')
  const first = await backgrounds(preview)
  await expect
    .poll(
      async () => (await backgrounds(preview)) !== first && (await backgrounds(preview)).includes('blob:'),
    )
    .toBe(true)
})

test('the outputs of an export are saved with the project for next time', async ({ page }) => {
  const dialog = await openExport(page)
  // A project that has not exported yet offers the vertical version but leaves it off.
  await expect(dialog.getByLabel('Include Full video')).toBeChecked()
  await expect(dialog.getByLabel('Include Vertical')).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Export 1 file' })).toBeVisible()
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

test('changing an output’s settings includes it, and with nothing included the footer asks for an output', async ({
  page,
}) => {
  const dialog = await openExport(page)
  await dialog.getByRole('button', { name: /Vertical.*9:16/ }).click()
  await expect(dialog.getByLabel('Include Vertical')).not.toBeChecked()
  await dialog.getByRole('radio', { name: '720p' }).click()
  await expect(dialog.getByLabel('Include Vertical')).toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Export 2 files' })).toBeVisible()

  await dialog.getByLabel('Include Vertical').uncheck()
  await dialog.getByLabel('Include Full video').uncheck()
  await expect(dialog.getByText('Choose at least one output')).toBeVisible()
  await expect(dialog.getByText(/Up to about [\d.]+ (MB|GB)$/)).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
})

test('dragging the frame adjusts the framing of the shot shown, one shot at a time', async ({ page }) => {
  const dialog = await openExport(page)
  await dialog.getByRole('button', { name: /Vertical.*9:16/ }).click()
  await expect(dialog.getByLabel('Include Vertical')).not.toBeChecked()
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
  // Adjusting an output's framing includes it in the export.
  await expect(dialog.getByLabel('Include Vertical')).toBeChecked()
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

test('an export that ends after Keep editing says so until dismissed, with Download, and Export lists its file until the next export', async ({
  page,
}) => {
  test.setTimeout(360_000)
  const dialog = await openExport(page, './?e2e=1')
  await dialog.getByLabel('Include Full video').uncheck()
  await dialog.getByLabel('Include Vertical').uncheck()
  await dialog.getByRole('button', { name: /Loop for Canvas/ }).click()
  await dialog.getByRole('radio', { name: '720p' }).click()
  const file = 'Neon Skyline - Canvas.mp4'
  let download = page.waitForEvent('download', { timeout: 200_000 })
  await dialog.getByRole('button', { name: 'Export 1 file' }).click()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(dialog).toBeHidden()

  // The activity chip says how long the export has left, the same figure as the export's own row.
  const chip = page.getByRole('button', { name: /^Exporting video \d+% · / })
  await expect(chip).toContainText(/^Exporting\d+% · (\d+ min left|almost done)$/, { timeout: 60_000 })
  await chip.click()
  await expect(dialog).toBeVisible()
  const timesLeft = () =>
    page.evaluate(() => {
      const left = (text: string | null | undefined) =>
        text?.match(/· ((about \d+ min|less than a minute) left)/)?.[1]
      const chipLabel = document
        .querySelector('button[aria-label^="Exporting video"]')
        ?.getAttribute('aria-label')
      const row = [...document.querySelectorAll('[role="dialog"] span')].find((s) =>
        /^\d+% · /.test(s.textContent ?? ''),
      )
      return { chip: left(chipLabel), row: left(row?.textContent) }
    })
  await expect
    .poll(async () => {
      const { chip, row } = await timesLeft()
      return row !== undefined && chip === row
    })
    .toBe(true)
  await dialog.getByRole('button', { name: 'Keep editing' }).click()

  // The toast stays past the usual 5 s, and its Download saves the file again.
  expect((await download).suggestedFilename()).toBe(file)
  const saved = page.locator('[data-toast]').filter({ hasText: `Saved “${file}” to Downloads` })
  await expect(saved).toBeVisible()
  await page.waitForTimeout(6_000)
  await expect(saved).toBeVisible()
  download = page.waitForEvent('download')
  await saved.getByRole('button', { name: 'Download' }).click()
  expect((await download).suggestedFilename()).toBe(file)
  await expect(saved).toBeHidden()

  // Export opens on the outputs, with the file of the last export to download again.
  await page.keyboard.press(`${mod}+e`)
  const last = dialog.getByRole('region', { name: 'Last export' })
  await expect(last.getByText('Loop for Canvas')).toBeVisible()
  download = page.waitForEvent('download')
  await last.getByRole('button', { name: `Download ${file}` }).click()
  expect((await download).suggestedFilename()).toBe(file)

  // The next export replaces it. Ending while the dialog is open, it says so plainly; while the pointer is on the
  // outputs, the list waits for it to leave instead of moving under it.
  download = page.waitForEvent('download', { timeout: 200_000 })
  await dialog.getByRole('button', { name: 'Export 1 file' }).click()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await page.keyboard.press(`${mod}+e`)
  const outputs = dialog.getByText('Outputs', { exact: true })
  await expect(outputs).toBeVisible()
  await expect(last).toHaveCount(0)
  await outputs.hover()
  expect((await download).suggestedFilename()).toBe(file)
  await expect(saved).toBeVisible()
  await expect(saved.getByRole('button', { name: /^(Show|Download)$/ })).toHaveCount(0)
  await expect(last).toHaveCount(0)
  await dialog.getByText('Name', { exact: true }).hover()
  await expect(last.getByText('Loop for Canvas')).toBeVisible()
})

test('Show on the note of an export that ended opens it from VJ mode, and from the start screen once newer jobs pushed it out of the job list', async ({
  page,
}) => {
  test.setTimeout(360_000)
  const dialog = await openExport(page, './?e2e=1')
  await dialog.getByLabel('Include Full video').uncheck()
  await dialog.getByLabel('Include Vertical').uncheck()
  await dialog.getByRole('button', { name: /Loop for Canvas/ }).click()
  await dialog.getByRole('radio', { name: '720p' }).click()
  const file = 'Neon Skyline - Canvas.mp4'
  const saved = page.locator('[data-toast]').filter({ hasText: `Saved “${file}” to Downloads` })
  // The open dialog hides the rest of the page from the accessibility tree.
  const backToEditor = page.getByRole('button', { name: 'Back to editor', includeHidden: true })

  // From VJ mode, Show goes back to the editor and opens the export there.
  let download = page.waitForEvent('download', { timeout: 200_000 })
  await dialog.getByRole('button', { name: 'Export 1 file' }).click()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await page.getByRole('button', { name: 'VJ', exact: true }).click()
  await expect(backToEditor).toBeVisible()
  expect((await download).suggestedFilename()).toBe(file)
  await saved.getByRole('button', { name: 'Show' }).click()
  await expect(dialog.getByText('1 file saved', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Find it in your Downloads folder.')).toBeVisible()
  await expect(backToEditor).toHaveCount(0)
  await expect(saved).toBeHidden()
  await dialog.getByRole('button', { name: 'Done' }).click()

  // From the start screen, Show opens the project's editor on the export.
  await page.keyboard.press(`${mod}+e`)
  download = page.waitForEvent('download', { timeout: 200_000 })
  await dialog.getByRole('button', { name: 'Export 1 file' }).click()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await page.getByRole('button', { name: 'Home' }).click()
  await expect(page.getByRole('button', { name: 'Home' })).toHaveCount(0)
  expect((await download).suggestedFilename()).toBe(file)
  const pushedOut = await page.evaluate(async () => {
    const { jobs } = window.mvStudio.shared
    const list = (): { id: string; title: string }[] => jobs.list()
    const id = list().find((j) => j.title.startsWith('Exporting'))?.id
    for (let i = 0; i < 21; i++)
      await jobs.run({ kind: 'test', title: 'Test', run: async () => undefined }).promise
    return id !== undefined && !list().some((j) => j.id === id)
  })
  expect(pushedOut).toBe(true)
  await saved.getByRole('button', { name: 'Show' }).click()
  await expect(dialog.getByText('1 file saved', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Download' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Home', includeHidden: true })).toBeVisible()
  await expect(saved).toBeHidden()
})
test('the time an export takes is worked out on this device, and the export stays within 1.5 times it, while Export stays available', async ({
  page,
}) => {
  test.setTimeout(300_000)
  // Paces of exports in earlier tests would show at once; this test is about the trial.
  await page.addInitScript(() => localStorage.removeItem('mv-studio.export-pace'))
  const dialog = await openExport(page, './?e2e=1')
  await dialog.getByLabel('Include Full video').uncheck()
  await dialog.getByLabel('Include Vertical').uncheck()
  await dialog.getByRole('button', { name: /Loop for Canvas/ }).click()
  await dialog.getByRole('radio', { name: '720p' }).click()
  const time = dialog.getByText(/^\s*(Working out the time…|.* on this device)$/)
  await expect(time).toHaveText('Working out the time…')
  await expect(dialog.getByRole('button', { name: 'Export 1 file' })).toBeEnabled()
  const free = dialog.getByText('Free · rendered in your browser')
  const freeAt = async () => (await free.boundingBox())?.x
  const workingOutAt = await freeAt()

  // The sample project's look, lyrics and visualizers make its frames far slower than a fixed rate would guess.
  await expect(time).toHaveText(/on this device$/, { timeout: 120_000 })
  // The time keeps its width, so the footer doesn't move when it arrives.
  expect(await freeAt()).toBe(workingOutAt)
  const label = (await time.textContent())?.trim() ?? ''
  const estimate = await page.evaluate(() => {
    const trials = window.mvStudio.app.exportEstimate.trialEstimates() as Record<string, number | null>
    return Object.entries(trials).find(([key]) => key.includes('|loop|'))?.[1] ?? null
  })
  expect(estimate).toBeGreaterThan(0)
  const download = page.waitForEvent('download', { timeout: 240_000 })
  const started = Date.now()
  await dialog.getByRole('button', { name: 'Export 1 file' }).click()
  await download
  const took = (Date.now() - started) / 1000
  console.log('estimate', label, estimate, 'took', took)
  // The estimate may come out a little under the export, never far: a CI machine's timing only bounds that side.
  expect(took).toBeLessThanOrEqual(1.5 * (estimate ?? 0))
})

/**
 * Opens the sample with background analysis on, as in a real user's browser, and model-free footage analysis that
 * keeps all cores but one busy for `busyMs` per batch of frames, as the footage tagger does without a GPU.
 */
async function openWithBusyAnalysis(page: Page, busyMs: number) {
  await page.addInitScript(() => localStorage.removeItem('mv-studio.export-pace'))
  await openApp(page, './?e2e=1')
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate((ms) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.background-analysis', 'on')
    const source = `onmessage = (e) => { const end = performance.now() + e.data; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); postMessage(x) }`
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const workers = Array.from(
      { length: Math.max(2, navigator.hardwareConcurrency - 1) },
      () => new Worker(url),
    )
    const busy = () =>
      Promise.all(
        workers.map(
          (w) =>
            new Promise((resolve) => {
              w.onmessage = resolve
              w.postMessage(ms)
            }),
        ),
      )
    const vector = [0.5, 0.5, 0.5, 0.5]
    window.mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => ({
        async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
          await busy()
          for (const b of bitmaps) b.close()
          return { dim: 4, data: new Float32Array(bitmaps.flatMap(() => vector)) }
        },
        async embedTexts({ texts }: { texts: string[] }) {
          return { dim: 4, data: new Float32Array(texts.flatMap(() => vector)) }
        },
      }),
      segmentation: () => {
        throw new Error('unused')
      },
    })
    window.location.hash = '#/editor'
  }, busyMs)
  await waitForPreview(page)
}

/** Opens Export with only the Full video, at 720p. */
async function openExport720(page: Page) {
  await page.keyboard.press(`${mod}+e`)
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await dialog.getByRole('radio', { name: '720p' }).click()
  await dialog.getByLabel('Include Vertical').uncheck()
  return dialog
}

/** The current project's 720p trial estimate in seconds, or null before it has one. */
function trial720(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const { exportEstimate, project } = window.mvStudio.app
    const drawn = exportEstimate.drawnKey(project.editor.getProject())
    const trials = exportEstimate.trialEstimates() as Record<string, number | null>
    return (
      Object.entries(trials).find(([k]) => k.startsWith(`${drawn}|`) && k.includes('|1280|720|'))?.[1] ?? null
    )
  })
}

const unsettled = (page: Page) =>
  page.evaluate(() => window.mvStudio.app.exportEstimate.unsettledTrials() as string[])

const footageStatus = (page: Page) =>
  page.evaluate(() => window.mvStudio.app.footage.useFootage.getState().indexing?.status ?? 'none')

/** A trial of the 720p output with nothing else running: renaming the project makes the dialog time it again. */
async function quietTrial(page: Page): Promise<number> {
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    editor.dispatch({ type: 'project.rename', name: `${editor.getProject().name} (quiet)` })
  })
  await expect.poll(() => trial720(page), { timeout: 60_000 }).not.toBeNull()
  return (await trial720(page)) ?? 0
}

test('with background analysis on, Export times its outputs before it starts footage analysis, so the time is not inflated by it', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await openWithBusyAnalysis(page, 600)
  const dialog = await openExport720(page)
  const time = dialog.getByText(
    /^\s*(Working out the time…|Timing once other tasks finish…|.* on this device)$/,
  )
  await expect(time).toHaveText(/^About .* on this device$/, { timeout: 60_000 })
  const first = (await trial720(page)) ?? 0
  // The dialog still starts footage analysis for framing, after the trial, and it runs to the end.
  await expect.poll(() => footageStatus(page), { timeout: 30_000 }).toBe('indexing')
  await expect.poll(() => footageStatus(page), { timeout: 150_000 }).not.toBe('indexing')
  const quiet = await quietTrial(page)
  console.log('trial', first, 'quiet', quiet)
  expect(first).toBeGreaterThan(0)
  expect(first).toBeLessThanOrEqual(1.25 * quiet)
  expect(await unsettled(page)).toEqual([])
})

test('a time worked out while footage analysis runs is shown, not kept: it is worked out again when the analysis ends, also after Export opens again', async ({
  page,
}) => {
  test.setTimeout(300_000)
  await openWithBusyAnalysis(page, 2000)
  await page.evaluate(() => window.mvStudio.app.footage.startFootageAnalysis())
  await expect.poll(() => footageStatus(page), { timeout: 30_000 }).toBe('indexing')
  let dialog = await openExport720(page)
  const timeOf = (d: Locator) =>
    d.getByText(/^\s*(Working out the time…|Timing once other tasks finish…|.* on this device)$/)
  // It says why there is no time yet, then times the output anyway rather than wait for the whole analysis.
  await expect(timeOf(dialog)).toHaveText('Timing once other tasks finish…', { timeout: 15_000 })
  // A time from under load is likely too long, and says so.
  await expect(timeOf(dialog)).toHaveText(/^Up to .* on this device$/, { timeout: 90_000 })
  expect(await footageStatus(page)).toBe('indexing')
  expect(await unsettled(page)).toHaveLength(1)
  const underLoad = (await trial720(page)) ?? 0

  // Closed and opened again while the analysis runs: the time from under load shows, but is still to be redone.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  dialog = await openExport720(page)
  await expect(timeOf(dialog)).toHaveText(/^Up to .* on this device$/)
  expect(await unsettled(page)).toHaveLength(1)

  // Once the analysis ends, the output is timed again and that time replaces the one from under load.
  await expect.poll(() => unsettled(page), { timeout: 200_000 }).toEqual([])
  expect(await footageStatus(page)).not.toBe('indexing')
  const settled = (await trial720(page)) ?? 0
  console.log('under load', underLoad, 'settled', settled)
  expect(settled).toBeGreaterThan(0)
  expect(settled).toBeLessThan(underLoad)
  await expect(timeOf(dialog)).toHaveText(/^About .* on this device$/)
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
