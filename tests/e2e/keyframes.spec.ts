import type { Locator, Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** Rotation keyframes of the sample's title, as [time, easing]. */
function rotationKeys(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips['o-title']
    if (!clip || clip.type === 'audio') return null
    return (clip.transform.rotation.keyframes ?? []).map((k) => [Math.round(k.time * 100) / 100, k.easing])
  })
}

/** Each keyframe mark's diamond (its center, px) and count (its left and right edges), as drawn. */
function diamonds(marks: Locator) {
  return marks.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect()
      const count = el.querySelector('span')?.getBoundingClientRect()
      return {
        x: box.left + parseFloat(getComputedStyle(el).getPropertyValue('--diamond-x')),
        count: count ? [count.left, count.right] : null,
      }
    }),
  )
}

const at = (page: Page, t: number) =>
  page.evaluate((t) => {
    window.location.hash = `#/editor?sel=clip:o-title&t=${t}`
  }, t)

test('keyframes: the diamond adds and removes, and the timeline marks set easing and remove', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  // The title starts at 1 s, so keyframes at 3 s and 6 s are at 2 s and 5 s of the clip.
  const marks = page.getByRole('button', { name: /^Keyframe at / })
  await expect(marks).toHaveCount(0)

  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  expect(await rotationKeys(page)).toEqual([[2, 'ease-in-out']])
  await expect(marks).toHaveCount(1)
  // On the keyframe, the diamond removes it.
  await page.getByRole('button', { name: 'Remove keyframe: Rotation' }).click()
  expect(await rotationKeys(page)).toEqual([])
  await expect(marks).toHaveCount(0)
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()

  await at(page, 6)
  await expect(page.getByRole('button', { name: 'Add keyframe: Rotation' })).toBeVisible()
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  expect(await rotationKeys(page)).toEqual([
    [2, 'ease-in-out'],
    [5, 'ease-in-out'],
  ])
  await expect(marks).toHaveCount(2)

  await marks.first().click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('keyframe-menu.png') })
  await page.getByRole('menuitemcheckbox', { name: 'Hold' }).click()
  expect(await rotationKeys(page)).toEqual([
    [2, 'hold'],
    [5, 'ease-in-out'],
  ])
  await expect(page.getByRole('menuitemcheckbox', { name: 'Hold' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitem', { name: 'Remove keyframe' }).click()
  expect(await rotationKeys(page)).toEqual([[5, 'ease-in-out']])
  await expect(marks).toHaveCount(1)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect
    .poll(() => rotationKeys(page))
    .toEqual([
      [2, 'hold'],
      [5, 'ease-in-out'],
    ])
})

test('keyframe marks sit on the clip’s bottom edge and are one Tab stop: arrows move, Enter opens, focus stays after Remove', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  for (const t of [3, 6, 8]) {
    await at(page, t)
    await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  }
  const marks = page.getByRole('button', { name: /^Keyframe at / })
  await expect(marks).toHaveCount(3)
  const clip = page.getByRole('button', { name: 'Title, 0:01.0 to 0:09.0', exact: true })
  const clipBox = (await clip.boundingBox())!
  const markBox = (await marks.first().boundingBox())!
  expect(Math.abs(markBox.y + markBox.height / 2 - (clipBox.y + clipBox.height))).toBeLessThan(2)
  await expect(marks.nth(0)).toHaveAttribute('tabindex', '0')
  await expect(marks.nth(1)).toHaveAttribute('tabindex', '-1')

  // Arrows move between the marks, not the playhead (still at 0:08).
  await marks.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(marks.nth(1)).toBeFocused()
  await expect(page.getByText(/^00:08\.00/)).toBeVisible()
  // Enter moves the playhead to the mark and opens its menu.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByText(/^00:06\.00/)).toBeVisible()
  await page.getByRole('menuitem', { name: 'Remove keyframe' }).click()
  await expect(marks).toHaveCount(2)
  await expect(page.getByRole('button', { name: /^Keyframe at 0:08/ })).toBeFocused()

  // The last keyframe has nothing to ease toward.
  await page.keyboard.press('Enter')
  await expect(page.getByText('No next keyframe')).toBeVisible()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Linear' })).toHaveAttribute('data-disabled', '')
  await page.getByRole('menuitem', { name: 'Remove keyframe' }).click()
  await expect(page.getByRole('button', { name: /^Keyframe at 0:03/ })).toBeFocused()

  // Delete removes the focused keyframe, not the clip; with none left, focus goes to the clip.
  await page.keyboard.press('Delete')
  await expect(marks).toHaveCount(0)
  await expect(clip).toBeFocused()
  expect(await rotationKeys(page)).toEqual([])
})

