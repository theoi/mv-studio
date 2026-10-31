import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** Keyframes of one transform property of the sample's title, as [time, value, easing]. */
function keys(page: Page, key: 'rotation' | 'scaleX' | 'scaleY') {
  return page.evaluate((key) => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips['o-title']
    if (!clip || clip.type === 'audio') return null
    return (clip.transform[key].keyframes ?? []).map((k) => [
      Math.round(k.time * 100) / 100,
      k.value,
      k.easing,
    ])
  }, key)
}

const at = (page: Page, t: number) =>
  page.evaluate((t) => {
    window.location.hash = `#/editor?sel=clip:o-title&t=${t}`
  }, t)

async function openTitle(page: Page) {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
}

test('a keyframed value shows its value at the playhead, and an edit sets the keyframe there', async ({
  page,
}) => {
  await openTitle(page)
  const rotation = page.getByRole('textbox', { name: 'Rotation' })
  const start = Number(await rotation.inputValue())
  // The title starts at 1 s, so 3 s and 6 s are 2 s and 5 s into the clip.
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()

  // Away from the keyframe, an edit adds one at the playhead.
  await at(page, 6)
  await rotation.fill(String(start + 90))
  await rotation.press('Enter')
  expect(await keys(page, 'rotation')).toEqual([
    [2, start, 'ease-in-out'],
    [5, start + 90, 'ease-in-out'],
  ])
  await expect(page.getByRole('status').getByText(/^Keyframe added at 0:06/)).toBeVisible()

  // Halfway between them the field shows the eased value, which is half way for ease-in-out, and the keyframe
  // button adds a keyframe rather than removing the one at the playhead.
  await expect(page.getByRole('button', { name: 'Remove keyframe: Rotation' })).toBeVisible()
  await at(page, 4.5)
  await expect(rotation).toHaveValue(String(start + 45))
  await expect(page.getByRole('button', { name: 'Add keyframe: Rotation' })).toBeVisible()

  // On a keyframe, an edit changes it, as one undo step.
  await at(page, 3)
  await expect(rotation).toHaveValue(String(start))
  await rotation.fill(String(start - 20))
  await rotation.press('Enter')
  expect(await keys(page, 'rotation')).toEqual([
    [2, start - 20, 'ease-in-out'],
    [5, start + 90, 'ease-in-out'],
  ])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect
    .poll(() => keys(page, 'rotation'))
    .toEqual([
      [2, start, 'ease-in-out'],
      [5, start + 90, 'ease-in-out'],
    ])
  await expect(rotation).toHaveValue(String(start))
})

test('Scale keys and edits both axes', async ({ page }) => {
  await openTitle(page)
  const scale = page.getByRole('textbox', { name: 'Scale' })
  const start = Number(await scale.inputValue()) / 100
  await page.getByRole('button', { name: 'Add keyframe: Scale' }).click()
  await at(page, 6)
  await scale.fill('150')
  await scale.press('Enter')
  const expected = [
    [2, start, 'ease-in-out'],
    [5, 1.5, 'ease-in-out'],
  ]
  expect(await keys(page, 'scaleX')).toEqual(expected)
  expect(await keys(page, 'scaleY')).toEqual(expected)
  await at(page, 3)
  await expect(scale).toHaveValue(String(Math.round(start * 100)))
})
