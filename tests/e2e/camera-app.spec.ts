import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/**
 * Opens the sample with a model-free depth backend (a left-to-right ramp) in place of Depth Anything. With `gated`,
 * each estimate waits for `window.depthGate.release()` or `.fail(message)`, and stops when its job is cancelled.
 * With `fence`, the depth is thin near posts over a far background instead, which smears on a detailed still.
 */
async function openWithFakeDepth(page: Page, hash: string, gated = false, fence = false) {
  await openHarness(page)
  await page.evaluate(
    ([h, g, posts]) => {
      localStorage.setItem('mv-studio.guide-seen', '1')
      const calls: number[] = []
      const w = window as Untyped
      w.depthCalls = calls
      w.mvStudio.app.footage.setVisionBackendsForTests({
        onnx: () => ({
          async depth({ bitmap }: { bitmap: ImageBitmap }, options?: { signal?: AbortSignal }) {
            bitmap.close()
            calls.push(Date.now())
            if (g)
              await new Promise<void>((resolve, reject) => {
                w.depthGate = { release: resolve, fail: (message: string) => reject(new Error(message)) }
                options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
              })
            const width = posts ? 96 : 32
            const height = posts ? 54 : 18
            const data = new Uint8Array(width * height).map((_, i) =>
              posts ? ((i % width) % 12 < 2 ? 240 : 20) : Math.round(((i % width) / (width - 1)) * 255),
            )
            return { width, height, data }
          },
        }),
        segmentation: () => {
          throw new Error('unused')
        },
      })
      window.location.hash = h as string
    },
    [hash, gated, fence] as const,
  )
  await waitForPreview(page)
}
interface Still {
  id: string
  camera?: { preset: string; intensity: number; depth: string; keyframes: { time: number; value: number }[] }
  duration: number
}

function stills(page: Page): Promise<{ clips: Still[]; depthAssets: string[] }> {
  return page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const clips = Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => c.type === 'image')
      .map((c) => {
        const fx = c.effects[0]
        return {
          id: c.id,
          duration: c.duration,
          ...(fx?.effectId === 'camera-3d'
            ? {
                camera: {
                  preset: fx.params.preset.value,
                  intensity: fx.params.intensity.value,
                  depth: fx.params.depth.value,
                  keyframes: fx.params.progress.keyframes.map((k: Untyped) => ({
                    time: k.time,
                    value: k.value,
                  })),
                },
              }
            : {}),
        }
      })
    const depthAssets = Object.values(project.assets as Record<string, Untyped>)
      .filter((a) => a.origin.type === 'derived' && a.origin.parentAssetId === 'm-sunset')
      .map((a) => a.id)
    return { clips, depthAssets }
  })
}

