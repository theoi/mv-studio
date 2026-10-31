import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

async function openAt(page: Page, t: number) {
  await openHarness(page)
  await page.evaluate((t) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = `#/editor?t=${t}`
  }, t)
  await waitForPreview(page)
}

/** Two back-to-back clips on one of the sample's tracks with no transition between them, the cut nearest `t`. */
async function cutNear(page: Page, trackName: string, t: number) {
  return page.evaluate(
    ([trackName, t]) => {
      const p = window.mvStudio.app.project.editor.getProject()
      const track = (p.tracks as Untyped[]).find((tr) => tr.name === trackName)
      const clips = (Object.values(p.clips) as Untyped[])
        .filter((c) => c.trackId === track.id)
        .sort((a, b) => a.start - b.start)
      const name = (c: Untyped) => c.name ?? p.assets[c.assetId]?.name
      let best: { a: Untyped; b: Untyped } | undefined
      for (let i = 1; i < clips.length; i++) {
        const [a, b] = [clips[i - 1], clips[i]]
        if (Math.abs(a.start + a.duration - b.start) > 1e-3 || b.transitionIn) continue
        if (!best || Math.abs(b.start - t) < Math.abs(best.b.start - t)) best = { a, b }
      }
      if (!best) throw new Error(`no cut on the ${trackName} track`)
      return { from: name(best.a) as string, to: name(best.b) as string, toId: best.b.id as string }
    },
    [trackName, t] as const,
  )
}

const transitionIn = (page: Page, clipId: string) =>
  page.evaluate(
    (id) => window.mvStudio.app.project.editor.getProject().clips[id].transitionIn ?? null,
    clipId,
  )

const clipName = (page: Page, clipId: string) =>
  page.evaluate((id) => {
    const p = window.mvStudio.app.project.editor.getProject()
    const c = p.clips[id]
    return (c.name ?? p.assets[c.assetId]?.name) as string
  }, clipId)

const clipStart = (page: Page, clipId: string) =>
  page.evaluate((id) => window.mvStudio.app.project.editor.getProject().clips[id].start as number, clipId)

/** Adds the default transition at the cut before `clip` from the clip's menu. */
async function addAtCut(page: Page, clip: Locator) {
  const box = (await clip.boundingBox())!
  await page.mouse.click(box.x + 8, box.y + box.height / 2, { button: 'right' })
  const add = page.getByRole('menuitem', { name: /^Add transition/ })
  await expect(add).toContainText(/At the cut at \d+:\d\d/)
  await add.click()
}

/** Drags a clip's left edge at mid height by `dx` px. */
async function trimStart(page: Page, clip: Locator, dx: number) {
  const box = (await clip.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 2 + dx, y, { steps: 8 })
  await page.mouse.up()
}

const cutOff = (l: Locator) => l.evaluate((el) => el.scrollWidth > el.clientWidth)

test('a cut gets a transition from the clip menu, and Inspector › Transition changes its type, duration and easing, and removes it', async ({
  page,
}, testInfo) => {
  await openAt(page, 67)
  const cut = await cutNear(page, 'Video', 67)
  const clip = page.locator(`[data-clip-id="${cut.toId}"]`)
  await addAtCut(page, clip)

  const mark = page.getByRole('button', { name: /^Transition: Fade, / })
  await expect(mark).toBeVisible()
  await expect(mark).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/^“Fade” added to the cut at /)).toBeVisible()
  const added = await transitionIn(page, cut.toId)
  expect(added).toMatchObject({ kind: 'fade', easing: 'ease-in-out' })

  // The header names both clips, each on its own line, and neither is cut off; nor is the easing.
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const fromLine = inspector.getByText(`From “${cut.from}”`, { exact: true })
  const intoLine = inspector.getByText(`Into “${cut.to}”`, { exact: true })
  const easing = inspector.getByRole('combobox', { name: 'Transition easing' })
  const easingValue = easing.locator('span').first()
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(size)
    await expect(fromLine).toBeVisible()
    await expect(intoLine).toBeVisible()
    await expect(easingValue).toHaveText('Ease in and out')
    for (const l of [fromLine, intoLine, easingValue]) expect(await cutOff(l)).toBe(false)
    await page.screenshot({ path: testInfo.outputPath(`transition-inspector-${size.width}.png`) })
  }

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
  await easing.click()
  await page.getByRole('option', { name: 'Linear' }).click()
  expect(await transitionIn(page, cut.toId)).toMatchObject({ easing: 'linear' })

  // Removing it selects the clip after the cut and focuses it on the timeline, as the button that had focus is gone.
  await inspector.getByRole('button', { name: 'Remove transition' }).click()
  await expect(page.getByRole('button', { name: /^Transition: / })).toHaveCount(0)
  expect(await transitionIn(page, cut.toId)).toBeNull()
  await expect(page.getByText(`“Wipe” removed from “${cut.to}”`)).toBeVisible()
  await expect(fromLine).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => decodeURIComponent(location.hash)))
    .toContain(`sel=clip:${cut.toId}`)
  await expect(clip).toBeFocused()

  // Undo brings it back with its last duration, and clicking its mark selects it again.
  await page.keyboard.press('Control+z')
  const back = page.getByRole('button', { name: /^Transition: Wipe, / })
  await expect(back).toBeVisible()
  await back.click()
  await expect(fromLine).toBeVisible()
  await expect(
    inspector.getByText(`${Number((added.duration + 0.1).toFixed(2))} s`, { exact: true }),
  ).toBeVisible()
})

