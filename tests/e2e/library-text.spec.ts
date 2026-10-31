import type { Page } from '@playwright/test'
import type { Project, TextClip } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openTextTab(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=text&t=73.6'
  })
  await waitForPreview(page)
  const library = page.getByRole('tabpanel', { name: 'Text' })
  // Each group shows two rows until "Show all N"; open them all so every tile can be reached.
  const showAll = library.getByRole('button', { name: /^Show all \d+$/ })
  await expect(showAll.first()).toBeVisible()
  while ((await showAll.count()) > 0) await showAll.first().click()
  return library
}

/** Mean absolute pixel difference (0..255) between two same-sized PNGs, below the top 15% where toasts show. */
async function imageDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([a64, b64]) => {
      const read = async (s: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob())
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      }
      const [x, y] = await Promise.all([read(a64), read(b64)])
      const from = Math.floor(x.length * 0.15) & ~3
      let sum = 0
      for (let i = from; i < x.length; i++) if (i % 4 !== 3) sum += Math.abs(x[i] - y[i])
      return sum / (((x.length - from) / 4) * 3)
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

/** A screenshot of the preview once two in a row match. */
async function steadyShot(page: Page): Promise<Buffer> {
  const preview = page.getByRole('img', { name: 'Video preview' })
  let last = await preview.screenshot()
  await expect
    .poll(async () => {
      const next = await preview.screenshot()
      const diff = await imageDiff(page, last, next)
      last = next
      return diff
    })
    .toBeLessThan(0.05)
  return last
}

/** Kinetic preset ids of the lyric lines, in time order. */
function lyricAnimations(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    return Object.values(project.clips)
      .filter((c): c is TextClip => c.type === 'text' && !!c.lyricLineId)
      .sort((a, b) => a.start - b.start)
      .map((c) => c.animation?.presetId ?? null)
  })
}

test('a kinetic preset from the library goes on every lyric line as one undo step', async ({
  page,
}, testInfo) => {
  const library = await openTextTab(page)
  const karaoke = library.getByRole('group', { name: 'Karaoke styles' })
  for (const name of ['Karaoke', 'Line light', 'Bounce along'])
    await expect(karaoke.getByRole('button', { name, exact: true })).toBeVisible()
  const textStyles = library.getByRole('group', { name: 'Text styles' })
  await expect(textStyles.getByRole('button', { name: 'Neon sign', exact: true })).toBeVisible()
  await expect(textStyles.getByRole('button', { name: 'Karaoke', exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('text-tab.png') })
  const before = await lyricAnimations(page)
  expect(before.length).toBeGreaterThan(3)

  await library.getByRole('button', { name: 'Beat bounce', exact: true }).click()
  await expect(page.getByText(`“Beat bounce” on ${before.length} lyric lines`)).toBeVisible()
  expect(await lyricAnimations(page)).toEqual(before.map(() => 'bounce'))

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(() => lyricAnimations(page)).toEqual(before)
})

test('added text takes a text style from the library, with its kinetic preset', async ({
  page,
}, testInfo) => {
  const library = await openTextTab(page)
  const preview = page.getByRole('img', { name: 'Video preview' })
  await library.getByRole('button', { name: 'Add text' }).click()
  const added = page.getByRole('button', { name: /^Text, 1:13\.\d to / })
  await expect(added).toHaveAttribute('aria-pressed', 'true')
  // Past the entrance, where a kinetic preset leaves the words fully drawn.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(page.getByText(/^01:15\.00/)).toBeVisible()
  const plain = await steadyShot(page)

  await library.getByRole('button', { name: 'Neon sign', exact: true }).click()
  await expect(page.getByText('“Neon sign” on “Text”')).toBeVisible()
  const clip = await page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const text = Object.values(project.clips).find((c) => c.type === 'text' && c.name === 'Text')
    return text?.type === 'text' ? { text: text.text, style: text.style, animation: text.animation } : null
  })
  expect(clip).toMatchObject({
    text: 'Your text',
    style: { textTransform: 'uppercase', stroke: { color: '#ff3df2' } },
    animation: { presetId: 'flicker' },
  })
  await expect.poll(async () => imageDiff(page, plain, await preview.screenshot())).toBeGreaterThan(0.5)
  await page.screenshot({ path: testInfo.outputPath('text-styled.png') })
})

test('with nothing to change, a preset says how to get text', async ({ page }) => {
  const library = await openTextTab(page)
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const project: Project = editor.getProject()
    const lines = Object.values(project.clips).filter((c) => c.type === 'text')
    editor.dispatch({ type: 'clip.remove', clipIds: lines.map((c) => c.id) }, { label: 'Remove text' })
  })
  await library.getByRole('button', { name: 'Wave', exact: true }).click()
  // The toast, and the note under Add text says the same.
  await expect(
    page.getByRole('status').getByText('Select a text or lyric line, or add text first'),
  ).toBeVisible()
  await expect(library.getByText('Select a text or lyric line, or add text first')).toBeVisible()
})

test('hovering a kinetic preset tile plays it on the sample lyric', async ({ page }) => {
  const library = await openTextTab(page)
  const tile = library.getByRole('button', { name: 'Typewriter', exact: true })
  const still = await tile.screenshot()
  await tile.hover()
  await expect.poll(async () => imageDiff(page, still, await tile.screenshot())).toBeGreaterThan(1)
})

