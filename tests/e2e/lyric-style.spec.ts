import type { Page } from '@playwright/test'
import type { Project, TextClip } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openLyricLine(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?sel=lyric:l-c1-2&t=70.4'
  })
  await waitForPreview(page)
  await expect(page.getByText('Lyric line', { exact: true })).toBeVisible()
}

/** The selected line's clip and how many lyric lines share its preset, font and color. */
function lines(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const all = Object.values(project.clips).filter(
      (c): c is TextClip => c.type === 'text' && !!c.lyricLineId,
    )
    const line = all.find((c) => c.lyricLineId === 'l-c1-2')!
    const same = (c: TextClip) =>
      c.animation?.presetId === line.animation?.presetId &&
      c.style.fontFamily === line.style.fontFamily &&
      c.style.color === line.style.color
    return {
      count: all.length,
      matching: all.filter(same).length,
      preset: line.animation?.presetId ?? null,
      exit: line.animation?.params.exit ?? null,
      font: line.style.fontFamily,
      color: line.style.color,
      highlight: line.karaoke?.highlightColor ?? null,
      y: line.transform.y.value,
    }
  })
}

test('a lyric line takes a kinetic preset, font, colors and position from the inspector, then every line takes its style', async ({
  page,
}, testInfo) => {
  await openLyricLine(page)
  const before = await lines(page)

  await page.getByRole('combobox', { name: 'Kinetic preset' }).click()
  await page.getByRole('option', { name: /^Stamp/ }).click()
  await page.getByRole('combobox', { name: 'Font' }).click()
  await page.getByRole('option', { name: /^Anton/ }).click()
  await page.getByLabel('Text color').fill('#ff3366')
  await page.getByRole('radio', { name: 'Top' }).click()
  await page.getByRole('button', { name: 'Animation' }).click()
  await page.getByRole('combobox', { name: 'Exit' }).click()
  await page.getByRole('option', { name: 'Fade' }).click()

  const styled = await lines(page)
  expect(styled).toMatchObject({
    preset: 'stamp',
    exit: 'fade',
    font: 'Anton, Impact, sans-serif',
    color: '#ff3366',
    y: 0.22,
  })
  expect(styled.matching).toBe(1)
  await expect(page.getByRole('combobox', { name: 'Kinetic preset' })).toHaveText(/Stamp/)
  await expect(page.getByRole('slider', { name: 'Shake' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('lyric-style.png') })

  await page.getByRole('button', { name: 'Apply style to all lines' }).click()
  await expect(page.getByText(`Style applied to all ${before.count} lyric lines`)).toBeVisible()
  expect((await lines(page)).matching).toBe(before.count)

  // One undo puts the other lines back; the selected line keeps its own changes.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await lines(page)).matching).toBe(1)
})

test('the karaoke highlight turns on and its color changes as one undo step per pick', async ({ page }) => {
  await openLyricLine(page)
  const karaoke = page.getByRole('switch', { name: 'Karaoke word highlight' })
  if ((await karaoke.getAttribute('aria-checked')) === 'true') await karaoke.click()
  await expect(page.getByLabel('Highlight color')).toHaveCount(0)
  await karaoke.click()
  await expect(karaoke).toHaveAttribute('aria-checked', 'true')
  await page.getByLabel('Highlight color').fill('#22d3ee')
  expect((await lines(page)).highlight).toBe('#22d3ee')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await lines(page)).highlight).toBe('#ffd27a')
})
