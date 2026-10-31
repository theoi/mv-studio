import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/** Opens the sample with a model-free depth backend (a left-to-right ramp) in place of Depth Anything. */
async function openWithFakeDepth(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const calls: number[] = []
    ;(window as Untyped).depthCalls = calls
    ;(window as Untyped).mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => ({
        async depth({ bitmap }: { bitmap: ImageBitmap }) {
          bitmap.close()
          calls.push(Date.now())
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
    window.location.hash = h
  }, hash)
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
