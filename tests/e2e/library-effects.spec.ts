import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEffectsTab(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=effects&t=66.9'
  })
  await waitForPreview(page)
  return {
    preview: page.getByRole('img', { name: 'Video preview' }),
    library: page.getByRole('tabpanel', { name: 'Effects' }),
    inspector: page.getByRole('tabpanel', { name: 'Inspector' }),
  }
}

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

/** A screenshot of the preview once it has stopped changing. */
async function settled(page: Page, preview: ReturnType<Page['getByRole']>): Promise<Buffer> {
  let last = await preview.screenshot()
  await expect
    .poll(async () => {
      const next = await preview.screenshot()
      const diff = await imageDiff(page, last, next)
      last = next
      return diff
    })
    .toBeLessThan(0.3)
  return last
}

test('a look from the library restyles the whole video as one undo step; the inspector shows it and blends it', async ({
  page,
}, testInfo) => {
  const { preview, library, inspector } = await openEffectsTab(page)
  const neon = library.getByRole('button', { name: 'Neon night', exact: true })
  const golden = library.getByRole('button', { name: 'Golden hour', exact: true })
  const original = library.getByRole('button', { name: 'Original', exact: true })

  // The sample project starts with the Neon night look at 70%.
  await expect(neon).toHaveAttribute('aria-pressed', 'true')
  await expect(library.getByRole('button', { pressed: true })).toHaveCount(1)
  await expect(inspector.getByText('Neon night', { exact: true })).toBeVisible()
  await expect(inspector.getByText('On every clip')).toBeVisible()
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()
  const before = await settled(page, preview)
  await page.screenshot({ path: testInfo.outputPath('effects-tab.png') })

  await golden.click()
  await expect(golden).toHaveAttribute('aria-pressed', 'true')
  await expect(neon).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('Look “Golden hour” applied to the whole video')).toBeVisible()
  await expect(inspector.getByText('Golden hour', { exact: true })).toBeVisible()
  // The intensity stays with the video when the look changes.
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()
  await expect.poll(async () => imageDiff(page, before, await preview.screenshot())).toBeGreaterThan(2)
  const goldenFrame = await settled(page, preview)
  await page.screenshot({ path: testInfo.outputPath('effects-golden-hour.png') })

  // At 0% the look layer shows the picture as if there were no look. Home sets the slider, not the playhead.
  await inspector.getByRole('slider', { name: 'Look intensity' }).focus()
  await page.keyboard.press('Home')
  await expect(inspector.getByText('0%', { exact: true })).toBeVisible()
  await expect(page.getByText('01:06.90')).toBeVisible()
  await expect.poll(async () => imageDiff(page, goldenFrame, await preview.screenshot())).toBeGreaterThan(2)
  const none = await settled(page, preview)
  await original.click()
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  await expect(inspector.getByText('No look', { exact: true })).toBeVisible()
  await expect(inspector.getByRole('slider', { name: 'Look intensity' })).toHaveCount(0)
  expect(await imageDiff(page, none, await settled(page, preview))).toBeLessThan(0.5)
  await page.screenshot({ path: testInfo.outputPath('effects-original.png') })

  // Removing the look, the intensity change and the look are one undo step each.
  await page.keyboard.press(`${mod}+z`)
  await expect(golden).toHaveAttribute('aria-pressed', 'true')
  await expect(inspector.getByText('0%', { exact: true })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(neon).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => imageDiff(page, before, await preview.screenshot())).toBeLessThan(0.5)
})