test('Assist › 3D camera adds a depth camera move to every still in one undo step; Strength is automatic until set', async ({
  page,
}) => {
  await openWithFakeDepth(page, '#/editor?tab=assist&assist=camera&t=28')
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const before = await stills(page)
  expect(before.clips.length).toBeGreaterThan(1)
  expect(before.clips.every((c) => !c.camera)).toBe(true)
  const apply = assist.getByRole('button', { name: `Apply to ${before.clips.length} images` })
  await expect(apply).toBeVisible()
  await expect(assist.getByText(/^Image · on the timeline at /)).toHaveCount(before.clips.length)

  await assist.getByRole('radio', { name: 'Orbit' }).click()
  // Strength starts automatic: each image gets as much as it can take, up to 50%.
  const strength = assist.getByRole('slider', { name: 'Strength' })
  const autoHint = assist.getByText('Each image gets as much as it can take without smearing.')
  const reset = assist.getByRole('button', { name: 'Back to automatic strength' })
  await expect(assist.getByText('Auto', { exact: true })).toBeVisible()
  await expect(strength).toHaveAttribute('aria-valuetext', 'Automatic, 50% or less for each image')
  await expect(strength).toHaveAttribute('aria-valuenow', '50')
  await expect(autoHint).toBeVisible()
  await expect(strength).toHaveAccessibleDescription(
    'Each image gets as much as it can take without smearing.',
  )
  await expect(reset).toHaveCount(0)
  // A strength the user sets shows as a percent and goes on every image as it is.
  await strength.focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await expect(assist.getByText('60%', { exact: true })).toBeVisible()
  await expect(strength).not.toHaveAttribute('aria-valuetext')
  await expect(strength).not.toHaveAttribute('aria-describedby')
  await expect(autoHint).toHaveCount(0)
  await expect(reset).toBeVisible()
  await apply.click()
  await expect(assist.getByText(`Added a 3D camera move to ${before.clips.length} images`)).toBeVisible()

  const after = await stills(page)
  expect(after.depthAssets).toHaveLength(1)
  expect(await page.evaluate(() => (window as Untyped).depthCalls.length)).toBe(1)
  for (const clip of after.clips)
    expect(clip.camera).toEqual({
      preset: 'orbit-right',
      intensity: 0.6,
      depth: after.depthAssets[0],
      keyframes: [
        { time: 0, value: 0 },
        { time: clip.duration, value: 1 },
      ],
    })

  // One undo step removes every move; the panel lists the stills again.
  await assist.getByRole('button', { name: 'Undo' }).click()
  await expect(apply).toBeVisible()
  expect((await stills(page)).clips.every((c) => !c.camera)).toBe(true)

  // The chosen strength stays for the session; reset goes back to automatic, which gives 50% on this smooth depth.
  await expect(assist.getByText('60%', { exact: true })).toBeVisible()
  await reset.click()
  await expect(assist.getByText('Auto', { exact: true })).toBeVisible()
  await expect(strength).toBeFocused()
  await expect(strength).toHaveAttribute('aria-valuenow', '50')
  await expect(autoHint).toBeVisible()
  await apply.click()
  await expect(assist.getByText(`Added a 3D camera move to ${before.clips.length} images`)).toBeVisible()
  expect((await stills(page)).clips.map((c) => c.camera?.intensity)).toEqual(before.clips.map(() => 0.5))
})

test('the image inspector’s suggestion adds a 3D camera move to the selected still', async ({ page }) => {
  await openWithFakeDepth(page, '#/editor?t=28')
  const { clips } = await stills(page)
  const target = clips[0]!
  await page.evaluate((id) => {
    window.location.hash = `#/editor?sel=clip:${id}&t=28`
  }, target.id)
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Add 3D camera' }).click()
  await expect
    .poll(async () => (await stills(page)).clips.find((c) => c.id === target.id)?.camera?.preset)
    .toBe('dolly-in')
  expect((await stills(page)).clips.filter((c) => c.camera)).toHaveLength(1)
  await expect(inspector.getByRole('button', { name: 'Add 3D camera' })).toHaveCount(0)
})

test('Inspector › Motion adds, changes, strengthens and removes a still’s 3D camera move', async ({
  page,
}) => {
  await openWithFakeDepth(page, '#/editor?t=28')
  const target = (await stills(page)).clips[0]!
  await page.evaluate((id) => {
    window.location.hash = `#/editor?sel=clip:${id}&t=28`
  }, target.id)
  const camera = async () => (await stills(page)).clips.find((c) => c.id === target.id)?.camera
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Motion', exact: true }).click()
  const select = inspector.getByRole('combobox', { name: '3D camera move' })
  await expect(select).toHaveText('None')

  await select.click()
  await page.getByRole('option', { name: 'Drift' }).click()
  await expect.poll(camera).toMatchObject({ preset: 'pan-right', intensity: 0.5 })
  await expect(select).toHaveText('Drift')
  const added = (await camera())!

  // Changing the move keeps its depth map: no second depth estimate.
  await select.click()
  await page.getByRole('option', { name: 'Orbit' }).click()
  await expect.poll(async () => (await camera())?.preset).toBe('orbit-right')
  expect((await camera())?.depth).toBe(added.depth)
  expect(await page.evaluate(() => (window as Untyped).depthCalls.length)).toBe(1)

  const strength = inspector.getByRole('slider', { name: '3D camera strength' })
  await strength.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await camera())?.intensity).toBe(0.55)

  await select.click()
  await page.getByRole('option', { name: 'None' }).click()
  await expect.poll(camera).toBeUndefined()
  await expect(strength).toHaveCount(0)
  await expect(select).toHaveText('None')
})