test('a transition mark sits on its clip’s top edge: the clip still trims and takes clicks, the mark has a tooltip, and Delete removes it', async ({
  page,
}, testInfo) => {
  await openAt(page, 67)
  // At the default zoom the 2 s clip after this cut is about as wide as the mark.
  const cut = await cutNear(page, 'Video', 67)
  const clip = page.locator(`[data-clip-id="${cut.toId}"]`)
  await addAtCut(page, clip)
  const mark = page.getByRole('button', { name: /^Transition: Fade, / })
  await expect(mark).toBeVisible()
  const { duration } = await transitionIn(page, cut.toId)

  // The mark straddles the clip's top edge, clear of the clip's middle.
  const [box, markBox] = [(await clip.boundingBox())!, (await mark.boundingBox())!]
  expect(markBox.y).toBeLessThan(box.y)
  expect(markBox.y + markBox.height).toBeLessThan(box.y + box.height / 2)
  await page.screenshot({ path: testInfo.outputPath('transition-mark.png') })

  await mark.hover()
  await expect(page.getByRole('tooltip')).toHaveText(`Fade · ${Number(duration.toFixed(2))} s`)

  // A click and a right-click under the mark are the clip's.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7)
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
  await expect(mark).toHaveAttribute('aria-pressed', 'false')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7, { button: 'right' })
  await expect(page.getByRole('menuitem', { name: /^Copy/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^Remove transition/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // The closed menu hands focus back to the clip from a timer: a Tab sent before it lands would be undone.
  await expect(clip).toBeFocused()

  // In Tab order the mark comes right after its clip, and then the next clip on the track.
  const nextId = await page.evaluate((id) => {
    const p = window.mvStudio.app.project.editor.getProject()
    const c = p.clips[id]
    return (Object.values(p.clips) as Untyped[])
      .filter((x) => x.trackId === c.trackId && x.start > c.start)
      .sort((a, b) => a.start - b.start)[0].id as string
  }, cut.toId)
  await clip.focus()
  await page.keyboard.press('Tab')
  await expect(mark).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator(`[data-clip-id="${nextId}"]`)).toBeFocused()

  // The clip's left edge trims at mid height, under the mark's end.
  const before = await clipStart(page, cut.toId)
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  await trimStart(page, clip, pps)
  expect(await clipStart(page, cut.toId)).toBeGreaterThan(before + 0.4)
  await page.keyboard.press('Control+z')
  expect(await clipStart(page, cut.toId)).toBeCloseTo(before, 5)

  // Delete removes the selected transition as one undo step and hands focus to its clip.
  await mark.click()
  await expect(mark).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Delete')
  await expect(mark).toHaveCount(0)
  expect(await transitionIn(page, cut.toId)).toBeNull()
  await expect(page.getByText(`“Fade” removed from “${cut.to}”`)).toBeVisible()
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe(
    'Remove transition: Fade',
  )
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
  await expect(clip).toBeFocused()
  await page.keyboard.press('Control+z')
  await expect(mark).toBeVisible()

  // So does the mark's menu.
  await mark.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Remove transition/ }).click()
  await expect(mark).toHaveCount(0)
  await expect(clip).toBeFocused()
})

test('at 80 px a second, an Overlay clip with a transition into it still trims from its left edge, and the mark clears a keyframe at its first frame', async ({
  page,
}) => {
  await openAt(page, 160)
  const cut = await cutNear(page, 'Overlay', 160)
  const pps = 80
  const time = await clipStart(page, cut.toId)
  await page.evaluate(
    ([pps, time]) => {
      window.mvStudio.app.ui.set({ pxPerSec: pps })
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-timeline-scroller]')!.scrollLeft = time * pps - 300
      })
    },
    [pps, time] as const,
  )
  const clip = page.locator(`[data-clip-id="${cut.toId}"]`)
  await expect(clip).toBeInViewport()
  await addAtCut(page, clip)
  await expect(page.getByRole('button', { name: /^Transition: / })).toBeVisible()
  await trimStart(page, clip, pps / 2)
  expect(await clipStart(page, cut.toId)).toBeGreaterThan(time + 0.2)
  expect(await transitionIn(page, cut.toId)).not.toBeNull()

  // A keyframe at the clip's first frame: its mark on the clip's bottom edge and the transition's on the top edge
  // stay apart on this short track.
  const start = await clipStart(page, cut.toId)
  await page.evaluate((t) => window.mvStudio.app.ui.set({ playhead: t }), start)
  await page
    .getByRole('tabpanel', { name: 'Inspector' })
    .getByRole('button', { name: /^Add keyframe: / })
    .first()
    .click()
  const key = page.getByRole('button', { name: /^Keyframe at / })
  await expect(key).toHaveCount(1)
  const [a, b] = [
    (await page.getByRole('button', { name: /^Transition: / }).boundingBox())!,
    (await key.boundingBox())!,
  ]
  expect(a.x < b.x + b.width && b.x < a.x + a.width).toBe(true)
  expect(a.y + a.height).toBeLessThanOrEqual(b.y)
})

