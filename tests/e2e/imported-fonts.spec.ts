import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { Project, TextClip } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * Press Start 2P (SIL OFL, already bundled from Fontsource), imported under another name: only the imported file can
 * draw "Arcade", and the bundled copy shows what it should look like.
 */
const ARCADE = {
  name: 'Arcade.woff2',
  mimeType: 'font/woff2',
  buffer: readFileSync(
    path.join(
      process.cwd(),
      'node_modules/@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2',
    ),
  ),
}

/** The preview's frame as 160×90 gray levels, read through captureFrame() (the canvas is drawn in a worker). */
const previewFrame = (page: Page): Promise<number[]> =>
  page.evaluate(async () => {
    const frame: ImageBitmap = await window.mvStudio.app.stagePreview().captureFrame()
    const ctx = new OffscreenCanvas(160, 90).getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(frame, 0, 0, 160, 90)
    const d = ctx.getImageData(0, 0, 160, 90).data
    const gray: number[] = []
    for (let i = 0; i < d.length; i += 4) gray.push((d[i]! + d[i + 1]! + d[i + 2]!) / 3)
    return gray
  })

/** Mean absolute difference of two gray frames, 0..255. */
const diff = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length

test('an imported font is chosen in Font, draws the text in preview and export, comes back after a reload, and a removed one falls back', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?sel=clip:o-title&t=3'
  })
  await waitForPreview(page)
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const font = inspector.getByRole('combobox', { name: 'Font', exact: true })
  const original = (await font.textContent()) ?? ''
  expect(original).not.toBe('Arcade')
  // Regular, the weight an imported font starts at, so its fallback below draws like this.
  const weight = inspector.getByRole('combobox', { name: 'Font weight' })
  await weight.click()
  await page.getByRole('option', { name: 'Regular', exact: true }).click()
  await expect(weight).toHaveText('Regular')
  await page.waitForTimeout(500)
  const before = await previewFrame(page)

  // A file the browser can't read as a font is refused, so it never shows in Font.
  await page
    .getByLabel('Import media files')
    .setInputFiles({ name: 'Broken.woff2', mimeType: 'font/woff2', buffer: Buffer.from('not a font file') })
  await expect(
    page
      .getByRole('status')
      .getByText('Broken.woff2 was not imported: Broken.woff2 isn’t a font this browser can read'),
  ).toBeVisible()

  // Imported fonts get a group of their own in Font, ahead of the bundled ones.
  await page.getByLabel('Import media files').setInputFiles(ARCADE)
  await expect(
    page.getByRole('status').getByText('Imported the font “Arcade”. Choose it in a text’s Font.'),
  ).toBeVisible()
  await font.click()
  const imported = page.getByRole('group', { name: 'Imported' })
  await expect(imported.getByRole('option')).toHaveText(['Arcade'])
  await expect(
    page.getByRole('group', { name: 'Bundled' }).getByRole('option', { name: /^Press Start 2P/ }),
  ).toBeVisible()
  await imported.getByRole('option', { name: 'Arcade' }).click()
  await expect(font).toHaveText('Arcade')
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe('Font: Arcade')
  await expect.poll(async () => diff(await previewFrame(page), before)).toBeGreaterThan(3)
  const arcade = await previewFrame(page)
  // The file is one regular face, so Weight offers Regular only: other weights would be faked.
  await weight.click()
  await expect(page.getByRole('option')).toHaveText(['Regular'])
  await page.keyboard.press('Escape')

  // Export draws it from the file stored with the project, glyph for glyph like the bundled copy.
  const exported = await page.evaluate(async () => {
    const { app, model, plugins, testing } = window.mvStudio
    const project: Project = app.project.editor.getProject()
    const title = project.clips['o-title'] as TextClip
    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const render = async (style: TextClip['style']) => {
      const p: Project = model.createProject({ name: 'font' })
      p.assets = project.assets
      const clip: TextClip = model.createTextClip({
        trackId: p.tracks[0]!.id,
        text: 'NEON',
        start: 0,
        duration: 4,
      })
      clip.style = { ...style, fontSize: 160 }
      p.clips[clip.id] = clip
      await compositor.render(p, 1)
      const d = testing.readPixels(compositor.canvas, W, H)
      const gray: number[] = []
      for (let i = 0; i < d.length; i += 4) gray.push((d[i]! + d[i + 1]! + d[i + 2]!) / 3)
      return gray
    }
    const { fontAssetId: _imported, ...plain } = title.style
    const imported = await render(title.style)
    const bundled = await render({
      ...plain,
      fontFamily: plugins.typography.fonts.fontStack('Press Start 2P'),
    })
    const fallback = await render({
      ...plain,
      fontFamily: title.style.fontFamily.split(',').slice(1).join(','),
    })
    compositor.dispose()
    const d = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length
    return { bundled: d(imported, bundled), fallback: d(imported, fallback) }
  })
  expect(exported.bundled).toBeLessThan(0.5)
  expect(exported.fallback).toBeGreaterThan(3)

  // Saved with the project: after a reload the title is still in Arcade.
  await expect(page.getByRole('banner').getByText('Saved', { exact: true })).toBeVisible()
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await waitForPreview(page)
  await expect(font).toHaveText('Arcade')
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 3 }))
  await expect.poll(async () => diff(await previewFrame(page), arcade)).toBeLessThan(1.5)

  // A font the project no longer has stays named but disabled, and the text draws in the font it had before.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const project: Project = editor.getProject()
    const id = Object.values(project.assets).find((a) => a.kind === 'font')!.id
    editor.dispatch({ type: 'asset.remove', assetId: id })
  })
  await expect(font).toHaveText('Arcade')
  await expect.poll(async () => diff(await previewFrame(page), before)).toBeLessThan(1.5)
  await font.click()
  const missing = page.getByRole('group', { name: 'Imported' }).getByRole('option', { name: /^Arcade/ })
  await expect(missing).toHaveAttribute('aria-disabled', 'true')
  await expect(missing).toContainText('Missing: shown in a fallback font')
  await page.getByRole('option', { name: /^Montserrat/ }).click()
  await expect(font).toHaveText('Montserrat')
})