test('Inspector › Motion shows the chosen move while depth is estimated, cancels there, and explains a wait or a failure', async ({
  page,
}) => {
  await openWithFakeDepth(page, '#/editor?t=28', true)
  const [target, other] = (await stills(page)).clips
  const select = (id: string) => async () => {
    await page.evaluate((i) => (window.location.hash = `#/editor?sel=clip:${i}&t=28`), id)
    const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
    const motion = inspector.getByRole('button', { name: 'Motion', exact: true })
    if ((await motion.getAttribute('aria-expanded')) === 'false') await motion.click()
    return inspector
  }
  const camera = async (id: string) => (await stills(page)).clips.find((c) => c.id === id)?.camera
  const depthCalls = () => page.evaluate(() => (window as Untyped).depthCalls.length as number)

  let inspector = await select(target!.id)()
  const move = inspector.getByRole('combobox', { name: '3D camera move' })
  await move.click()
  await page.getByRole('option', { name: 'Drift' }).click()
  // The choice shows while depth is estimated, and the select waits for it.
  await expect(inspector.getByText(/^Estimating depth… \d+%$/)).toBeVisible()
  await expect(move).toHaveText('Drift')
  await expect(move).toBeDisabled()
  const cancel = inspector.getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeVisible()

  // Another still can't start a move meanwhile, and says why.
  inspector = await select(other!.id)()
  await expect(inspector.getByRole('combobox', { name: '3D camera move' })).toBeDisabled()
  await expect(inspector.getByText('Wait for the other 3D camera move to finish.')).toBeVisible()

  // Cancel where it started: the section is back as before, with focus on the select. Esc does not cancel.
  await select(target!.id)()
  await cancel.focus()
  await page.keyboard.press('Escape')
  inspector = await select(target!.id)()
  await expect(inspector.getByText(/^Estimating depth…/)).toBeVisible()
  await inspector.getByRole('button', { name: 'Cancel' }).click()
  await expect(move).toHaveText('None')
  await expect(move).toBeEnabled()
  await expect(move).toBeFocused()
  await expect(inspector.getByText(/Cancelled/)).toHaveCount(0)
  expect(await camera(target!.id)).toBeUndefined()

  // A failure reads as one, and says how to retry.
  let n = await depthCalls()
  await move.click()
  await page.getByRole('option', { name: 'Orbit' }).click()
  await expect(move).toHaveText('Orbit')
  await expect.poll(depthCalls).toBe(n + 1)
  await page.evaluate(() => (window as Untyped).depthGate.fail('The depth model stopped.'))
  await expect(inspector.getByRole('alert')).toContainText('The depth model stopped.')
  await expect(inspector.getByRole('alert')).toContainText(
    'Your project is unchanged. Choose a move again to retry.',
  )
  await expect(move).toHaveText('None')

  // The next try lands, with the strength shown next to its slider.
  n = await depthCalls()
  await move.click()
  await page.getByRole('option', { name: 'Push in' }).click()
  await expect.poll(depthCalls).toBe(n + 1)
  await page.evaluate(() => (window as Untyped).depthGate.release())
  await expect.poll(async () => (await camera(target!.id))?.preset).toBe('dolly-in')
  await expect(move).toHaveText('Push in')
  await expect(inspector.getByText('50%', { exact: true })).toBeVisible()
  const strength = inspector.getByRole('slider', { name: '3D camera strength' })
  await strength.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await expect(inspector.getByText('55%', { exact: true })).toBeVisible()
})

