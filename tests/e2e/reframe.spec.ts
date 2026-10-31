import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

/** Clip layouts (fit, transform and text style) by id, as JSON. */
function layouts(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    type Clip = { id: string; fit?: unknown; transform?: unknown; style?: unknown }
    const project = window.mvStudio.app.project.editor.getProject()
    return Object.fromEntries(
      Object.values(project.clips as Record<string, Clip>).map((c) => [
        c.id,
        JSON.stringify([c.fit ?? null, c.transform ?? null, c.style ?? null]),
      ]),
    )
  })
}

function scaleOf(page: Page, clipId: string): Promise<number> {
  return page.evaluate((id) => {
    const clip = window.mvStudio.app.project.editor.getProject().clips[id]
    return clip && 'transform' in clip ? clip.transform.scaleX.value : Number.NaN
  }, clipId)
}

async function switchFrame(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: from, exact: true }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${to}`) }).click()
  const toasts = page.getByRole('status')
  await expect(toasts.getByText(`Switched to ${to}. Keep subjects in frame?`)).toBeVisible()
  await toasts.getByRole('button', { name: 'Reframe automatically' }).click()
}

test('switching the frame offers to reframe the clips, as one undoable edit', async ({ page }) => {
  await openEditor(page, '#/editor?t=20')
  const before = await layouts(page)
  await switchFrame(page, '16:9', '9:16')
  const toasts = page.getByRole('status')
  // The sample's footage has no subject analysis, so it keeps its center; its lyrics move into the safe area.
  await expect(
    toasts.getByText(
      /^Reframed for 9:16: \d+ titles and overlays moved into the safe area, \d+ clips without subject analysis stay centered\.$/,
    ),
  ).toBeVisible()
  const after = await layouts(page)
  const changed = Object.keys(before).filter((id) => before[id] !== after[id])
  expect(changed.length).toBeGreaterThan(0)

  await toasts.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => layouts(page)).toEqual(before)
})

test('Inspector › Framing sets how a clip fills other frames, in Export and when the frame changes', async ({
  page,
}) => {
  await openEditor(page, '#/editor?sel=clip:c-s-c1-1&t=67.2')
  await page.getByRole('button', { name: 'Framing', exact: true }).click()
  const reframe = page.getByRole('combobox', { name: 'Reframe' })
  await expect(reframe).toHaveText('Follow the subject')
  await expect(
    page.getByText('Other aspect ratios use its center, as it has no subject analysis yet.'),
  ).toBeVisible()
  await reframe.click()
  await page.getByRole('option', { name: 'Fit' }).click()
  await expect(
    page.getByText('How this clip fills other aspect ratios: in Export, and when you switch the frame.'),
  ).toBeVisible()

  // Export uses it for this shot.
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await dialog.getByRole('button', { name: /Vertical.*9:16/ }).click()
  await expect(
    dialog.getByText('This shot shows the whole picture with bars, as set in Inspector › Framing.'),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Reframing the project fits the clip with bars; a new choice on a reframed clip applies at once.
  await switchFrame(page, '16:9', '9:16')
  await expect(page.getByRole('status').getByText(/^Reframed for 9:16: /)).toBeVisible()
  await page.evaluate(() => (window.location.hash = '#/editor?sel=clip:c-s-c1-1&t=67.2'))
  await page.getByRole('button', { name: 'Framing', exact: true }).click()
  await expect(page.getByText('Reframed from 16:9.')).toBeVisible()
  expect(await scaleOf(page, 'c-s-c1-1')).toBeLessThan(0.9)
  await reframe.click()
  await page.getByRole('option', { name: 'Follow the subject' }).click()
  await expect(
    page.getByText('Reframed from 16:9 on its center, as it has no subject analysis yet.'),
  ).toBeVisible()
  await expect.poll(() => scaleOf(page, 'c-s-c1-1')).toBeCloseTo(1, 2)
})
