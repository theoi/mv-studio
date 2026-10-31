import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

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

test('a visual from the library plays over the footage for the rest of the section, in the look’s colors', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=visuals&t=73.6'
  })
  await waitForPreview(page)
  const preview = page.getByRole('img', { name: 'Video preview' })
  const library = page.getByRole('tabpanel', { name: 'Visuals' })
  await expect(library.getByRole('button', { name: 'Spectrum bars', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Nebula', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('visuals-tab.png') })
  const before = await preview.screenshot()

  await library.getByRole('button', { name: 'Circle spectrum', exact: true }).click()
  await expect(page.getByText(/^“Circle spectrum” added from 1:13 to \d+:\d\d$/)).toBeVisible()
  const added = await page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = Object.values(project.clips).find(
      (c) => c.type === 'generator' && c.generatorId === 'visualizer.circle',
    )
    const sections = project.analysis.audio[project.songAssetId!]!.sections
    const section = sections!.find((s) => s.start <= 73.6 && s.end > 73.6)!
    return clip?.type === 'generator'
      ? {
          start: clip.start,
          end: clip.start + clip.duration,
          sectionEnd: section.end,
          color: clip.params.color?.value,
          track: project.tracks.find((t) => t.id === clip.trackId)?.name,
          below: project.tracks[project.tracks.findIndex((t) => t.id === clip.trackId) + 1]?.name,
        }
      : null
  })
  expect(added).toMatchObject({ start: 73.6, color: '#22d3ee', track: 'Visuals', below: 'Video' })
  expect(added!.end).toBeCloseTo(added!.sectionEnd, 3)
  // The new clip is selected and the preview shows it.
  await expect(page.getByRole('button', { name: /^Circle spectrum, 1:13\.\d to / })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect.poll(async () => imageDiff(page, before, await preview.screenshot())).toBeGreaterThan(1)
  await page.screenshot({ path: testInfo.outputPath('visuals-added.png') })

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(page.getByRole('button', { name: /^Circle spectrum, 1:13\.\d to / })).toHaveCount(0)
})
