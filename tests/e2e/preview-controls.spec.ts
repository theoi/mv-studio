import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page, hash: string): Promise<Locator> {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
  return page.getByRole('img', { name: 'Video preview' })
}

async function playheadSeconds(page: Page): Promise<number> {
  const text = await page
    .getByText(/^\d\d:\d\d\.\d\d$/)
    .first()
    .textContent()
  const [m, s] = (text ?? '0:0').split(':')
  return Number(m) * 60 + Number(s)
}

const isFullscreen = (page: Page) =>
  page.evaluate(() => !!document.fullscreenElement?.querySelector('canvas[aria-label="Video preview"]'))

async function center(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox()
  if (!b) throw new Error('not on screen')
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function drag(page: Page, path: { x: number; y: number }[]) {
  const [first, ...rest] = path
  if (!first) return
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 4 })
  await page.mouse.up()
}

test('Loop repeats the section under the playhead, moves with a seek to another section, and turns off', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openEditor(page, '#/editor?t=94')
  const loop = page.getByRole('button', { name: 'Loop playback' })
  await expect(loop).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press(`${mod}+l`)
  await expect(loop).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Looping Chorus')).toBeVisible()
  await expect(loop).toHaveAccessibleName('Loop playback · Chorus')

  // Plays from `from` to the section end, then starts the section again instead of going on.
  const wrapsBackTo = async (from: number, start: number, end: number) => {
    await page.keyboard.press('Space')
    await expect.poll(() => playheadSeconds(page), { timeout: 30_000 }).toBeGreaterThan(from + 0.2)
    let latest = 0
    await expect
      .poll(
        async () => {
          latest = await playheadSeconds(page)
          expect(latest).toBeLessThan(end + 0.05)
          return latest
        },
        { timeout: 15_000 },
      )
      .toBeLessThan(start + 1.5)
    expect(latest).toBeGreaterThanOrEqual(start)
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  }
  await wrapsBackTo(94, 64, 96)

  // Verse 2 runs from 1:36 to 2:08.
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 126.5 }))
  // The button names the section the loop moved to.
  await expect(loop).toHaveAccessibleName('Loop playback · Verse 2')
  await wrapsBackTo(126.5, 96, 128)

  await loop.click()
  await expect(loop).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('Loop off')).toBeVisible()
  await expect(loop).toHaveAccessibleName('Loop playback')
})

test('a link past the end, End, stepping forward and a scrub past the end all stop on the video’s last frame', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=9999')
  const end = await page.evaluate(() => {
    const { editor, timelineDuration } = window.mvStudio.app.project
    return timelineDuration(editor.getProject()) as number
  })
  const playhead = () => page.evaluate(() => window.mvStudio.app.ui.get().playhead as number)
  const brightness = () =>
    page.evaluate(async () => {
      const frame: ImageBitmap = await window.mvStudio.app.stagePreview().captureFrame()
      const ctx = new OffscreenCanvas(frame.width, frame.height).getContext(
        '2d',
      ) as OffscreenCanvasRenderingContext2D
      ctx.drawImage(frame, 0, 0)
      const d = ctx.getImageData(0, 0, frame.width, frame.height).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4)
        sum += 0.2126 * (d[i] as number) + 0.7152 * (d[i + 1] as number) + 0.0722 * (d[i + 2] as number)
      return sum / (d.length / 4)
    })
  expect(await playhead()).toBeCloseTo(end - 0.01, 6)
  // At the end itself every clip has ended and the frame is black.
  await expect.poll(brightness).toBeGreaterThan(5)

  await page.keyboard.press('Home')
  await expect.poll(playhead).toBe(0)
  await page.keyboard.press('End')
  await expect.poll(playhead).toBeCloseTo(end - 0.01, 6)

  // A frame or a beat forward from there stays on the last frame.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  expect(await playhead()).toBeCloseTo(end - 0.01, 6)
  await expect.poll(brightness).toBeGreaterThan(5)

  // So does a scrub on the ruler past the end, with the whole timeline in view.
  await page.keyboard.press('Home')
  await page.evaluate(() => window.mvStudio.app.ui.set({ pxPerSec: 2 }))
  const ruler = page.locator('[data-timeline-scroller] [class*="ruler"]').first()
  const box = (await ruler.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 2 * (end - 5), y)
  await page.mouse.down()
  await page.mouse.move(box.x + 2 * end + 100, y, { steps: 4 })
  await page.mouse.up()
  expect(await playhead()).toBeCloseTo(end - 0.01, 6)
})

