import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEmptyEditor(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
}

async function importFiles(page: Page, files: string[]) {
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press(`${mod}+i`)
  await (await chooser).setFiles(files.map((f) => path.join(FIXTURE_DIR, f)))
}

/** The timeline lane of the track with this name. */
function laneOf(page: Page, track: string) {
  return page
    .locator('[data-timeline-scroller] div[class*="row"]')
    .filter({ has: page.locator('span[class*="trackName"]', { hasText: new RegExp(`^${track}$`) }) })
    .locator('div[class*="lane"]')
    .first()
}

test('a Library media card dragged onto a track lands where it is dropped; a click adds it at the playhead', async ({
  page,
}) => {
  await openEmptyEditor(page)
  await importFiles(page, ['song.mp3', 'clip.mp4'])
  const card = page.getByLabel('clip, video')
  await expect(card).toBeVisible()
  const lane = laneOf(page, 'Video 1')
  const box = (await lane.boundingBox())!
  // The lane spans the song (8 s) plus some room; 120 px is 10 s at the default zoom.
  await card.dragTo(lane, { targetPosition: { x: 120, y: box.height / 2 } })
  const block = lane.getByRole('button', { name: /^clip, \d+:\d+\.\d to \d+:\d+\.\d$/ })
  await expect(block).toHaveCount(1)
  // At the drop point, give or take the snap distance.
  expect(Math.abs((await block.boundingBox())!.x - (box.x + 120))).toBeLessThanOrEqual(10)

  await card.click()
  await expect(page.getByRole('button', { name: 'clip, 0:00.0 to 0:04.0' })).toBeVisible()
})

test('a double-click on a media card adds it once, and the add says where it landed, with Undo', async ({
  page,
}) => {
  await openEmptyEditor(page)
  await importFiles(page, ['song.mp3', 'clip.mp4'])
  const card = page.getByRole('button', { name: 'clip, video' })
  const blocks = page.locator('[data-timeline-scroller] [role="button"][aria-label^="clip, "]')
  await card.dblclick()
  await expect(page.getByText('Added “clip” at 0:00.0. Its sound is off.', { exact: true })).toBeVisible()
  await expect(blocks).toHaveCount(1)
  // A second add would have gone on a new track; give it time to show up if it were coming.
  await page.waitForTimeout(300)
  await expect(blocks).toHaveCount(1)

  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect(blocks).toHaveCount(0)
  // The card's + adds a clip the same way.
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  await expect(blocks).toHaveCount(1)
  await expect(page.getByText('Added “clip” at 0:00.0. Its sound is off.', { exact: true })).toBeVisible()
})
test('a file dropped on a track is imported and lands at the drop point, as one undo step', async ({
  page,
}) => {
  await openEmptyEditor(page)
  await importFiles(page, ['song.mp3'])
  const lane = laneOf(page, 'Video 1')
  await expect(lane).toBeVisible()
  const box = (await lane.boundingBox())!

  const png = readFileSync(path.join(FIXTURE_DIR, 'image.png')).toString('base64')
  await lane.evaluate(
    (el, { b64, x }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      const r = el.getBoundingClientRect()
      const init = {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
        clientX: r.left + x,
        clientY: r.top + 10,
      }
      el.dispatchEvent(new DragEvent('dragover', init))
      el.dispatchEvent(new DragEvent('drop', init))
    },
    { b64: png, x: 160 },
  )
  const block = lane.getByRole('button', { name: /^image, / })
  await expect(block).toHaveCount(1)
  expect(Math.abs((await block.boundingBox())!.x - (box.x + 160))).toBeLessThanOrEqual(10)
  await expect(page.getByText(/^Added “image” at \d+:\d\d\.\d$/)).toBeVisible()
  // Imported once: the editor-wide drop did not import it again.
  await expect(page.getByLabel('image, image')).toHaveCount(1)

  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press(`${mod}+z`)
  await expect(block).toHaveCount(0)
  await expect(page.getByLabel('image, image')).toHaveCount(0)
})