test('a lone keyframe mark is 24 px wide, and a click beside a diamond opens that mark, not a close neighbor', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  const marks = page.getByRole('button', { name: /^Keyframe at / })
  await expect(marks).toHaveCount(1)
  const lone = (await marks.first().boundingBox())!
  expect([lone.width, lone.height]).toEqual([24, 16])

  const clip = (await page
    .getByRole('button', { name: 'Title, 0:01.0 to 0:09.0', exact: true })
    .boundingBox())!
  // The title runs 8 s, from 1 s.
  const pps = clip.width / 8
  // A second keyframe 16 px later: far enough for its own mark, close enough that the two marks' 24 px targets meet.
  await at(page, 3 + 16 / pps)
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  await expect(marks).toHaveCount(2)
  const first = clip.x + 2 * pps
  await page.mouse.click(first + 3, clip.y + clip.height)
  await expect(page.getByRole('menu')).toBeVisible()
  // The open menu hides the rest of the page from role queries.
  const expanded = page.locator('button[aria-label^="Keyframe at "]')
  await expect(expanded.nth(0)).toHaveAttribute('aria-expanded', 'true')
  await expect(expanded.nth(1)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText(/^00:03\.00/)).toBeVisible()
})

test('a VJ take’s strobe keys share one mark with their count, which removes them all at once', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  // A take that holds the Strobe pad from 10 s to 14 s: its clip's opacity flashes on the beat grid, many keys a
  // second, as recorded in VJ mode.
  const clipId: string = await page.evaluate(() => {
    const { vj, app, engine } = window.mvStudio
    const editor = app.project.editor
    const project = editor.getProject()
    const catalog = engine.pluginRegistry.catalog()
    const strobe = vj
      .layoutPads(vj.defaultLayout(project, catalog))
      .find((p: { label: string }) => p.label === 'Strobe')
    const take = {
      id: 'e2e-take',
      start: 10,
      end: 15,
      pads: { [strobe.id]: strobe },
      events: [
        { t: 10, type: 'press', pad: strobe.id, velocity: 1 },
        { t: 14, type: 'release', pad: strobe.id },
      ],
      amounts: {},
      cursors: {},
    }
    editor.dispatch(vj.takeToCommands(project, take, { catalog, grid: vj.beatGridOf(project) }).commands, {
      label: 'VJ take',
    })
    const after: Project = editor.getProject()
    return Object.values(after.clips).find((c) => vj.laneOfClip(c) === `fx:${strobe.id}`)?.id ?? ''
  })
  const keyCount = () =>
    page.evaluate((id) => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      const clip = project.clips[id]
      return clip && clip.type !== 'audio' ? (clip.opacity.keyframes ?? []).length : -1
    }, clipId)
  const keys = await keyCount()
  expect(keys).toBeGreaterThan(8)
  await page.evaluate((id) => {
    window.location.hash = `#/editor?sel=clip:${id}&t=10`
  }, clipId)

  const marks = page.locator('button[aria-label^="Keyframe at "], button[aria-label*=" keyframes, "]')
  await expect(marks).toHaveCount(1)
  const group = page.getByRole('button', { name: new RegExp(`^${keys} keyframes, 0:10\\.0 to 0:13\\.9`) })
  await expect(group).toBeVisible()
  await expect(group).toHaveText(String(keys))
  // The mark sits at the take's first key, with a line along the clip to its last, so the run's length shows.
  const take = await page.evaluate((id) => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips[id]!
    const times = clip.type === 'audio' ? [] : (clip.opacity.keyframes ?? []).map((k) => k.time)
    return { duration: clip.duration, first: Math.min(...times), last: Math.max(...times) }
  }, clipId)
  const box = (await page.locator(`[data-clip-id="${clipId}"]`).boundingBox())!
  const drawnAt = (t: number) => box.x + Math.min(box.width - 8, Math.max(8, (t * box.width) / take.duration))
  const run = page.locator('[class*="keyframeRun"]')
  await expect(run).toHaveCount(1)
  const runBox = (await run.boundingBox())!
  expect(Math.abs(runBox.x - drawnAt(take.first))).toBeLessThan(2)
  expect(Math.abs(runBox.x + runBox.width - drawnAt(take.last))).toBeLessThan(2)
  expect(Math.abs((await diamonds(marks))[0]!.x - drawnAt(take.first))).toBeLessThan(2)

  // A click moves the playhead to the first key, where the diamond is.
  await group.click()
  await expect(page.getByText(/^00:10\.00/)).toBeVisible()
  await page.getByRole('menuitem', { name: `Remove ${keys} keyframes` }).click()
  await expect(
    page.getByRole('status').getByText(new RegExp(`^${keys} keyframes removed, 0:10\\.0 to 0:13\\.9`)),
  ).toBeVisible()
  expect(await keyCount()).toBe(0)
  await expect(marks).toHaveCount(0)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(keyCount).toBe(keys)
  await expect(marks).toHaveCount(1)
})