test('Inspector › Motion adds a smear-safe amount until Strength is set, and notes when the strength may smear', async ({
  page,
}) => {
  await openWithFakeDepth(page, '#/editor?t=28', false, true)
  // A detailed still: a checkerboard that stays detailed at the depth map's size.
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(960, 540)
    const ctx = c.getContext('2d')!
    for (let y = 0; y < 540; y += 20)
      for (let x = 0; x < 960; x += 20) {
        ctx.fillStyle = (x + y) % 40 ? '#c8c8c8' : '#3c3c3c'
        ctx.fillRect(x, y, 20, 20)
      }
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
    return Array.from(bytes)
  })
  await page
    .getByLabel('Import media files')
    .setInputFiles({ name: 'checker.png', mimeType: 'image/png', buffer: Buffer.from(png) })
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('checker, image')
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const block = page.getByRole('button', { name: /^checker, \d/ })
  await expect(block).toHaveCount(1)
  await block.focus()
  await page.keyboard.press('Enter')
  const clipId = await page.evaluate(
    () =>
      Object.values(window.mvStudio.app.project.editor.getProject().clips as Record<string, Untyped>).find(
        (c) =>
          c.type === 'image' &&
          window.mvStudio.app.project.editor.getProject().assets[c.assetId]?.name.startsWith('checker'),
      ).id as string,
  )
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Motion', exact: true }).click()
  const select = inspector.getByRole('combobox', { name: '3D camera move' })
  await select.click()
  await page.getByRole('option', { name: 'Push in' }).click()

  // Strength was never set, so vision picks the amount: below 0.5 behind these posts, and the slider shows it.
  const intensity = () =>
    page.evaluate(
      (id) => window.mvStudio.app.project.editor.getProject().clips[id]?.effects[0]?.params.intensity.value,
      clipId,
    )
  await expect.poll(intensity).toBeLessThan(0.5)
  const auto = (await intensity()) as number
  expect(auto).toBeGreaterThanOrEqual(0.25)
  await expect(inspector.getByText(`${Math.round(auto * 100)}%`, { exact: true })).toBeVisible()

  /** The still's safe amount for its current move, as the inspector reads it. */
  const safePercent = () =>
    page.evaluate(async (id) => {
      const { media, vision, app } = window.mvStudio
      const safe = await vision.safeCameraIntensity(media.mediaStore, app.project.editor.getProject(), id)
      return Math.round(safe * 100)
    }, clipId)
  const strength = inspector.getByRole('slider', { name: '3D camera strength' })
  const note = inspector.getByText(/^May smear behind foreground objects above \d+%\.$/)
  const push = await safePercent()
  expect(push).toBeLessThan(100)

  // Above the safe amount the note shows, tied to the slider; the strength is kept as set.
  await strength.focus()
  await page.keyboard.press('End')
  await expect.poll(intensity).toBe(1)
  await expect(note).toHaveText(`May smear behind foreground objects above ${push}%.`)
  await expect(strength).toHaveAttribute('aria-describedby', (await note.locator('..').getAttribute('id'))!)
  await page.keyboard.press('Home')
  await expect.poll(intensity).toBe(0)
  await expect(note).toHaveCount(0)
  await expect(strength).not.toHaveAttribute('aria-describedby')

  // The number follows the preset.
  await select.click()
  await page.getByRole('option', { name: 'Orbit' }).click()
  await expect
    .poll(
      async () =>
        await page.evaluate(
          (id) => window.mvStudio.app.project.editor.getProject().clips[id]?.effects[0]?.params.preset.value,
          clipId,
        ),
    )
    .toBe('orbit-right')
  const orbit = await safePercent()
  await strength.focus()
  await page.keyboard.press('End')
  if (orbit < 100) await expect(note).toHaveText(`May smear behind foreground objects above ${orbit}%.`)
  else await expect(note).toHaveCount(0)
})

test('one inline suggestion at a time: a selected still’s suggestion takes the lyrics hint’s place, which comes back after', async ({
  page,
}) => {
  await openWithFakeDepth(page, '#/editor?t=28')
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const p = editor.getProject()
    const lines = [...p.lyrics.lines, { id: 'new-1', text: 'One more time', words: [] }]
    editor.dispatch({ type: 'lyrics.set', lyrics: { ...p.lyrics, lines } })
  })
  const hint = page.getByRole('note').filter({ hasText: '1 line not timed yet' })
  await expect(hint).toBeVisible()

  const target = (await stills(page)).clips[0]!
  await page.evaluate((id) => {
    window.location.hash = `#/editor?sel=clip:${id}&t=28`
  }, target.id)
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const camera = inspector.getByRole('note').filter({ hasText: 'Add 3D camera' })
  await expect(camera).toBeVisible()
  await expect(hint).toHaveCount(0)

  // From the keyboard, focus stays in the Inspector instead of dropping to the page as the card goes.
  await camera.getByRole('button', { name: 'Not now' }).focus()
  await page.keyboard.press('Enter')
  await expect(camera).toHaveCount(0)
  await expect(inspector.locator(':focus')).toHaveCount(1)
  await expect(hint).toBeVisible()
})
