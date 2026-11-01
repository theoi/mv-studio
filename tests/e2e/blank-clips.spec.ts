import path from 'node:path'
import type { Page } from '@playwright/test'
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

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Replace with… names it too, in place of its length.
  await page
    .getByRole('button', { name: /^clip\.mp4, \d/ })
    .first()
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Replace with…' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette.getByRole('option', { name: /^clear/ })).toContainText('Shows nothing')
  const shown = palette.getByRole('option', { name: /^clip/ })
  await expect(shown).toContainText(/\d:\d\d/)
  await expect(shown).not.toContainText('Shows nothing')
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  // And so does the palette's Add media list.
  await page.keyboard.press('Control+k')
  await palette.getByRole('combobox').fill('add media')
  await palette.getByRole('option', { name: /^Add media at the playhead…/ }).click()
  await expect(palette.getByRole('option', { name: /^clear/ })).toContainText('Shows nothing')
  await expect(palette.getByRole('option', { name: /^clip/ })).not.toContainText('Shows nothing')
  await page.keyboard.press('Escape')
  if (await palette.isVisible()) await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
})

const LEFT_OUT = 'Left out “clear.webm” because every frame of it is black or see-through.'

/** Names of the media a director draft placed, or the Auto-cut track's clips. */
function usedNames(page: Page, by: 'director' | 'autocut') {
  return page.evaluate((by) => {
    const project = window.mvStudio.app.project.editor.getProject()
    const track = project.tracks.find((t: { name: string }) => t.name === 'Auto-cut')
    const clips = Object.values(project.clips) as {
      assetId?: string
      trackId: string
      meta?: { director?: unknown }
    }[]
    const names = clips.flatMap((c) =>
      c.assetId && (by === 'director' ? c.meta?.director : track && c.trackId === track.id)
        ? [project.assets[c.assetId]?.name]
        : [],
    )
    return [...new Set(names)].sort()
  }, by)
}

/** Assist › Auto-cut: More options › Clip order › Story order, then Cut to the beat. */
async function cutInStoryOrder(page: Page) {
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await assist.getByRole('button', { name: 'More options' }).click()
  await assist.getByRole('combobox', { name: 'Clip order' }).click()
  await page.getByRole('option', { name: /Story order/ }).click()
  await assist.getByRole('button', { name: 'Cut to the beat' }).click()
}

/** The AI music video setup with the sample song and these clips, imported one after the other. */
async function setUpAiVideo(page: Page, clipFiles: string[]) {
  await page.getByRole('button', { name: /AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('neon night drive')
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  const clips = page.getByRole('list', { name: 'Your clips' }).getByRole('listitem')
  for (const [i, name] of clipFiles.entries()) {
    await page.getByLabel('Clip files').setInputFiles(fixture(name))
    await expect(clips).toHaveCount(i + 1, { timeout: 30_000 })
  }
}

test('with footage analysis stuck on the first clip, a clip that shows nothing is badged at once and drafts and cuts leave it out', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.background-analysis', 'on')
    // Matching never finishes, so footage analysis stays on the first clip imported for the whole test.
    const onnx = {
      embedImages: ({ bitmaps }: { bitmaps: ImageBitmap[] }) => {
        for (const b of bitmaps) b.close()
        return new Promise(() => undefined)
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
  await setUpAiVideo(page, ['clip1080.mp4', 'clip.mp4', 'clear.webm'])
  await page.getByRole('button', { name: 'Draft my video' }).click()
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(page.getByText(/^Placed \d+ (shots|scenes)/)).toBeVisible({ timeout: 60_000 })
  await expect(assist.getByText(LEFT_OUT)).toBeVisible()
  // The draft's own way to choose again, not auto-cut's.
  await expect(
    assist.getByText(
      'Your clips aren’t analyzed yet, so they were picked for variety. Draft again once analysis finishes.',
    ),
  ).toBeVisible()
  expect(await usedNames(page, 'director')).toEqual(['clip.mp4', 'clip1080.mp4'])

  await expect(
    page.getByRole('button', { name: 'clear, video, shows nothing' }).getByText('Shows nothing'),
  ).toBeVisible()
  // Footage analysis hasn't matched a single clip: the badge comes from the fast check alone.
  const matched = () =>
    page.evaluate(() =>
      Object.values(window.mvStudio.app.project.editor.getProject().analysis.visual).filter(
        (v) => (v as { data: { embedding?: unknown } }).data.embedding,
      ),
    )
  expect(await matched()).toHaveLength(0)

  // Story order walks through every clip in import order, the clip that shows nothing too unless it is left out.
  await assist.getByRole('button', { name: 'All tools' }).click()
  await assist.getByRole('button', { name: /^Auto-cut/ }).click()
  await cutInStoryOrder(page)
  await expect(assist.getByText(LEFT_OUT)).toBeVisible({ timeout: 60_000 })
  expect(await usedNames(page, 'autocut')).toEqual(['clip.mp4', 'clip1080.mp4'])
  expect(await matched()).toHaveLength(0)
})

test('with background analysis off, a draft checks the clips first and leaves out the one that shows nothing', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await setUpAiVideo(page, ['clip.mp4', 'clear.webm'])
  await page.getByRole('button', { name: 'Draft my video' }).click()
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(page.getByText(/^Placed \d+ (shots|scenes)/)).toBeVisible({ timeout: 60_000 })
  await expect(assist.getByText(LEFT_OUT)).toBeVisible()
  expect(await usedNames(page, 'director')).toEqual(['clip.mp4'])
  await expect(
    page.getByRole('button', { name: 'clear, video, shows nothing' }).getByText('Shows nothing'),
  ).toBeVisible()
})

test('with background analysis off, a cut in story order checks the clips first and leaves out the one that shows nothing', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=footage&tab=assist&assist=autocut'
  })
  await waitForPreview(page)
  await page.getByLabel('Import media files').setInputFiles(fixture('clear.webm'))
  await expect(page.getByRole('button', { name: /^clear, video/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'clear, video, shows nothing' })).toHaveCount(0)
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await cutInStoryOrder(page)
  await expect(assist.getByText(LEFT_OUT)).toBeVisible({ timeout: 60_000 })
  const used = await usedNames(page, 'autocut')
  expect(used.length).toBeGreaterThan(0)
  expect(used).not.toContain('clear.webm')
  await expect(
    page.getByRole('button', { name: 'clear, video, shows nothing' }).getByText('Shows nothing'),
  ).toBeVisible()
})