test('keyframes close together share one mark until zooming in splits them, and fitting the song groups them again', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  for (const t of [3, 3.3, 3.6]) {
    await at(page, t)
    await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  }
  const marks = page.locator('button[aria-label^="Keyframe at "], button[aria-label*=" keyframes, "]')
  const group = page.getByRole('button', { name: /^3 keyframes, 0:03\.0 to 0:03\.6/ })
  await expect(group).toHaveText('3')
  await expect(marks).toHaveCount(1)

  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.evaluate(() => window.mvStudio.app.ui.selectClips(['o-title']))
  for (let i = 0; i < 16 && (await marks.count()) < 3; i++) await page.keyboard.press('ControlOrMeta+=')
  await expect(page.getByRole('button', { name: /^Keyframe at / })).toHaveCount(3)
  await page.keyboard.press('Shift+Z')
  await expect(group).toBeVisible()
  await expect(marks).toHaveCount(1)
})

test('on a long take zoomed in, only the marks near the view are drawn, and End, Home and scrolling still reach every one', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  // A 200 s clip keyed every 0.25 s, like a long VJ strobe take.
  await page.evaluate(() => {
    const { app, model } = window.mvStudio
    const track = model.createTrack('visual', 'Take')
    const clip = model.createSolidClip({ trackId: track.id, color: '#101010', start: 0, duration: 200 })
    clip.opacity = {
      value: 1,
      keyframes: Array.from({ length: 800 }, (_, i) => ({ time: i * 0.25, value: i % 2, easing: 'hold' })),
    }
    app.project.editor.dispatch([
      { type: 'track.add', track, index: 0 },
      { type: 'clip.add', clip },
    ])
    app.ui.set({ playhead: 100 })
    app.ui.selectClips([clip.id])
  })
  const marks = page.locator('button[aria-label^="Keyframe at "], button[aria-label*=" keyframes, "]')
  const groups = page.locator('button[aria-label*=" keyframes, "]')
  await expect(marks.first()).toBeVisible()
  for (let i = 0; i < 16 && (await groups.count()) > 0; i++) await page.keyboard.press('ControlOrMeta+=')
  await expect(groups).toHaveCount(0)

  // Every key has its own mark now, but only those around the view are in the page.
  const drawn = await marks.count()
  expect(drawn).toBeGreaterThan(10)
  expect(drawn).toBeLessThan(200)
  const scroller = page.locator('[data-timeline-scroller]')
  const covered = async () => {
    const view = (await scroller.boundingBox())!
    const xs = await marks.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left))
    // The track headers cover the scroller's first 148 px.
    return Math.min(...xs) <= view.x + 148 + 24 && Math.max(...xs) >= view.x + view.width - 24
  }
  expect(await covered()).toBe(true)

  // End and Home reach the last and first keys, wherever the view is.
  const tabStop = page.locator('button[aria-label^="Keyframe at "][tabindex="0"]')
  await tabStop.focus()
  await page.keyboard.press('End')
  await expect(page.getByRole('button', { name: 'Keyframe at 3:19.7', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Keyframe at 3:19.7', exact: true })).toBeInViewport()
  await page.keyboard.press('Home')
  await expect(page.getByRole('button', { name: 'Keyframe at 0:00.0', exact: true })).toBeFocused()

  // Scrolled to the middle, the marks there are drawn.
  await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth / 2))
  await expect.poll(covered).toBe(true)
  expect(await marks.count()).toBeLessThan(200)
})

test('no diamond covers a mark’s count, and the diamonds of separate marks never touch', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  const clip = (await page
    .getByRole('button', { name: 'Title, 0:01.0 to 0:09.0', exact: true })
    .boundingBox())!
  const pps = clip.width / 8
  const marks = page.locator('button[aria-label^="Keyframe at "], button[aria-label*=" keyframes, "]')
  // Three keyframes 5 px apart, then one 9, 12 or 30 px after the last.
  for (const [after, count] of [
    [9, 1],
    [12, 1],
    [30, 2],
  ] as const) {
    const times = [0, 5, 10, 10 + after].map((px) => 2 + px / pps)
    await page.evaluate((times) => {
      window.mvStudio.app.project.editor.dispatch({
        type: 'clip.set',
        clipId: 'o-title',
        path: ['transform', 'rotation', 'keyframes'],
        value: times.map((time) => ({ time, value: 0, easing: 'ease-in-out' })),
      })
    }, times)
    await expect(marks).toHaveCount(count)
    const drawn = await diamonds(marks)
    for (const [i, mark] of drawn.entries()) {
      const next = drawn[i + 1]
      // A diamond with its outline is 13 px wide.
      if (next) expect(next.x - mark.x).toBeGreaterThanOrEqual(11.5)
      for (const other of drawn)
        if (mark.count && other !== mark)
          expect(other.x + 6.5 <= mark.count[0] || other.x - 6.5 >= mark.count[1]).toBe(true)
    }
  }
})

