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

/** A 2×2×2 .cube LUT that lifts the shadows by `lift` toward teal, so different lifts are different LUTs. */
const cubeFile = (name: string, title: string, lift = 0.1) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(
    [
      `TITLE "${title}"`,
      'LUT_3D_SIZE 2',
      ...[`0 ${lift} ${lift}`, '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'],
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

type TestFile = { name: string; mimeType: string; buffer: Buffer }

/** The color grade's LUT choice in the Inspector, and loading a file through its "Load a LUT file…". */
function lutChoice(page: Page) {
  const lut = page
    .getByRole('tabpanel', { name: 'Inspector' })
    .getByRole('combobox', { name: 'Color grade LUT' })
  const load = async (file: TestFile) => {
    await lut.click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('option', { name: /^Load a LUT file…/ }).click()
    await (await chooser).setFiles(file)
  }
  const options = async () => {
    await lut.click()
    const texts = await page.getByRole('option').allInnerTexts()
    await page.keyboard.press('Escape')
    return texts.map((o) => o.split('\n')[0])
  }
  return { lut, load, options }
}

const toastText = (page: Page, text: string | RegExp) => page.getByRole('status').getByText(text)

test('a LUT file loads from the LUT choice as one undo step, once per file, and Import media takes .cube files', async ({
  page,
}) => {
  await openWithEffects(page, ['Color grade'])
  const { lut, load, options } = lutChoice(page)
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

  await load(cubeFile('teal.cube', 'Teal push'))
  await expect(lut).toHaveText('Teal push')
  expect((await lutSetting())?.file).toBe('Teal push')
  expect(await undoLabel(page)).toBe('Add LUT Teal push')
  // Ctrl+Z stays with the focused LUT choice, so the toast offers Undo; it removes the file too.
  await expect(toastText(page, 'Added the LUT “Teal push”')).toBeVisible()
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).last().click()
  await expect(lut).toHaveText('None')
  expect(await lutSetting()).toEqual({ value: '', file: null })

  // The same file again adds nothing and chooses the LUT already there; another file with a taken name is numbered.
  await load(cubeFile('teal.cube', 'Teal push'))
  await expect(lut).toHaveText('Teal push')
  await load(await png(page, 'identity-hald.png', 8))
  await expect(lut).toHaveText('identity-hald')
  await load(cubeFile('teal copy.cube', 'Teal push'))
  await expect(toastText(page, '“Teal push” is already in this project.')).toBeVisible()
  await expect(lut).toHaveText('Teal push')
  await load(cubeFile('teal-v2.cube', 'Teal push', 0.3))
  await expect(lut).toHaveText('Teal push 2')

  await load(await png(page, 'photo.png', 10))
  await expect(toastText(page, 'photo.png was not loaded: it isn’t a LUT image.')).toBeVisible()
  await load({ name: 'broken.cube', mimeType: 'text/plain', buffer: Buffer.from('not a LUT') })
  await expect(
    toastText(page, 'broken.cube was not loaded: the file couldn’t be read as a LUT.'),
  ).toBeVisible()
  await expect(lut).toHaveText('Teal push 2')

  // A .cube file from Import media joins the LUT choice; it is not media, so the toast says where it went.
  const importInput = page.getByLabel('Import media files')
  await importInput.setInputFiles(cubeFile('warm.cube', 'Warm', 0.5))
  await expect(toastText(page, 'Imported the LUT “Warm”. Choose it in a Color grade’s LUT.')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Effects', selected: true })).toBeVisible()
  await importInput.setInputFiles(cubeFile('warm.cube', 'Warm', 0.5))
  await expect(toastText(page, '“Warm” is already in this project.')).toBeVisible()
  await importInput.setInputFiles([cubeFile('a.cube', 'Dawn', 0.6), cubeFile('b.cube', 'Dusk', 0.7)])
  await expect(toastText(page, 'Imported 2 LUTs. Choose them in a Color grade’s LUT.')).toBeVisible()
  await importInput.setInputFiles([cubeFile('c.cube', 'Cold', 0.8), await png(page, 'still.png', 10)])
  await expect(toastText(page, 'Imported 2 files: 1 clip or image, 1 LUT.')).toBeVisible()

  // Dropped on a track, a .cube file is a LUT too, and no clip.
  const clipCount = () =>
    page.evaluate(() => Object.keys(window.mvStudio.app.project.editor.getProject().clips).length)
  const clips = await clipCount()
  const cube = cubeFile('cool.cube', 'Cool', 0.9).buffer.toString('base64')
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
  await expect(toastText(page, 'Imported the LUT “Cool”. Choose it in a Color grade’s LUT.')).toBeVisible()
  expect(await clipCount()).toBe(clips)

  // Oldest first; two files imported together may finish in either order.
  const listed = await options()
  expect([...listed.slice(0, 6), ...listed.slice(8)]).toEqual([
    'None',
    'Neutral',
    'Teal push',
    'identity-hald',
    'Teal push 2',
    'Warm',
    'Cold',
    'Cool',
    'Load a LUT file…',
    'Manage LUT files…',
  ])
  expect(listed.slice(6, 8).sort()).toEqual(['Dawn', 'Dusk'])
})

test('Manage LUT files lists what uses each LUT, and Remove puts those grades back to no LUT as one undo step', async ({
  page,
}) => {
  await openWithEffects(page, ['Color grade'])
  const { lut, options } = lutChoice(page)
  // A picker closed without a file changes nothing and gives focus back to the choice.
  await lut.click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('option', { name: /^Load a LUT file…/ }).click()
  await (await chooser).element().dispatchEvent('cancel')
  await expect(lut).toBeFocused()
  await expect(lut).toHaveText('None')
  expect(await options()).toEqual(['None', 'Neutral', 'Load a LUT file…'])

  for (const [file, title, lift] of [
    ['teal.cube', 'Teal push', 0.1],
    ['warm.cube', 'Warm', 0.3],
    ['cool.cube', 'Cool', 0.5],
  ] as const) {
    await page.getByLabel('Import media files').setInputFiles(cubeFile(file, title, lift))
    await expect(
      toastText(page, `Imported the LUT “${title}”. Choose it in a Color grade’s LUT.`),
    ).toBeVisible()
  }
  await lut.click()
  await page.getByRole('option', { name: 'Teal push' }).click()
  await expect(lut).toHaveText('Teal push')
  // The look's own color grade uses it too.
  await page.evaluate(() => {
    const { app, plugins } = window.mvStudio
    const project: Project = app.project.editor.getProject()
    const teal = Object.values(project.assets).find((a) => a.name === 'Teal push')!
    const grade = plugins.library.createEffectInstance('color-grade')
    grade.params.lut = { value: teal.id }
    app.project.editor.dispatch({ type: 'effect.add', clipId: 'c-look', effect: grade })
  })

  const manage = async () => {
    await lut.click()
    await page.getByRole('option', { name: 'Manage LUT files…' }).click()
  }
  const dialog = page.getByRole('dialog', { name: 'LUT files' })
  const rows = [/^Teal push\s*Used by 2 color grades$/, /^Warm\s*Not used$/, /^Cool\s*Not used$/]
  // Closing the dialog gives focus back to the LUT choice it was opened from.
  await manage()
  await expect(dialog.getByRole('listitem')).toHaveText(rows)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(lut).toBeFocused()
  await manage()
  await dialog.getByRole('button', { name: 'Remove Teal push' }).click()
  await expect(toastText(page, 'Removed the LUT “Teal push”. 2 color grades no longer use it.')).toBeVisible()
  expect(await undoLabel(page)).toBe('Remove LUT Teal push')
  await expect(dialog.getByRole('button', { name: 'Remove Warm' })).toBeFocused()
  await expect(dialog.getByRole('listitem')).toHaveCount(2)
  // The toast's Undo brings the LUT back where it was, with both grades set to it again.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).last().click()
  await expect(dialog.getByRole('listitem')).toHaveText(rows)
  expect(
    await page.evaluate(() => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      const teal = Object.values(project.assets).find((a) => a.name === 'Teal push')
      return Object.values(project.clips).filter(
        (c) => c.type !== 'audio' && c.effects.some((e) => teal && e.params.lut?.value === teal.id),
      ).length
    }),
  ).toBe(2)

  // Focus goes to the next Remove, else the previous one, else Load a LUT file….
  await dialog.getByRole('button', { name: 'Remove Cool' }).click()
  await expect(dialog.getByRole('button', { name: 'Remove Warm' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Remove Teal push' }).click()
  await expect(dialog.getByRole('button', { name: 'Remove Warm' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Remove Warm' }).click()
  await expect(dialog.getByRole('button', { name: 'Load a LUT file…' })).toBeFocused()
  await expect(dialog.getByText('No LUT files in this project.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lut).toBeFocused()
  await expect(lut).toHaveText('None')
  expect(await options()).toEqual(['None', 'Neutral', 'Load a LUT file…'])
})

test('LUT files shows a long file name in full as a tooltip, under a description on one line', async ({
  page,
}) => {
  await openWithEffects(page, ['Color grade'])
  const { lut } = lutChoice(page)
  const long = 'Warm sunset film emulation with lifted blacks and a long name'
  for (const [file, title, lift] of [
    ['warm.cube', long, 0.3],
    ['cool.cube', 'Cool', 0.5],
  ] as const) {
    await page.getByLabel('Import media files').setInputFiles(cubeFile(file, title, lift))
    await expect(
      toastText(page, `Imported the LUT “${title}”. Choose it in a Color grade’s LUT.`),
    ).toBeVisible()
  }
  await lut.click()
  await page.getByRole('option', { name: 'Manage LUT files…' }).click()
  const dialog = page.getByRole('dialog', { name: 'LUT files' })
  const name = dialog.getByText(long, { exact: true })
  await name.hover()
  await expect(name).toHaveAttribute('title', long)
  const short = dialog.getByText('Cool', { exact: true })
  await short.hover()
  await expect(short).not.toHaveAttribute('title', /./)
  const lines = await dialog.getByText(/^Removing one/).evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
  })
  expect(lines).toBe(1)
})