/** Presses Tab until `target` has focus, the way a keyboard user reaches it. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error('Tab never reached the target')
}

test('a media card is one Tab stop; Space adds it only when it was reached with the keyboard, Enter always', async ({
  page,
}) => {
  await openEmptyEditor(page)
  await importFiles(page, ['song.mp3', 'clip.mp4'])
  const card = page.getByRole('button', { name: 'clip, video' })
  await expect(card).toHaveAttribute('aria-description', 'Adds it at the playhead')
  await expect(card.locator('button[aria-label="Add at playhead"]')).toHaveAttribute('tabindex', '-1')
  const blocks = page.locator('[data-timeline-scroller] [role="button"][aria-label^="clip, "]')
  const play = page.getByRole('button', { name: 'Play', exact: true })
  const pause = page.getByRole('button', { name: 'Pause', exact: true })

  // After a click on the card (which adds it), Space plays and pauses and adds nothing.
  await card.click()
  await expect(blocks).toHaveCount(1)
  await page.keyboard.press('Space')
  await expect(pause).toBeVisible()
  await page.keyboard.press('Space')
  await expect(play).toBeVisible()
  await expect(blocks).toHaveCount(1)

  // Reached with Tab, Space adds it without playing; Enter adds it too.
  await page.getByRole('textbox', { name: 'Search media by content' }).click()
  await tabTo(page, card)
  await page.keyboard.press('Space')
  await expect(blocks).toHaveCount(2)
  await expect(play).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(blocks).toHaveCount(3)
  await expect(play).toBeVisible()
})

test('a card dragged onto a shot goes in at the nearer cut by insert, on its own track rather than a new one', async ({
  page,
}) => {
  await openEmptyEditor(page)
  await importFiles(page, ['song.mp3', 'clip.mp4'])
  const card = page.getByRole('button', { name: 'clip, video' })
  await card.click()
  const lane = laneOf(page, 'Video 1')
  await expect(lane.getByRole('button', { name: /^clip, / })).toHaveCount(1)
  const box = (await lane.boundingBox())!

  // The clip already fills 0 to 4 s on Video 1; near its start, the card goes in before it.
  await card.hover()
  await page.mouse.down()
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 4 })
  await page.mouse.move(box.x + 24, box.y + box.height / 2, { steps: 2 })
  await expect(
    lane.getByText(/^Insert at 0:00\.0 · later clips move 4\.0 s · Hold (Alt|⌥) to replace$/),
  ).toBeVisible()
  await page.mouse.up()
  await expect(lane.getByRole('button', { name: /^clip, 0:00\.0 to 0:04\.0/ })).toHaveCount(1)
  await expect(lane.getByRole('button', { name: /^clip, 0:04\.0 to 0:08\.0/ })).toHaveCount(1)
  await expect(laneOf(page, 'Video 2')).toHaveCount(0)
})

test('a dropped media card snaps like a moved clip: to beats and section ends with snapping on, to the cursor with snapping off or without a beat grid', async ({
  page,
}) => {
  await openEmptyEditor(page)
  // A known song map in place of the analysis: beats every 0.5 s from 0.25 s, and a verse that ends at 5.5 s, between
  // two beats. No background refinement replaces it.
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.background-analysis', 'off')
    window.mvStudio.app.songAnalysis.setSongAnalysisServiceForTests({
      analyze: (assetId: string) => ({
        promise: Promise.resolve({
          assetId,
          version: 'e2e',
          tempo: { bpm: 120, confidence: 1 },
          beats: Array.from({ length: 16 }, (_, i) => 0.25 + i * 0.5),
          sections: [{ id: 's-verse', label: 'verse', start: 0, end: 5.5 }],
        }),
      }),
    } as never)
  })
  await importFiles(page, ['song.mp3', 'clip.mp4'])
  await expect
    .poll(() =>
      page.evaluate(() => {
        const p = window.mvStudio.app.project.editor.getProject()
        return p.analysis.audio[p.songAssetId]?.beats?.length ?? 0
      }),
    )
    .toBe(16)
  const card = page.getByLabel('clip, video')
  await expect(card).toBeVisible()
  // Wide enough that the snap distance (8 px) reaches the section end but not the beat 0.25 s past it.
  await page.evaluate(() => window.mvStudio.app.ui.set({ pxPerSec: 40 }))
  const lane = laneOf(page, 'Video 1')
  const box = (await lane.boundingBox())!
  const dropAt = async (t: number) => {
    await card.dragTo(lane, { targetPosition: { x: t * 40, y: box.height / 2 } })
    await expect(lane.getByRole('button', { name: /^clip, / })).toHaveCount(1)
    const start: number = await page.evaluate(
      () =>
        (
          Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
            type: string
            start: number
          }[]
        ).find((c) => c.type === 'video')!.start,
    )
    await page.locator('body').click({ position: { x: 1, y: 1 } })
    await page.keyboard.press(`${mod}+z`)
    await expect(lane.getByRole('button', { name: /^clip, / })).toHaveCount(0)
    return start
  }

  // 6 px past the beat at 3.25 s.
  expect(await dropAt(3.4)).toBeCloseTo(3.25, 3)
  // 4 px past the verse's end, which is nearer than the next beat (5.75 s).
  expect(await dropAt(5.6)).toBeCloseTo(5.5, 3)

  await page.keyboard.press('n')
  await expect(page.getByText('Snapping off')).toBeVisible()
  expect(await dropAt(3.4)).toBeCloseTo(3.4, 1)
  await page.keyboard.press('n')
  await expect(page.getByText('Snapping on')).toBeVisible()

  // Without a tempo or beats there is no grid to snap to.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: editor.getProject().songAssetId,
        grid: { tempo: undefined, beats: undefined, downbeats: undefined },
      },
      { history: 'skip' },
    )
  })
  expect(await dropAt(3.4)).toBeCloseTo(3.4, 1)
})