test('a keyframe mark’s menu is named for its mark, opens from Arrow Down on its first easing and gives focus back on Esc, and a right-click on a mark only moves the playhead', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  for (const t of [3, 6]) {
    await at(page, t)
    await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  }
  // Not by role: an open menu hides the rest of the page from role queries.
  const first = page.locator('button[aria-label="Keyframe at 0:03.0"]')
  const second = page.locator('button[aria-label="Keyframe at 0:06.0"]')
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()

  await page.evaluate(() =>
    window.addEventListener(
      'contextmenu',
      (e) => (document.body.dataset.contextMenu = `${e.defaultPrevented}`),
      {
        once: true,
      },
    ),
  )
  await first.click({ button: 'right' })
  await expect(page.getByText(/^00:03\.00/)).toBeVisible()
  // The browser's own menu stays shut too.
  expect(await page.evaluate(() => document.body.dataset.contextMenu)).toBe('true')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(first).toHaveAttribute('aria-expanded', 'false')

  await first.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menu', { name: 'Keyframe at 0:03.0' })).toBeVisible()
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('menuitemcheckbox', { name: 'Linear' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(first).toBeFocused()
  await expect(first).toHaveAttribute('aria-expanded', 'false')

  await second.click()
  await expect(page.getByRole('menu', { name: 'Keyframe at 0:06.0' })).toBeVisible()
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  await expect(first).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText(/^00:06\.00/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(second).toBeFocused()
})

test('a keyframe menu that closes after its mark scrolled out of view or merged into another gives focus to a drawn mark', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await at(page, 3)
  await waitForPreview(page)
  // A 200 s clip keyed every 0.25 s.
  await page.evaluate(() => {
    const { app, model } = window.mvStudio
    const track = model.createTrack('visual', 'Take')
    const clip = model.createSolidClip({ trackId: track.id, color: '#101010', start: 0, duration: 200 })
    clip.opacity = {
      value: 1,
      keyframes: Array.from({ length: 800 }, (_, i) => ({ time: i * 0.25, value: i % 2, easing: 'hold' })),
    }
    app.project.editor.dispatch([
      { type: 'track.add', track, index: 0 },
      { type: 'clip.add', clip },
    ])
    app.ui.set({ playhead: 100 })
    app.ui.selectClips([clip.id])
  })
  const marks = page.locator('button[aria-label^="Keyframe at "], button[aria-label*=" keyframes, "]')
  const groups = page.locator('button[aria-label*=" keyframes, "]')
  await expect(marks.first()).toBeVisible()
  for (let i = 0; i < 16 && (await groups.count()) > 0; i++) await page.keyboard.press('ControlOrMeta+=')
  await expect(groups).toHaveCount(0)

  // Opened by pointer, a mark that is not the Tab stop is drawn only while its menu is open.
  const scroller = page.locator('[data-timeline-scroller]')
  const view = (await scroller.boundingBox())!
  const middle = await marks.evaluateAll(
    (els, mid) =>
      els
        .filter((el) => el.tabIndex < 0)
        .map((el) => ({ label: el.getAttribute('aria-label')!, x: el.getBoundingClientRect().left }))
        .sort((a, b) => Math.abs(a.x - mid) - Math.abs(b.x - mid))[0]!.label,
    view.x + view.width / 2,
  )
  const opened = page.locator(`button[aria-label="${middle}"]`)
  await opened.click()
  await expect(page.getByRole('menu', { name: middle })).toBeVisible()
  await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  await expect(page.locator('button[aria-label="Keyframe at 3:19.7"]')).toBeAttached()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(opened).toBeFocused()

  // A zoom that merges the open mark into another closes its menu, and focus goes to the Tab stop.
  // Not the first key: it stays the first of the merged mark, whose menu then stays open.
  const next = page.locator(`button[aria-label^="Keyframe at "][tabindex="-1"]`).last()
  const nextLabel = (await next.getAttribute('aria-label'))!
  await next.click()
  await expect(page.getByRole('menu', { name: nextLabel })).toBeVisible()
  await page.evaluate(() => window.mvStudio.app.ui.set({ pxPerSec: 2 }))
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator('button[aria-label*=" keyframes, "][tabindex="0"]')).toBeFocused()
})
