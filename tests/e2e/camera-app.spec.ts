import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/**
 * Opens the sample with a model-free depth backend (a left-to-right ramp) in place of Depth Anything. With `gated`,
 * each estimate waits for `window.depthGate.release()` or `.fail(message)`, and stops when its job is cancelled.
 */
async function openWithFakeDepth(page: Page, hash: string, gated = false) {
  await openHarness(page)
  await page.evaluate(
    ([h, g]) => {
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
            const width = 32
            const height = 18
            const data = new Uint8Array(width * height).map((_, i) =>
              Math.round(((i % width) / (width - 1)) * 255),
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
    [hash, gated] as const,
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

test('Assist › 3D camera adds a depth camera move to every still in one undo step', async ({ page }) => {
  await openWithFakeDepth(page, '#/editor?tab=assist&assist=camera&t=28')
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const before = await stills(page)
  expect(before.clips.length).toBeGreaterThan(1)
  expect(before.clips.every((c) => !c.camera)).toBe(true)
  const apply = assist.getByRole('button', { name: `Apply to ${before.clips.length} images` })
  await expect(apply).toBeVisible()
  await expect(assist.getByText(/^Image · on the timeline at /)).toHaveCount(before.clips.length)

  await assist.getByRole('radio', { name: 'Orbit' }).click()
  const strength = assist.getByRole('slider', { name: 'Strength' })
  await strength.focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await apply.click()
  await expect(assist.getByText(`Added a 3D camera move to ${before.clips.length} images`)).toBeVisible()

  const after = await stills(page)
  expect(after.depthAssets).toHaveLength(1)
  expect(await page.evaluate(() => (window as Untyped).depthCalls.length)).toBe(1)
  for (const clip of after.clips)
    expect(clip.camera).toEqual({
      preset: 'orbit-right',
      intensity: 0.5,
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
  await expect.poll(camera).toMatchObject({ preset: 'pan-right', intensity: 0.4 })
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
  await expect.poll(async () => (await camera())?.intensity).toBe(0.45)

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

  // Cancel where it started: back to None, a quiet line, and the project is unchanged. Esc does not cancel.
  await select(target!.id)()
  await cancel.focus()
  await page.keyboard.press('Escape')
  inspector = await select(target!.id)()
  await expect(inspector.getByText(/^Estimating depth…/)).toBeVisible()
  await inspector.getByRole('button', { name: 'Cancel' }).click()
  await expect(move).toHaveText('None')
  await expect(move).toBeEnabled()
  await expect(inspector.getByText('Cancelled. Your project is unchanged.')).toBeVisible()
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
  await expect(inspector.getByText('40%', { exact: true })).toBeVisible()
  const strength = inspector.getByRole('slider', { name: '3D camera strength' })
  await strength.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await expect(inspector.getByText('45%', { exact: true })).toBeVisible()
})
