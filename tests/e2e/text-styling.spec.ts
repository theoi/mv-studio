import type { Page } from '@playwright/test'
import type { Project, TextClip } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** A text clip of the sample as the inspector edits it. */
function textClip(page: Page, id: string) {
  return page.evaluate((id) => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips[id] as TextClip
    return { style: clip.style, preset: clip.animation?.presetId ?? null, karaoke: clip.karaoke ?? null }
  }, id)
}

async function open(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((hash) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = hash
  }, hash)
  await waitForPreview(page)
}

const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

test('a text clip’s weight, alignment, spacing, outline, shadow and animation come from the inspector', async ({
  page,
}, testInfo) => {
  await open(page, '#/editor?sel=clip:o-title&t=4')
  const before = await textClip(page, 'o-title')

  await page.getByRole('combobox', { name: 'Font weight' }).click()
  await page.getByRole('option', { name: 'Bold', exact: true }).click()
  await page.getByRole('radio', { name: 'Left' }).click()
  await page.getByRole('slider', { name: 'Spacing' }).focus()
  await page.keyboard.press('ArrowRight')
  expect((await textClip(page, 'o-title')).style).toMatchObject({
    fontWeight: 700,
    align: 'left',
    letterSpacing: before.style.letterSpacing + 0.01,
  })

  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await page.getByRole('switch', { name: 'Outline on' }).click()
  await page.getByRole('slider', { name: 'Width' }).focus()
  await page.keyboard.press('ArrowRight')
  expect((await textClip(page, 'o-title')).style.stroke).toEqual({ color: '#000000', width: 5 })

  // The sample title has a shadow, so its section says it is on.
  const shadow = page.getByRole('button', { name: /^Shadow/ })
  await expect(shadow).toContainText('On')
  await shadow.click()
  await page.screenshot({ path: testInfo.outputPath('text-styling.png'), fullPage: true })
  await page.getByRole('switch', { name: 'Shadow on' }).click()
  expect((await textClip(page, 'o-title')).style.shadow).toBeUndefined()
  await page.keyboard.press(undo)
  await expect.poll(async () => (await textClip(page, 'o-title')).style.shadow).toEqual(before.style.shadow)

  await page.getByRole('button', { name: 'Animation', exact: true }).click()
  await page.getByRole('combobox', { name: 'Kinetic preset' }).click()
  await page.getByRole('option', { name: /^None/ }).click()
  expect((await textClip(page, 'o-title')).preset).toBeNull()
})

test('a lyric line’s karaoke fills word by word or lights the whole line', async ({ page }) => {
  await open(page, '#/editor?sel=lyric:l-c1-2&t=70.4')
  const id = await page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    return Object.values(project.clips).find((c) => c.type === 'text' && c.lyricLineId === 'l-c1-2')!.id
  })
  const karaoke = page.getByRole('switch', { name: 'Karaoke word highlight' })
  if ((await karaoke.getAttribute('aria-checked')) === 'true') await karaoke.click()
  await expect(page.getByRole('radiogroup', { name: 'Karaoke fill' })).toHaveCount(0)
  await karaoke.click()
  await expect(page.getByRole('radio', { name: 'By word' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: 'By line' }).click()
  expect((await textClip(page, id)).karaoke?.mode).toBe('line')
  await page.keyboard.press(undo)
  await expect.poll(async () => (await textClip(page, id)).karaoke?.mode).toBe('word')
})