test('Volume sets the preview level, which is remembered after a reload', async ({ page }) => {
  await openEditor(page, '#/editor?t=21')
  const level = () => page.evaluate(() => window.mvStudio.app.stagePreview().clock.volume as number)
  expect(await level()).toBe(1)
  await page.getByRole('button', { name: 'Volume', exact: true }).click()
  const slider = page.getByRole('slider', { name: 'Volume' })
  await slider.focus()
  await page.keyboard.press('Home')
  await expect(page.getByRole('dialog', { name: 'Volume' }).getByText('0%', { exact: true })).toBeVisible()
  await expect.poll(level).toBe(0)
  for (let i = 0; i < 35; i++) await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: 'Volume' }).getByText('35%', { exact: true })).toBeVisible()
  await expect(slider).toHaveAttribute('aria-valuetext', '35%')
  await expect.poll(level).toBeCloseTo(0.35, 5)
  await page.keyboard.press('Escape')
  await expect(slider).toBeHidden()

  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await waitForPreview(page)
  await expect.poll(level).toBeCloseTo(0.35, 5)
  await page.getByRole('button', { name: 'Volume', exact: true }).click()
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveAttribute('aria-valuenow', '35')
})

test('the editor makes its audio context ahead of Play, so the click only resumes it', async ({ page }) => {
  // Counts the AudioContexts made during a click: making the page's first one takes tens of milliseconds.
  await page.addInitScript(() => {
    const w = window as unknown as { contextsInClick: number }
    w.contextsInClick = 0
    let clicking = false
    window.addEventListener('click', () => (clicking = true), { capture: true })
    window.addEventListener('click', () => (clicking = false))
    const Original = window.AudioContext
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options)
        if (clicking) w.contextsInClick++
      }
    }
  })
  await openEditor(page, '#/editor?t=21')
  // Longer than the editor waits for an idle moment to make it (3 s at most).
  await page.waitForTimeout(3500)
  const context = () =>
    page.evaluate(() => {
      const clock = window.mvStudio.app.stagePreview().clock as unknown as { ctx?: AudioContext }
      return clock.ctx?.state ?? 'none'
    })
  // Browsers start a context made outside a click suspended; the e2e profile turns that policy off.
  await page.evaluate(() =>
    (window.mvStudio.app.stagePreview().clock as unknown as { ctx?: AudioContext }).ctx?.suspend(),
  )
  expect(await context()).toBe('suspended')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.mvStudio.app.stagePreview().clock.state as string))
    .toBe('playing')
  expect(await context()).toBe('running')
  expect(await page.evaluate(() => (window as unknown as { contextsInClick: number }).contextsInClick)).toBe(
    0,
  )
})

