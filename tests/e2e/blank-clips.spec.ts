import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const fixture = (name: string) => path.join(FIXTURE_DIR, name)

test('a clip that shows nothing is badged, left out of the cut unless ticked in Choose clips, and named before export', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /Beat-cut footage/ }).click()
  // Model-free embeddings: what this tests is the frames footage analysis decodes, which stay real.
  await page.evaluate(() => {
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        for (const b of bitmaps) b.close()
        return { dim: 2, data: new Float32Array(bitmaps.flatMap(() => [0.6, 0.8])) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        return { dim: 2, data: new Float32Array(texts.flatMap(() => [0.6, 0.8])) }
      },
    }
    window.mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
  })
  await page.getByLabel('Song file').setInputFiles(fixture('song.mp3'))
  // One after the other, so the clear clip is analyzed right after a clip of the same size that shows something.
  const clips = page.getByRole('list', { name: 'Your clips' }).getByRole('listitem')
  await page.getByLabel('Clip files').setInputFiles(fixture('clip.mp4'))
  await expect(clips).toHaveCount(1)
  await page.getByLabel('Clip files').setInputFiles(fixture('clear.webm'))
  await expect(clips).toHaveCount(2)
  await page.getByRole('button', { name: 'Cut my clips' }).click()
  await waitForPreview(page)

  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(
    assist.getByText('Left out “clear.webm” because every frame of it is black or see-through.'),
  ).toBeVisible({ timeout: 60_000 })
  const cutNames = () =>
    page.evaluate(() => {
      const p = window.mvStudio.app.project.editor.getProject()
      const names = Object.values(p.clips as Record<string, { type: string; assetId?: string }>)
        .filter((c) => c.type === 'video')
        .map((c) => p.assets[c.assetId!].name)
      return [...new Set(names)]
    })
  expect(await cutNames()).toEqual(['clip.mp4'])

  const tile = page.getByRole('button', { name: 'clear, video, shows nothing' })
  await expect(tile.getByText('Shows nothing')).toBeVisible()
  await expect(page.getByRole('button', { name: /^clip, video/ }).getByText('Shows nothing')).toHaveCount(0)
  // On hover the words make room for the + and the tooltip says them.
  await tile.hover()
  await expect(tile.getByText('Shows nothing')).toBeHidden()
  await expect(page.getByRole('tooltip')).toContainText(
    'Auto-cut and AI drafts leave it out; you can still pick it in Auto-cut.',
  )
  await page.mouse.move(0, 0)

  // Choose clips starts it unticked, with the badge; ticked, the cut uses it and says so.
  await assist.getByRole('button', { name: /^Keep \d+ cuts?$/ }).click()
  await assist.getByRole('combobox', { name: 'Clips to use' }).click()
  await page.getByRole('option', { name: 'Choose clips' }).click()
  const list = assist.getByRole('group', { name: 'Clips to cut' })
  await expect(list.getByRole('checkbox', { name: /^clip\.mp4 / })).toBeChecked()
  const clear = list.getByRole('checkbox', { name: /^clear\.webm Shows nothing/ })
  await expect(clear).not.toBeChecked()
  await expect(list.getByRole('checkbox', { name: 'All clips 1 of 2' })).not.toBeChecked()
  await clear.check()
  await assist.getByRole('button', { name: 'Cut to the beat' }).click()
  await expect(
    assist.getByText(
      'Used “clear.webm” because you chose it, but every frame of it is black or see-through.',
    ),
  ).toBeVisible()
  expect(await cutNames()).toContain('clear.webm')

  await page.keyboard.press('Control+e')
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await expect(
    dialog.getByText(
      /^“clear\.webm” shows nothing: every frame is black or see-through\. It plays (at \d+:\d\d(, \d+:\d\d)?( and \d+:\d\d)?|\d+ times, first at \d+:\d\d)\.$/,
    ),
  ).toBeVisible()
})
