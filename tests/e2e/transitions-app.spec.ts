import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Two back-to-back clips on the sample's Video track with no transition between them, the cut nearest 67 s. */
async function cutNear67(page: Page) {
  return page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    const video = (p.tracks as Untyped[]).find((t) => t.name === 'Video')
    const clips = (Object.values(p.clips) as Untyped[])
      .filter((c) => c.trackId === video.id)
      .sort((a, b) => a.start - b.start)
    const name = (c: Untyped) => c.name ?? p.assets[c.assetId]?.name
    let best: { a: Untyped; b: Untyped } | undefined
    for (let i = 1; i < clips.length; i++) {
      const [a, b] = [clips[i - 1], clips[i]]
      if (Math.abs(a.start + a.duration - b.start) > 1e-3 || b.transitionIn) continue
      if (!best || Math.abs(b.start - 67) < Math.abs(best.b.start - 67)) best = { a, b }
    }
    if (!best) throw new Error('no cut on the Video track')
    return { from: name(best.a) as string, to: name(best.b) as string, toId: best.b.id as string }
  })
}

const transitionIn = (page: Page, clipId: string) =>
  page.evaluate(
    (id) => window.mvStudio.app.project.editor.getProject().clips[id].transitionIn ?? null,
    clipId,
  )

test('a cut gets a transition from the clip menu, and Inspector › Transition changes its type, duration and easing, and removes it', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=67'
  })
  await waitForPreview(page)
  const cut = await cutNear67(page)

  // The clip after the cut sits right where the clip before it ends.
  const before = page.getByRole('button', { name: new RegExp(`^${escapeRe(cut.from)}, `) })
  const after = page.getByRole('button', { name: new RegExp(`^${escapeRe(cut.to)}, `) })
  const boxes = async (l: typeof before) =>
    (await Promise.all((await l.all()).map((e) => e.boundingBox()))).filter((b) => b !== null)
  const [left, right] = [await boxes(before), await boxes(after)]
  const target = right.find((r) => left.some((l) => Math.abs(l.x + l.width - r.x) < 2))
  expect(target).toBeTruthy()

  await page.mouse.click(target!.x + 8, target!.y + target!.height / 2, { button: 'right' })
  const add = page.getByRole('menuitem', { name: /^Add transition/ })
  await expect(add).toContainText(/At the cut at \d+:\d\d/)
  await add.click()

  const mark = page.getByRole('button', { name: /^Transition: Fade, / })
  await expect(mark).toBeVisible()
  await expect(mark).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/^“Fade” added to the cut at /)).toBeVisible()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText(`Between “${cut.from}” and “${cut.to}”`)).toBeVisible()
  const added = await transitionIn(page, cut.toId)
  expect(added).toMatchObject({ kind: 'fade', easing: 'ease-in-out' })
  await page.screenshot({ path: testInfo.outputPath('transition-inspector.png') })

  // Another type keeps the duration and easing.
  await inspector.getByRole('combobox', { name: 'Transition type' }).click()
  await page.getByRole('option', { name: 'Wipe', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Transition: Wipe, / })).toBeVisible()
  expect(await transitionIn(page, cut.toId)).toMatchObject({ kind: 'wipe', duration: added.duration })

  // Two steps of the duration slider are one undo step.
  await inspector.getByRole('slider', { name: 'Transition duration' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => (await transitionIn(page, cut.toId)).duration)
    .toBeCloseTo(added.duration + 0.1, 5)
  await inspector.getByRole('combobox', { name: 'Transition easing' }).click()
  await page.getByRole('option', { name: 'Linear' }).click()
  expect(await transitionIn(page, cut.toId)).toMatchObject({ easing: 'linear' })

  await inspector.getByRole('button', { name: 'Remove transition' }).click()
  await expect(page.getByRole('button', { name: /^Transition: / })).toHaveCount(0)
  expect(await transitionIn(page, cut.toId)).toBeNull()
  // The clip after the cut takes the selection.
  await expect(inspector.getByText(`Between “${cut.from}” and “${cut.to}”`)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => decodeURIComponent(location.hash)))
    .toContain(`sel=clip:${cut.toId}`)

  // Undo brings it back with its last duration, and clicking its mark selects it again.
  await page.keyboard.press('Control+z')
  const back = page.getByRole('button', { name: /^Transition: Wipe, / })
  await expect(back).toBeVisible()
  await back.click()
  await expect(inspector.getByText(`Between “${cut.from}” and “${cut.to}”`)).toBeVisible()
  await expect(
    inspector.getByText(`${Number((added.duration + 0.1).toFixed(2))} s`, { exact: true }),
  ).toBeVisible()
})