test('F and the button show the preview full screen, where Space plays; F and Esc leave it', async ({
  page,
}) => {
  const preview = await openEditor(page, '#/editor?t=21&sel=clip:c-s-v1-1')
  const width = async () => (await preview.boundingBox())?.width ?? 0
  const before = await width()
  const handles = page.locator('[data-handle="move"]')
  await expect(handles).toHaveCount(1)

  await page.keyboard.press('f')
  await expect.poll(() => isFullscreen(page)).toBe(true)
  await expect.poll(width).toBeGreaterThan(before + 100)
  await expect(handles).toHaveCount(0)
  const playing = () => page.evaluate(() => window.mvStudio.app.ui.get().playing as boolean)
  await page.keyboard.press('Space')
  await expect.poll(playing).toBe(true)
  await page.keyboard.press('Space')
  await expect.poll(playing).toBe(false)
  await page.keyboard.press('f')
  await expect.poll(() => isFullscreen(page)).toBe(false)
  await expect.poll(width).toBe(before)
  await expect(handles).toHaveCount(1)

  await page.getByRole('button', { name: 'Full-screen preview' }).click()
  await expect.poll(() => isFullscreen(page)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => isFullscreen(page)).toBe(false)
})

test('Preview zoom shows the frame at 100%, scrolled to its middle, and Fit fits it again', async ({
  page,
}) => {
  const preview = await openEditor(page, '#/editor?t=21')
  const width = async () => (await preview.boundingBox())?.width ?? 0
  const fit = await width()
  const projectWidth = await page.evaluate(
    () => window.mvStudio.app.project.editor.getProject().settings.width as number,
  )
  expect(fit).toBeLessThan(projectWidth)

  await page.getByRole('button', { name: 'Preview zoom: Fit' }).click()
  await page.getByRole('menuitem', { name: '100%' }).click()
  await expect(page.getByRole('button', { name: 'Preview zoom: 100%' })).toBeVisible()
  await expect.poll(width).toBe(projectWidth)
  const scroll = await preview.evaluate((canvas) => {
    const stage = canvas.parentElement?.parentElement as HTMLElement
    return { left: stage.scrollLeft, max: stage.scrollWidth - stage.clientWidth }
  })
  expect(scroll.max).toBeGreaterThan(0)
  expect(Math.abs(scroll.left - scroll.max / 2)).toBeLessThanOrEqual(1)

  await page.getByRole('button', { name: 'Preview zoom: 100%' }).click()
  await page.getByRole('menuitem', { name: 'Fit' }).click()
  await expect.poll(width).toBe(fit)
})

test('at a 50% preview zoom, a browser zoom renders the preview at the new pixel ratio', async ({ page }) => {
  const preview = await openEditor(page, '#/editor?t=21')
  const projectWidth = await page.evaluate(
    () => window.mvStudio.app.project.editor.getProject().settings.width as number,
  )
  await page.getByRole('button', { name: 'Preview zoom: Fit' }).click()
  await page.getByRole('menuitem', { name: '50%' }).click()
  const rendered = () => page.evaluate(() => window.mvStudio.app.stagePreview().stats().width as number)
  await expect.poll(rendered).toBe(projectWidth / 2)

  // What a 200% browser zoom does: half the CSS pixels, twice the pixel ratio.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 720,
    height: 450,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await expect.poll(rendered).toBe(projectWidth)
  expect((await preview.boundingBox())?.width).toBe(projectWidth / 2)
})