test('at the lowest zoom no two transition marks overlap: one that would is left out until zooming in, and its clip’s menu selects it', async ({
  page,
}, testInfo) => {
  await openAt(page, 67)
  const cut = await cutNear(page, 'Video', 67)
  await addAtCut(page, page.locator(`[data-clip-id="${cut.toId}"]`))
  // The same fade on every other cut of the Video and Overlay tracks, as one step.
  const { total, start, next } = await page.evaluate((id) => {
    const editor = window.mvStudio.app.project.editor
    const p = editor.getProject()
    const fade = p.clips[id].transitionIn
    const commands: object[] = []
    for (const name of ['Video', 'Overlay']) {
      const track = (p.tracks as Untyped[]).find((t) => t.name === name)
      const clips = (Object.values(p.clips) as Untyped[])
        .filter((c) => c.trackId === track.id)
        .sort((a, b) => a.start - b.start)
      for (let i = 1; i < clips.length; i++) {
        const [a, b] = [clips[i - 1], clips[i]]
        if (Math.abs(a.start + a.duration - b.start) > 1e-3 || b.transitionIn) continue
        const value = { ...fade, duration: Math.min(fade.duration, b.duration / 2) }
        commands.push({ type: 'clip.set', clipId: b.id, path: ['transitionIn'], value })
      }
    }
    editor.dispatch(commands)
    const c = p.clips[id]
    const after = (Object.values(p.clips) as Untyped[]).find(
      (x) => x.trackId === c.trackId && Math.abs(x.start - c.start - c.duration) < 1e-3,
    )
    return {
      total: commands.length + 1,
      start: c.start as number,
      next: { id: after.id as string, start: after.start as number },
    }
  }, cut.toId)

  await page.getByRole('slider', { name: 'Timeline zoom' }).focus()
  await page.keyboard.press('Home')
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)).toBe(3)
  const marks = page.getByRole('button', { name: /^Transition: / })
  await expect(marks.first()).toBeVisible()
  const noOverlap = async () => {
    const boxes = (await Promise.all((await marks.all()).map((m) => m.boundingBox()))).filter(
      (b) => b !== null,
    )
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1)) {
        const apart =
          a.x + a.width <= b.x + 0.5 ||
          b.x + b.width <= a.x + 0.5 ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
        expect(apart, JSON.stringify([a, b])).toBe(true)
      }
    return boxes.length
  }
  const shown = await noOverlap()
  expect(shown).toBeGreaterThan(1)
  expect(shown).toBeLessThan(total)
  await page.screenshot({ path: testInfo.outputPath('transition-marks-lowest-zoom.png') })

  // The 2 s clip's transition is left out beside the one at the cut before it.
  const time = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
  const firstMark = page.getByRole('button', { name: `Transition: Fade, ${time(start)}` })
  const nextMark = page.getByRole('button', { name: `Transition: Fade, ${time(next.start)}` })
  await expect(firstMark).toBeVisible()
  await expect(nextMark).toHaveCount(0)

  // Its clip's menu selects it, and its mark shows in place of its neighbor's.
  const box = (await page.locator(`[data-clip-id="${next.id}"]`).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7, { button: 'right' })
  await page
    .getByRole('menuitem', { name: /^Edit transition/ })
    .filter({ hasText: `Fade at ${time(next.start)}` })
    .click()
  await expect(nextMark).toHaveAttribute('aria-pressed', 'true')
  await expect(firstMark).toHaveCount(0)
  await expect(
    page.getByRole('tabpanel', { name: 'Inspector' }).getByText(`Into “${await clipName(page, next.id)}”`),
  ).toBeVisible()
  await noOverlap()

  // Zoomed in, both show.
  await page.evaluate(
    ([pps, t]) => {
      window.mvStudio.app.ui.set({ pxPerSec: pps })
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-timeline-scroller]')!.scrollLeft = t * pps - 300
      })
    },
    [24, start] as const,
  )
  await expect(firstMark).toBeVisible()
  await expect(nextMark).toBeVisible()
  await noOverlap()
})
