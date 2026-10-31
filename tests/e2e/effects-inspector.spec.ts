import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** An effect on the clip it was added to, as the inspector edits it. */
function effect(page: Page, effectId: string) {
  return page.evaluate((effectId) => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    for (const clip of Object.values(project.clips)) {
      if (clip.type === 'audio') continue
      const fx = clip.effects.find((e) => e.effectId === effectId)
      if (fx)
        return {
          enabled: fx.enabled,
          amount: fx.params.amount?.value,
          reacts: !!fx.params.amount?.modulation?.length,
        }
    }
    return null
  }, effectId)
}

const undoLabel = (page: Page): Promise<string | null> =>
  page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())

async function openWithEffects(page: Page, names: string[]) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=effects&t=66.9'
  })
  await waitForPreview(page)
  const library = page.getByRole('tabpanel', { name: 'Effects' })
  for (const name of names) {
    await library.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('status').getByText(`“${name}” added to Singer close-up`)).toBeVisible()
  }
  await page
    .getByRole('tabpanel', { name: 'Inspector' })
    .getByRole('button', { name: /^Effects/ })
    .click()
}

test('a clip’s effects show their own settings named after the effect, turn off and on, and are removed', async ({
  page,
}, testInfo) => {
  await openWithEffects(page, ['RGB split', 'Glow'])

  // Each effect's settings say whose they are, so two effects' sliders are told apart.
  const amount = page.getByRole('slider', { name: 'RGB split amount' })
  await expect(amount).toBeVisible()
  await expect(page.getByRole('slider', { name: 'RGB split angle' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Glow intensity' })).toBeVisible()
  // RGB split comes with a music reaction on Amount, which the react button shows.
  await expect(page.getByRole('button', { name: 'React to music: RGB split amount' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.screenshot({ path: testInfo.outputPath('effects-section.png') })
  const before = await effect(page, 'rgb-split')
  await amount.focus()
  await page.keyboard.press('ArrowRight')
  expect((await effect(page, 'rgb-split'))?.amount).toBeGreaterThan(Number(before?.amount))
  expect(await undoLabel(page)).toBe('Change RGB split amount')

  // Secondary settings wait under More.
  await expect(page.getByLabel('Glow tint')).toHaveCount(0)
  await page.getByRole('button', { name: 'More Glow settings' }).click()
  await expect(page.getByLabel('Glow tint')).toBeVisible()

  // Off, an effect keeps its settings, dimmed.
  await page.getByRole('switch', { name: 'RGB split on' }).click()
  expect((await effect(page, 'rgb-split'))?.enabled).toBe(false)
  await expect(amount.locator('xpath=ancestor::div[contains(@class, "effectOff")]')).toHaveCount(1)

  // Removing one moves focus to the next effect, and the last to Add effect.
  await page.getByRole('button', { name: 'Remove RGB split' }).focus()
  await page.keyboard.press('Enter')
  expect(await effect(page, 'rgb-split')).toBeNull()
  await expect(page.getByRole('switch', { name: 'Glow on' })).toBeFocused()
  await page.getByRole('button', { name: 'Remove Glow' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('No effects yet. Add one from Library › Effects.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add effect' })).toBeFocused()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await effect(page, 'rgb-split'))?.enabled).toBe(false)
})

test('the 3D camera move is set in Motion only, and a LUT choice lists LUT files and the built-in one by name', async ({
  page,
}, testInfo) => {
  await openWithEffects(page, ['Color grade', 'Film grain'])
  await page.evaluate(() => {
    const { app, plugins } = window.mvStudio
    const editor = app.project.editor
    const project: Project = editor.getProject()
    const clip = Object.values(project.clips).find(
      (c) => c.type !== 'audio' && c.effects.some((e) => e.effectId === 'color-grade'),
    )!
    const index = clip.type === 'audio' ? -1 : clip.effects.findIndex((e) => e.effectId === 'color-grade')
    editor.dispatch([
      { type: 'effect.add', clipId: clip.id, effect: plugins.library.createEffectInstance('camera-3d') },
      {
        type: 'clip.set',
        clipId: clip.id,
        path: ['effects', index, 'params', 'lut', 'value'],
        value: 'bundled:luts/neutral.png',
      },
    ])
  })
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByRole('switch', { name: '3D camera move on' })).toBeVisible()
  await expect(inspector.getByRole('slider', { name: /^3D camera move/ })).toHaveCount(0)
  await expect(inspector.getByRole('combobox', { name: /^3D camera move/ })).toHaveCount(0)

  // A setting's name does not repeat the word it shares with its effect's, and a long grade name fits unclipped in
  // the narrow inspector of a small window.
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(inspector.getByRole('slider', { name: 'Film grain size' })).toBeVisible()
  const grade = inspector.getByRole('combobox', { name: 'Color grade', exact: true })
  await expect(grade).toHaveText('Teal and orange')
  await grade.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('grade-select.png') })
  expect(
    await grade
      .locator('span')
      .first()
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true)

  const lut = inspector.getByRole('combobox', { name: 'Color grade LUT' })
  await expect(lut).toHaveText('Neutral')
  await lut.click()
  const options = await page.getByRole('option').allInnerTexts()
  expect(options.map((o) => o.split('\n')[0])).toEqual(['None', 'Neutral', 'Load a LUT file…'])
  await page.keyboard.press('Escape')
})

/** A 2×2×2 .cube LUT that lifts the shadows toward teal. */
const cubeFile = (name: string, title: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(
    [
      `TITLE "${title}"`,
      'LUT_3D_SIZE 2',
      ...['0 0.1 0.1', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'],
    ].join('\n'),
  ),
})

/** A PNG made in the page: a level-2 Hald CLUT (8×8, the identity) or, at another size, an ordinary image. */
async function png(page: Page, name: string, side: number) {
  const bytes = await page.evaluate(async (side) => {
    const canvas = new OffscreenCanvas(side, side)
    const ctx = canvas.getContext('2d')!
    const image = ctx.createImageData(side, side)
    for (let i = 0; i < side * side; i++)
      image.data.set([(i % 4) * 85, (Math.floor(i / 4) % 4) * 85, (Math.floor(i / 16) % 4) * 85, 255], i * 4)
    ctx.putImageData(image, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, side)
  return { name, mimeType: 'image/png', buffer: Buffer.from(bytes) }
}

test('a LUT file loads from the LUT choice as one undo step, a Hald image too, and Import media takes .cube files', async ({
  page,
}) => {
  await openWithEffects(page, ['Color grade'])
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const lut = inspector.getByRole('combobox', { name: 'Color grade LUT' })
  await expect(lut).toHaveText('None')
  /** The color grade's LUT setting, and the name of the file it points to. */
  const lutSetting = () =>
    page.evaluate(() => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      for (const clip of Object.values(project.clips)) {
        if (clip.type === 'audio') continue
        const value = clip.effects.find((e) => e.effectId === 'color-grade')?.params.lut?.value
        if (value !== undefined) return { value, file: project.assets[String(value)]?.name ?? null }
      }
      return null
    })
  const load = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
    await lut.click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('option', { name: /^Load a LUT file…/ }).click()
    await (await chooser).setFiles(file)
  }

  await load(cubeFile('teal.cube', 'Teal push'))
  await expect(lut).toHaveText('Teal push')
  expect((await lutSetting())?.file).toBe('Teal push')
  expect(await undoLabel(page)).toBe('Add LUT Teal push')
  // Ctrl+Z stays with the focused LUT choice, so the toast offers Undo; it removes the file too.
  await expect(page.getByRole('status').getByText('Added the LUT “Teal push”')).toBeVisible()
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).last().click()
  await expect(lut).toHaveText('None')
  expect(await lutSetting()).toEqual({ value: '', file: null })

  await load(await png(page, 'identity-hald.png', 8))
  await expect(lut).toHaveText('identity-hald')
  await load(await png(page, 'photo.png', 10))
  await expect(
    page.getByRole('status').getByText(/^photo\.png was not loaded: This image is not a Hald CLUT/),
  ).toBeVisible()
  await expect(lut).toHaveText('identity-hald')

  // A .cube file from Import media joins the LUT choice; it is not media, so the toast says where it went.
  await page.getByLabel('Import media files').setInputFiles(cubeFile('warm.cube', 'Warm'))
  await expect(
    page.getByRole('status').getByText('Imported the LUT “Warm”. Choose it in a Color grade’s LUT.'),
  ).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Effects', selected: true })).toBeVisible()

  // Dropped on a track, a .cube file is a LUT too, and no clip.
  const clipCount = () =>
    page.evaluate(() => Object.keys(window.mvStudio.app.project.editor.getProject().clips).length)
  const clips = await clipCount()
  const cube = cubeFile('cool.cube', 'Cool').buffer.toString('base64')
  await page
    .locator('[data-timeline-scroller] div[class*="row"]')
    .filter({ has: page.locator('span[class*="trackName"]', { hasText: /^Video$/ }) })
    .locator('div[class*="lane"]')
    .first()
    .evaluate((el, b64) => {
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'cool.cube'))
      const r = el.getBoundingClientRect()
      const init = {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
        clientX: r.left + 40,
        clientY: r.top + 10,
      }
      el.dispatchEvent(new DragEvent('dragover', init))
      el.dispatchEvent(new DragEvent('drop', init))
    }, cube)
  await expect(
    page.getByRole('status').getByText('Imported the LUT “Cool”. Choose it in a Color grade’s LUT.'),
  ).toBeVisible()
  expect(await clipCount()).toBe(clips)
  await lut.click()
  const options = await page.getByRole('option').allInnerTexts()
  expect(options.map((o) => o.split('\n')[0])).toEqual([
    'None',
    'identity-hald',
    'Warm',
    'Cool',
    'Load a LUT file…',
  ])
  await page.keyboard.press('Escape')
})