test('Inspector › Transform and the preview handles move the clip together, one undo step per drag', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const preview = await openEditor(page, '#/editor?t=21&sel=clip:c-s-v1-1')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const handle = (name: string) => page.locator(`[data-handle="${name}"]`)
  const field = async (name: string) =>
    Number(await inspector.getByRole('textbox', { name, exact: true }).inputValue())
  const setField = async (name: string, value: number) => {
    const input = inspector.getByRole('textbox', { name, exact: true })
    await input.fill(String(value))
    await input.press('Enter')
  }
  const near = (name: string, expected: number, tolerance = 1) =>
    expect.poll(async () => Math.abs((await field(name)) - expected)).toBeLessThanOrEqual(tolerance)
  const box = await preview.boundingBox()
  if (!box) throw new Error('no preview')
  const projectWidth = await page.evaluate(
    () => window.mvStudio.app.project.editor.getProject().settings.width as number,
  )
  const k = box.width / projectWidth
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  expect(await field('Position X')).toBe(0)
  expect(await field('Scale')).toBe(100)

  // Editing the fields moves the handles.
  const corner0 = await center(handle('top-left'))
  await setField('Scale', 50)
  await expect
    .poll(async () => {
      const p = await center(handle('top-left'))
      return Math.hypot(p.x - mid.x, p.y - mid.y) / Math.hypot(corner0.x - mid.x, corner0.y - mid.y)
    })
    .toBeCloseTo(0.5, 1)
  await setField('Position X', 192)
  await expect.poll(async () => (await center(handle('move'))).x - mid.x).toBeCloseTo(192 * k, 0)
  const knobAngle = async () => {
    const knob = await center(handle('rotate'))
    const c = await center(handle('move'))
    return Math.round((Math.atan2(knob.y - c.y, knob.x - c.x) * 180) / Math.PI)
  }
  expect(await knobAngle()).toBe(-90)
  await setField('Rotation', 90)
  await expect.poll(knobAngle).toBe(0)
  await setField('Rotation', 0)
  await expect.poll(knobAngle).toBe(-90)

  // Dragging inside the outline moves the clip; one undo puts it back.
  const c = await center(handle('move'))
  await drag(page, [c, { x: c.x + 40, y: c.y + 20 }, { x: c.x + 80, y: c.y + 40 }])
  await near('Position X', 192 + 80 / k)
  await near('Position Y', 40 / k)
  await page.keyboard.press(`${mod}+z`)
  await near('Position X', 192, 0)
  await near('Position Y', 0, 0)

  // A corner scales around the anchor.
  const anchor = await center(handle('move'))
  const corner = await center(handle('bottom-right'))
  const out = (f: number) => ({
    x: anchor.x + (corner.x - anchor.x) * f,
    y: anchor.y + (corner.y - anchor.y) * f,
  })
  await drag(page, [corner, out(1.25), out(1.5)])
  await near('Scale', 75)
  await page.keyboard.press(`${mod}+z`)
  await near('Scale', 50, 0)

  // The knob turns the clip a quarter turn clockwise.
  const knob = await center(handle('rotate'))
  const radius = Math.hypot(knob.x - anchor.x, knob.y - anchor.y)
  const around = Array.from({ length: 10 }, (_, i) => {
    const a = ((-90 + i * 10) * Math.PI) / 180
    return { x: anchor.x + radius * Math.cos(a), y: anchor.y + radius * Math.sin(a) }
  })
  await drag(page, around)
  await near('Rotation', 90)
  await expect.poll(knobAngle).toBeGreaterThanOrEqual(-1)
  await page.keyboard.press(`${mod}+z`)
  await near('Rotation', 0, 0)

  // Reset transform puts the handles back where they started.
  await inspector.getByRole('button', { name: 'Reset transform' }).click()
  await near('Scale', 100, 0)
  await near('Position X', 0, 0)
  await expect
    .poll(async () => {
      const p = await center(handle('top-left'))
      return Math.hypot(p.x - corner0.x, p.y - corner0.y)
    })
    .toBeLessThan(1)

  // With Position keyframed, a drag sets the keyframe at the playhead.
  await inspector.getByRole('button', { name: 'Add keyframe: Position' }).click()
  const start = await center(handle('move'))
  await drag(page, [start, { x: start.x + 60, y: start.y }])
  const keyframes = () =>
    page.evaluate(() => {
      const clip = window.mvStudio.app.project.editor.getProject().clips['c-s-v1-1']
      return (clip.transform.x.keyframes as { time: number; value: number }[]).map((kf) => ({
        time: kf.time,
        px: (kf.value - 0.5) * 1920,
      }))
    })
  await expect.poll(async () => (await keyframes())[0]?.px ?? 0).toBeGreaterThan(10)
  const [only, ...others] = await keyframes()
  expect(others).toEqual([])
  expect(only?.time).toBeCloseTo(1, 3)
  expect(Math.abs((only?.px ?? 0) - 60 / k)).toBeLessThanOrEqual(2)
})