test('a karaoke style lights every lyric line up a whole line at a time, as one undo step', async ({
  page,
}) => {
  const library = await openTextTab(page)
  const karaoke = () =>
    page.evaluate(() => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      return Object.values(project.clips)
        .filter((c): c is TextClip => c.type === 'text' && !!c.lyricLineId)
        .map((c) => c.karaoke ?? null)
    })
  const before = await karaoke()
  expect(before.length).toBeGreaterThan(3)
  await library
    .getByRole('group', { name: 'Karaoke styles' })
    .getByRole('button', { name: 'Line light', exact: true })
    .click()
  await expect(page.getByText(`“Line light” on ${before.length} lyric lines`)).toBeVisible()
  expect(await karaoke()).toEqual(before.map(() => ({ highlightColor: '#ffffff', mode: 'line' })))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(karaoke).toEqual(before)
})

test('the text groups show two rows each with a count, and "Show all" opens one for the session', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=text&t=73.6'
  })
  await waitForPreview(page)
  const library = page.getByRole('tabpanel', { name: 'Text' })
  const kinetic = library.getByRole('group', { name: 'Kinetic presets' })
  const total = Number((await library.getByText(/^Kinetic presets · \d+$/).textContent())?.match(/\d+$/)?.[0])
  const columns = await kinetic.evaluate(
    (grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length,
  )
  expect(total).toBeGreaterThanOrEqual(2 * columns + 2)
  await expect(kinetic.getByRole('button')).toHaveCount(2 * columns)
  // The four karaoke styles fit in two rows, so that group has no button.
  await expect(library.getByRole('group', { name: 'Karaoke styles' }).getByRole('button')).toHaveCount(4)
  // Text styles has as many, so its button has the same name; Kinetic presets comes first.
  await library
    .getByRole('button', { name: `Show all ${total}` })
    .first()
    .click()
  await expect(kinetic.getByRole('button')).toHaveCount(total)
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('tab', { name: 'Text' }).click()
  await expect(kinetic.getByRole('button')).toHaveCount(total)
})

test('the note under Add text says where a click goes, and a click on a video clip changes nothing', async ({
  page,
}) => {
  await openHarness(page)
  const to = (hash: string) =>
    page.evaluate((hash) => {
      localStorage.setItem('mv-studio.guide-seen', '1')
      window.location.hash = hash
    }, hash)
  await to('#/editor?lib=text&t=73.6')
  await waitForPreview(page)
  const library = page.getByRole('tabpanel', { name: 'Text' })
  await expect(library.getByText('Click a style to use it on every lyric line')).toBeVisible()
  await to('#/editor?lib=text&sel=clip:o-title&t=3')
  await expect(library.getByText('Click a style to use it on “Title”')).toBeVisible()
  await to('#/editor?lib=text&sel=lyric:l-c1-2&t=70.4')
  await expect(library.getByText('Click a style to use it on this lyric line')).toBeVisible()
  await library.getByRole('button', { name: 'Neon sign' }).first().click()
  await expect(page.getByRole('status').getByText('“Neon sign” on this lyric line')).toBeVisible()

  await to('#/editor?lib=text&sel=clip:c-s-c1-1&t=67.2')
  await expect(library.getByText('Select a text or lyric line to restyle it')).toBeVisible()
  const styles = () =>
    page.evaluate(() => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      return Object.values(project.clips)
        .filter((c): c is TextClip => c.type === 'text')
        .map((c) => JSON.stringify([c.style, c.karaoke ?? null, c.animation ?? null]))
    })
  const before = await styles()
  await library.getByRole('button', { name: 'Neon sign' }).first().click()
  await expect(page.getByRole('status').getByText('Select a text or lyric line first')).toBeVisible()
  expect(await styles()).toEqual(before)
})

test('with several clips selected, a style goes on the texts among them as one undo step', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=text&t=3'
  })
  await waitForPreview(page)
  const ids = await page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const line = Object.values(project.clips).find((c) => c.type === 'text' && c.lyricLineId === 'l-c1-2')
    const ids = ['c-s-c1-1', line!.id, 'o-title']
    window.mvStudio.app.ui.selectClips(ids)
    return ids
  })
  const library = page.getByRole('tabpanel', { name: 'Text' })
  await expect(library.getByText('Click a style to use it on 2 texts')).toBeVisible()
  const styleOf = () =>
    page.evaluate((ids) => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      return ids.map((id) => {
        const clip = project.clips[id]
        return clip?.type === 'text' ? JSON.stringify([clip.style.fontFamily, clip.style.color]) : clip?.type
      })
    }, ids)
  const before = await styleOf()
  await library.getByRole('button', { name: 'Neon sign' }).first().click()
  await expect(page.getByRole('status').getByText('“Neon sign” on 2 texts')).toBeVisible()
  const after = await styleOf()
  expect(after[0]).toBe('video')
  expect(after[1]).toBe(after[2])
  expect(after).not.toEqual(before)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(styleOf).toEqual(before)

  // With the title's track locked, the title is left out, and the note and the toast say so.
  await page
    .locator('[class*="trackHeader"]')
    .filter({ hasText: /^Overlay/ })
    .getByRole('button', { name: 'Lock track' })
    .click()
  await page.evaluate((ids) => window.mvStudio.app.ui.selectClips(ids), ids)
  await expect(
    library.getByText('Click a style to use it on this lyric line. 1 text is on a locked track.'),
  ).toBeVisible()
  await library.getByRole('button', { name: 'Neon sign' }).first().click()
  await expect(
    page
      .getByRole('status')
      .getByText('“Neon sign” on this lyric line · 1 text on a locked track was left as is'),
  ).toBeVisible()
  const locked = await styleOf()
  expect(locked[2]).toBe(before[2])
  expect(locked[1]).not.toBe(before[1])
})
