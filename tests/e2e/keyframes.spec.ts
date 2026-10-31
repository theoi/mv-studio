import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** Rotation keyframes of the sample's title, as [time, easing]. */
function rotationKeys(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips['o-title']
    if (!clip || clip.type === 'audio') return null
    return (clip.transform.rotation.keyframes ?? []).map((k) => [Math.round(k.time * 100) / 100, k.easing])
  })
}

const at = (page: Page, t: number) =>
  page.evaluate((t) => {
    window.location.hash = `#/editor?sel=clip:o-title&t=${t}`
  }, t)

test('keyframes: the diamond adds and removes, and the timeline marks set easing and remove', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  // The title starts at 1 s, so keyframes at 3 s and 6 s are at 2 s and 5 s of the clip.
  const marks = page.getByRole('button', { name: /^Keyframe at / })
  await expect(marks).toHaveCount(0)

  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  expect(await rotationKeys(page)).toEqual([[2, 'ease-in-out']])
  await expect(marks).toHaveCount(1)
  // On the keyframe, the diamond removes it.
  await page.getByRole('button', { name: 'Remove keyframe: Rotation' }).click()
  expect(await rotationKeys(page)).toEqual([])
  await expect(marks).toHaveCount(0)
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()

  await at(page, 6)
  await expect(page.getByRole('button', { name: 'Add keyframe: Rotation' })).toBeVisible()
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  expect(await rotationKeys(page)).toEqual([
    [2, 'ease-in-out'],
    [5, 'ease-in-out'],
  ])
  await expect(marks).toHaveCount(2)

  await marks.first().click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('keyframe-menu.png') })
  await page.getByRole('menuitemcheckbox', { name: 'Hold' }).click()
  expect(await rotationKeys(page)).toEqual([
    [2, 'hold'],
    [5, 'ease-in-out'],
  ])
  await expect(page.getByRole('menuitemcheckbox', { name: 'Hold' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitem', { name: 'Remove keyframe' }).click()
  expect(await rotationKeys(page)).toEqual([[5, 'ease-in-out']])
  await expect(marks).toHaveCount(1)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect
    .poll(() => rotationKeys(page))
    .toEqual([
      [2, 'hold'],
      [5, 'ease-in-out'],
    ])
})

test('keyframe marks sit on the clip’s bottom edge and are one Tab stop: arrows move, Enter opens, focus stays after Remove', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  for (const t of [3, 6, 8]) {
    await at(page, t)
    await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  }
  const marks = page.getByRole('button', { name: /^Keyframe at / })
  await expect(marks).toHaveCount(3)
  const clip = page.getByRole('button', { name: 'Title, 0:01.0 to 0:09.0', exact: true })
  const clipBox = (await clip.boundingBox())!
  const markBox = (await marks.first().boundingBox())!
  expect(Math.abs(markBox.y + markBox.height / 2 - (clipBox.y + clipBox.height))).toBeLessThan(2)
  await expect(marks.nth(0)).toHaveAttribute('tabindex', '0')
  await expect(marks.nth(1)).toHaveAttribute('tabindex', '-1')

  // Arrows move between the marks, not the playhead (still at 0:08).
  await marks.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(marks.nth(1)).toBeFocused()
  await expect(page.getByText(/^00:08\.00/)).toBeVisible()
  // Enter moves the playhead to the mark and opens its menu.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByText(/^00:06\.00/)).toBeVisible()
  await page.getByRole('menuitem', { name: 'Remove keyframe' }).click()
  await expect(marks).toHaveCount(2)
  await expect(page.getByRole('button', { name: /^Keyframe at 0:08/ })).toBeFocused()

  // The last keyframe has nothing to ease toward.
  await page.keyboard.press('Enter')
  await expect(page.getByText('No next keyframe')).toBeVisible()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Linear' })).toHaveAttribute('data-disabled', '')
  await page.getByRole('menuitem', { name: 'Remove keyframe' }).click()
  await expect(page.getByRole('button', { name: /^Keyframe at 0:03/ })).toBeFocused()

  // Delete removes the focused keyframe, not the clip; with none left, focus goes to the clip.
  await page.keyboard.press('Delete')
  await expect(marks).toHaveCount(0)
  await expect(clip).toBeFocused()
  expect(await rotationKeys(page)).toEqual([])
})

test('a lone keyframe mark is 24 px wide, and a click beside a diamond opens that mark, not a close neighbor', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  const marks = page.getByRole('button', { name: /^Keyframe at / })
  await expect(marks).toHaveCount(1)
  const lone = (await marks.first().boundingBox())!
  expect([lone.width, lone.height]).toEqual([24, 16])

  // Two keyframes 0.8 s apart, close at the default zoom.
  await at(page, 3.8)
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  await expect(marks).toHaveCount(2)
  const clip = (await page
    .getByRole('button', { name: 'Title, 0:01.0 to 0:09.0', exact: true })
    .boundingBox())!
  // The title runs 8 s, from 1 s, so the 3 s keyframe's diamond is 2 s into it.
  const first = clip.x + (2 * clip.width) / 8
  await page.mouse.click(first + 3, clip.y + clip.height)
  await expect(page.getByRole('menu')).toBeVisible()
  // The open menu hides the rest of the page from role queries.
  const expanded = page.locator('button[aria-label^="Keyframe at "]')
  await expect(expanded.nth(0)).toHaveAttribute('aria-expanded', 'true')
  await expect(expanded.nth(1)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText(/^00:03\.00/)).toBeVisible()
})