test('effects and transitions from the library go on the clip at the playhead, and the search narrows the lists', async ({
  page,
}) => {
  const { library, inspector } = await openEffectsTab(page)
  const glowTarget = () =>
    page.evaluate(() => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      const clip = Object.values(project.clips).find(
        (c) => c.type !== 'audio' && c.meta?.role !== 'look' && c.effects.some((e) => e.effectId === 'glow'),
      )
      return clip
        ? { id: clip.id, type: clip.type, start: clip.start, end: clip.start + clip.duration }
        : null
    })

  await library.getByRole('button', { name: 'Glow', exact: true }).click()
  await expect(page.getByText(/^“Glow” added to /)).toBeVisible()
  const target = await glowTarget()
  expect(target?.type).toMatch(/^(video|image)$/)
  expect(target!.start).toBeLessThanOrEqual(66.9)
  expect(target!.end).toBeGreaterThan(66.9)
  // The clip is selected, and its Effects section lists the effect by name.
  await inspector.getByRole('button', { name: /^Effects/ }).click()
  await expect(inspector.getByText('Glow', { exact: true })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(inspector.getByText('No effects yet. Add one from Library › Effects.')).toBeVisible()
  expect(await glowTarget()).toBeNull()

  // With the clip selected, a transition goes on the cut at its start.
  await library.getByRole('button', { name: 'Flash', exact: true }).click()
  await expect(page.getByText(/^“Flash” added to the cut at \d+:\d\d\.\d$/)).toBeVisible()
  const transition = await page.evaluate(
    (id) => window.mvStudio.app.project.editor.getProject().clips[id].transitionIn,
    target!.id,
  )
  expect(transition).toMatchObject({ kind: 'flash' })

  const search = library.getByRole('textbox', { name: 'Search looks and effects' })
  await search.fill('glitch')
  await expect(library.getByRole('button', { name: 'Glitch', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Glitch cut', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Golden hour' })).toHaveCount(0)
  await search.fill('warm')
  await expect(library.getByRole('button', { name: 'Golden hour', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Light leak', exact: true })).toBeVisible()
  await expect(library.getByRole('button', { name: 'Glitch', exact: true })).toHaveCount(0)
  await search.fill('qwerty')
  await expect(library.getByText('No matches')).toBeVisible()
})

/** The timeline's name for a clip at start..end ("Night city, 1:06.0 to 1:08.0"). */
function clipLabel(name: string, start: number, end: number): string {
  const time = (t: number) => {
    const m = Math.floor(t / 60)
    const s = t - m * 60
    return `${m}:${String(Math.floor(s)).padStart(2, '0')}.${Math.floor((s - Math.floor(s)) * 10)}`
  }
  return `${name}, ${time(start)} to ${time(end)}`
}

test('effects and transitions dragged onto the timeline land on the clip or cut they are dropped on', async ({
  page,
}) => {
  const { library } = await openEffectsTab(page)
  const clip = await page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const c = Object.values(project.clips).find(
      (c) => c.trackId === 't-video' && c.start <= 66.9 && c.start + c.duration > 66.9,
    )!
    return {
      id: c.id,
      name: c.name ?? project.assets[(c as { assetId: string }).assetId]!.name,
      start: c.start,
      end: c.start + c.duration,
    }
  })
  const block = page.getByRole('button', { name: clipLabel(clip.name, clip.start, clip.end), exact: true })
  const effects = (id: string) =>
    page.evaluate((id) => {
      const c = window.mvStudio.app.project.editor.getProject().clips[id]
      return {
        effects: c.effects.map((e: { effectId: string }) => e.effectId),
        transition: c.transitionIn?.kind,
      }
    }, id)

  await library.getByRole('button', { name: 'RGB split', exact: true }).dragTo(block)
  await expect(page.getByText(`“RGB split” added to ${clip.name}`)).toBeVisible()
  expect(await effects(clip.id)).toEqual({ effects: ['rgb-split'], transition: undefined })
  await expect(block).toHaveAttribute('aria-pressed', 'true')

  // Near the clip's left edge is the cut where it starts. Whip pan is past the transitions' first rows.
  await library.getByRole('textbox', { name: 'Search looks and effects' }).fill('whip')
  await library
    .getByRole('button', { name: 'Whip pan', exact: true })
    .dragTo(block, { targetPosition: { x: 3, y: 10 } })
  await expect(page.getByText(/^“Whip pan” added to the cut at \d+:\d\d\.\d$/)).toBeVisible()
  expect(await effects(clip.id)).toEqual({ effects: ['rgb-split'], transition: 'whip-pan' })
})

test('each group shows its first two rows until "Show all", which lasts the session; search shows every match', async ({
  page,
}) => {
  const { library } = await openEffectsTab(page)
  const transitions = library.getByRole('group', { name: 'Transitions' })
  const showAll = library.getByRole('button', { name: /^Show all \d+$/ })
  await expect(library.getByText(/^Transitions · \d+$/)).toBeVisible()
  const total = Number((await library.getByText(/^Transitions · \d+$/).textContent())?.match(/\d+$/)?.[0])
  const columns = await transitions.evaluate(
    (grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length,
  )
  await expect(transitions.getByRole('button')).toHaveCount(2 * columns)

  const toggle = library.getByRole('button', { name: `Show all ${total}` })
  await toggle.click()
  await expect(transitions.getByRole('button')).toHaveCount(total)
  const fewer = library.getByRole('button', { name: 'Show fewer' })
  await expect(fewer).toBeFocused()
  await expect(fewer).toHaveAttribute('aria-expanded', 'true')

  // The group stays open across tab switches for the session.
  await page.getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('tab', { name: 'Effects' }).click()
  await expect(transitions.getByRole('button')).toHaveCount(total)

  await library.getByRole('button', { name: 'Show fewer' }).click()
  await expect(transitions.getByRole('button')).toHaveCount(2 * columns)
  // The list scrolls with the collapse, so the focused button stays in view.
  await expect(library.getByRole('button', { name: `Show all ${total}` })).toBeFocused()
  await expect(library.getByRole('button', { name: `Show all ${total}` })).toBeInViewport()

  // Searching shows every match, without the buttons, and hides groups with none.
  const search = library.getByRole('textbox', { name: 'Search looks and effects' })
  await search.fill('a')
  await expect(showAll).toHaveCount(0)
  const matches = Number((await library.getByText(/^Transitions · \d+$/).textContent())?.match(/\d+$/)?.[0])
  expect(matches).toBeGreaterThan(2 * columns)
  await expect(transitions.getByRole('button')).toHaveCount(matches)
  await search.fill('glitch')
  await expect(library.getByRole('group', { name: 'Looks' })).toHaveCount(0)
  await search.fill('')
  await expect(library.getByRole('button', { name: `Show all ${total}` })).toBeVisible()
})

test('a collapsed Looks group still shows the chosen look, in its last slot', async ({ page }) => {
  const { library } = await openEffectsTab(page)
  const looks = library.getByRole('group', { name: 'Looks' })
  const total = Number((await library.getByText(/^Looks · \d+$/).textContent())?.match(/\d+$/)?.[0])
  await library.getByRole('button', { name: `Show all ${total}` }).click()
  const last = looks.getByRole('button').last()
  const name = (await last.textContent())?.trim()
  await last.click()
  await expect(last).toHaveAttribute('aria-pressed', 'true')
  await library.getByRole('button', { name: 'Show fewer' }).click()

  const columns = await looks.evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length)
  await expect(looks.getByRole('button')).toHaveCount(2 * columns)
  await expect(looks.getByRole('button').last()).toHaveText(name!)
  await expect(looks.getByRole('button').last()).toHaveAttribute('aria-pressed', 'true')
  await expect(looks.getByRole('button').first()).toHaveText('Original')
})
