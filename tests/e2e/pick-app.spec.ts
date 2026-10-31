import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const PICK = 'Click the object to put the lyrics behind'
const FIX = 'Click the object again, here where it was lost'

/** Cutout clips with their mattes, mask assets and picked objects. */
function cutouts(page: Page) {
  return page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => c.meta?.behindSubjectOf)
      .map((c) => {
        const mask = project.assets[c.matte?.maskAssetId]
        return {
          track: project.tracks.find((t: Untyped) => t.id === c.trackId)?.name as string,
          matte: { mode: c.matte?.mode, source: c.matte?.sourceAssetId },
          mask: mask && {
            kind: mask.kind,
            parent: mask.origin.parentAssetId,
            provider: mask.origin.provider,
          },
          object: c.meta.object,
        }
      })
  })
}

/** Opens the editor at 0:10 with the interview clip added there, selected, and Inspector › Layering open. */
async function openWithInterview(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=10'
  })
  await waitForPreview(page)
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
  return inspector
}

async function clickAt(page: Page, name: string, x: number, y: number) {
  const layer = page.getByRole('button', { name })
  const box = await layer.boundingBox()
  if (!box) throw new Error(`${name} is not on screen`)
  await layer.click({ position: { x: box.width * x, y: box.height * y } })
}

test('pick mode: Esc cancels without clearing the selection, Play cancels it, and leaving the clip is announced', async ({
  page,
}) => {
  const inspector = await openWithInterview(page)
  const start = inspector.getByRole('button', { name: 'Pick another object in the preview' })
  await start.click()
  const layer = page.getByRole('button', { name: PICK })
  await expect(layer).toBeFocused()
  await expect(page.getByText('to cancel')).toBeVisible()
  // Started with the mouse, so no crosshair until the arrows are used.
  await expect(page.getByText('Arrows to aim')).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(layer).toBeHidden()
  await expect(start).toBeFocused()
  await expect(inspector.getByText('people-interview', { exact: true })).toBeVisible()

  await start.click()
  await expect(layer).toBeVisible()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(layer).toBeHidden()
  expect(await cutouts(page)).toEqual([])

  // Shrunk to half size, the clip leaves the corners empty: screen readers hear when the aim leaves it.
  await page.evaluate(() => {
    const { editor, dispatch } = window.mvStudio.app.project
    const clip = Object.values(editor.getProject().clips as Record<string, Untyped>).find(
      (c) => c.assetId && editor.getProject().assets[c.assetId]?.name.startsWith('people-interview'),
    )
    for (const key of ['scaleX', 'scaleY'])
      dispatch({ type: 'clip.set', clipId: clip.id, path: ['transform', key], value: { value: 0.5 } })
  })
  await start.click()
  const box = await layer.boundingBox()
  if (!box) throw new Error('The pick layer is not on screen')
  const status = page.getByRole('status').filter({ hasText: /^(Over|Outside) / })
  await layer.hover({ position: { x: box.width * 0.05, y: box.height * 0.05 } })
  await expect(status).toHaveText('Outside people-interview')
  await layer.hover({ position: { x: box.width * 0.5, y: box.height * 0.5 } })
  await expect(status).toHaveText('Over people-interview')
  await page.keyboard.press('Escape')
  await expect(layer).toBeHidden()
})

test('clicking an object in the preview cuts out that object with a mask that follows it', async ({
  page,
}) => {
  test.setTimeout(150_000)
  const inspector = await openWithInterview(page)
  await inspector.getByRole('button', { name: 'Pick another object in the preview' }).click()
  await clickAt(page, PICK, 0.6, 0.45)
  await expect(inspector.getByText('Object picked')).toBeVisible({ timeout: 120_000 })
  await expect(inspector.getByText(/^Followed through (the whole clip|\d+% of the clip)\./)).toBeVisible()
  const [cut, ...more] = await cutouts(page)
  expect(more).toEqual([])
  expect(cut).toMatchObject({
    track: 'Subject',
    matte: { mode: 'inside' },
    mask: { kind: 'video', provider: 'vision.object-mask' },
  })
  expect(cut!.mask.parent).toBe(cut!.matte.source)
  expect(cut!.object.click.t).toBeCloseTo(0, 1)
  expect(cut!.object.click.points[0].x).toBeCloseTo(0.6, 1)
  expect(cut!.object.click.points[0].y).toBeCloseTo(0.45, 1)

  await page.keyboard.press(`${mod}+z`)
  await expect(inspector.getByText('Object picked')).toBeHidden()
  expect(await cutouts(page)).toEqual([])
})

test('the keyboard aims and picks, and a spot where the object was lost is fixed with a click there', async ({
  page,
}) => {
  test.setTimeout(200_000)
  const inspector = await openWithInterview(page)
  await inspector.getByRole('button', { name: 'Pick another object in the preview' }).focus()
  await page.keyboard.press('Enter')
  const layer = page.getByRole('button', { name: PICK })
  await expect(layer).toBeFocused()
  // Started from the keyboard: the crosshair shows where Enter picks, and the pill says how to aim.
  await expect(page.getByText('Arrows to aim')).toBeVisible()
  // Screen readers hear which clip Enter would pick in.
  await expect(page.getByRole('status').filter({ hasText: /^Over / })).toHaveText('Over people-interview')

  // Editor shortcuts wait while picking: S does not split and T does not add text.
  const clipCount = () =>
    page.evaluate(() => Object.keys(window.mvStudio.app.project.editor.getProject().clips).length)
  const before = await clipCount()
  await page.keyboard.press('s')
  await page.keyboard.press('t')
  expect(await clipCount()).toBe(before)
  await expect(layer).toBeFocused()

  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Enter')
  await expect(inspector.getByText('Object picked')).toBeVisible({ timeout: 120_000 })
  const [first] = await cutouts(page)
  expect(first!.object.click.points[0].x).toBeCloseTo(0.6, 2)
  expect(first!.object.click.points[0].y).toBeCloseTo(0.5, 2)

  // Say the tracker lost the object 1.5 s into the footage (0:11.5 on the timeline).
  await page.evaluate(() => {
    const { editor, dispatch } = window.mvStudio.app.project
    const cut = Object.values(editor.getProject().clips as Record<string, Untyped>).find(
      (c) => c.meta?.object,
    )
    dispatch({ type: 'clip.set', clipId: cut.id, path: ['meta', 'object', 'fix'], value: [1.5] })
  })
  await expect(inspector.getByText(/Lost in 1 place\. Click the object there to fix it\./)).toBeVisible()
  await inspector.getByRole('button', { name: 'Fix at 0:11.5' }).click()
  await expect(page.getByRole('button', { name: FIX })).toBeFocused()
  await clickAt(page, FIX, 0.6, 0.45)
  await expect
    .poll(async () => (await cutouts(page))[0]?.object?.corrections?.length, { timeout: 120_000 })
    .toBe(1)
  const after = await cutouts(page)
  expect(after).toHaveLength(1)
  expect(after[0]!.object.click).toEqual(first!.object.click)
  expect(after[0]!.object.corrections[0].t).toBeGreaterThan(1.4)
  expect(after[0]!.object.corrections[0].t).toBeLessThan(1.7)
})