test('Inspector › Compositing: opacity and blend mode change the clip in the preview', async ({ page }) => {
  await openEditor(page, '#/editor?t=21&sel=clip:c-s-v1-1')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const brightness = () =>
    page.evaluate(async () => {
      const frame: ImageBitmap = await window.mvStudio.app.stagePreview().captureFrame()
      const ctx = new OffscreenCanvas(frame.width, frame.height).getContext(
        '2d',
      ) as OffscreenCanvasRenderingContext2D
      ctx.drawImage(frame, 0, 0)
      const d = ctx.getImageData(0, 0, frame.width, frame.height).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4)
        sum += 0.2126 * (d[i] as number) + 0.7152 * (d[i + 1] as number) + 0.0722 * (d[i + 2] as number)
      return sum / (d.length / 4)
    })
  const shown = await brightness()
  expect(shown).toBeGreaterThan(20)

  await inspector.getByRole('slider', { name: 'Opacity' }).focus()
  await page.keyboard.press('Home')
  await expect(inspector.getByRole('slider', { name: 'Opacity' })).toHaveAttribute('aria-valuenow', '0')
  await expect.poll(brightness).toBeLessThan(shown * 0.5)
  await page.keyboard.press('End')
  await expect.poll(async () => Math.abs((await brightness()) - shown)).toBeLessThan(1)

  const blend = inspector.getByRole('combobox', { name: 'Blend mode' })
  await blend.click()
  await page.getByRole('option', { name: 'Multiply' }).click()
  await expect(blend).toHaveText(/Multiply/)
  // Multiplied with the black below it, the clip disappears.
  await expect.poll(brightness).toBeLessThan(shown * 0.5)
  // Shortcuts stay with a focused combobox, which takes the keys itself.
  await blend.blur()
  await page.keyboard.press(`${mod}+z`)
  await expect(blend).toHaveText(/Normal/)
  await expect.poll(async () => Math.abs((await brightness()) - shown)).toBeLessThan(1)
})

test('Handles stay on the stage: a clip twice the frame leaves the transport usable and every handle in reach', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const preview = await openEditor(page, '#/editor?t=21&sel=clip:c-s-v1-1')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const stage = preview.locator('xpath=../..')
  const names = ['top-left', 'top-right', 'bottom-right', 'bottom-left', 'rotate']
  // Each handle's whole hit area is on the stage, at least 24 px across, and on top where it is drawn.
  const expectReachable = async () => {
    const s = (await stage.boundingBox())!
    for (const name of names) {
      const b = (await page.locator(`[data-handle="${name}"]`).boundingBox())!
      expect(b.width, name).toBeGreaterThanOrEqual(24)
      expect(b.height, name).toBeGreaterThanOrEqual(24)
      expect(b.x, name).toBeGreaterThanOrEqual(s.x - 0.5)
      expect(b.y, name).toBeGreaterThanOrEqual(s.y - 0.5)
      expect(b.x + b.width, name).toBeLessThanOrEqual(s.x + s.width + 0.5)
      expect(b.y + b.height, name).toBeLessThanOrEqual(s.y + s.height + 0.5)
      const top = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.getAttribute('data-handle'),
        [b.x + b.width / 2, b.y + b.height / 2],
      )
      expect(top, name).toBe(name)
    }
  }
  // Four corner squares and four corner hit areas.
  await expect(preview.locator('xpath=../..').locator('svg rect')).toHaveCount(8)
  // At Fit the full-frame clip's knob has no room above the frame, so it sits inside the top edge.
  await expectReachable()
  const frame = (await preview.boundingBox())!
  expect((await center(page.locator('[data-handle="rotate"]'))).y).toBeGreaterThan(frame.y)

  const scale = inspector.getByRole('textbox', { name: 'Scale', exact: true })
  await scale.fill('200')
  await scale.press('Enter')
  await scale.blur()
  await expectReachable()

  // The clip covers far more than the stage, but the transport still takes clicks.
  const playing = () => page.evaluate(() => window.mvStudio.app.ui.get().playing as boolean)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(playing).toBe(true)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect.poll(playing).toBe(false)

  // A corner drawn at the stage edge still scales from there: halfway to the anchor halves the clip.
  const anchor = await center(page.locator('[data-handle="move"]'))
  const corner = await center(page.locator('[data-handle="top-left"]'))
  await drag(page, [corner, { x: (corner.x + anchor.x) / 2, y: (corner.y + anchor.y) / 2 }])
  await expect.poll(async () => Math.abs(Number(await scale.inputValue()) - 100)).toBeLessThanOrEqual(2)
})

test('Corner cursors follow the corner, not the box: a wide title shows diagonal arrows', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=5&sel=clip:o-title')
  const cursor = (name: string) =>
    page.locator(`[data-handle="${name}"]`).evaluate((el) => getComputedStyle(el).cursor)
  expect(await cursor('top-left')).toBe('nwse-resize')
  expect(await cursor('top-right')).toBe('nesw-resize')
  expect(await cursor('bottom-right')).toBe('nwse-resize')
  expect(await cursor('bottom-left')).toBe('nesw-resize')
})

test('A lyric line and a clip on a locked track show the outline without handles, and a drag says why', async ({
  page,
}) => {
  const preview = await openEditor(page, '#/editor?sel=lyric:l-c1-2&t=70.4')
  const outline = preview.locator('xpath=..').locator('svg polygon')
  // Outline only: no handles, and no corner squares that would look like them.
  const squares = preview.locator('xpath=..').locator('svg rect')
  await expect(outline).toHaveCount(1)
  await expect(page.locator('[data-handle]')).toHaveCount(0)
  await expect(squares).toHaveCount(0)
  const lineY = () =>
    page.evaluate(() => {
      const clips = Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
        lyricLineId?: string
        transform: { y: { value: number } }
      }[]
      return clips.find((c) => c.lyricLineId === 'l-c1-2')?.transform.y.value
    })
  const before = await lineY()
  const note = page
    .getByRole('status')
    .filter({ hasText: 'Lyrics move together. Use Position in the Inspector.' })
  const box = (await outline.boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 30, at.y - 20, { steps: 4 })
  await expect(note).toBeVisible()
  // It goes away on its own while the button is still down, and does not follow the pointer.
  await expect(note).toBeHidden({ timeout: 5_000 })
  await page.mouse.up()
  expect(await lineY()).toBe(before)

  // Released sooner, it goes at once.
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 30, at.y, { steps: 4 })
  await expect(note).toBeVisible()
  await page.mouse.up()
  await expect(note).toBeHidden()

  // A locked track: the same note with the locked message, and no toast as well.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const clip = editor.getProject().clips['c-s-v1-1']
    editor.dispatch({ type: 'track.update', trackId: clip.trackId, patch: { locked: true } })
    window.mvStudio.app.ui.set({ playhead: 21, selection: { type: 'clip', id: 'c-s-v1-1' }, toasts: [] })
  })
  await expect(page.locator('[data-handle]')).toHaveCount(0)
  await expect(outline).toHaveCount(1)
  await expect(squares).toHaveCount(0)
  const locked = page.getByRole('status').filter({ hasText: 'That track is locked. Unlock it to edit.' })
  const mid = await center(preview)
  await page.mouse.move(mid.x, mid.y)
  await page.mouse.down()
  await page.mouse.move(mid.x + 30, mid.y, { steps: 4 })
  await expect(locked).toBeVisible()
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().toasts.length)).toBe(0)
  await page.mouse.up()
  await expect(locked).toBeHidden()
})
