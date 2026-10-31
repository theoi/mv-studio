import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('library thumbnails load from the production build for every plugin, look and text style', async ({
  page,
}) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { engine, plugins } = window.mvStudio
    const urls: (string | undefined)[] = [
      ...engine.pluginRegistry.catalog().map((e: { thumbnail?: string }) => e.thumbnail),
      ...plugins.looks.lookRegistry.list().map((l: { thumbnail?: string }) => l.thumbnail),
      ...plugins.typography.styles.TEXT_STYLES.map((s: { thumbnail?: string }) => s.thumbnail),
    ]
    const failed: string[] = []
    const sizes = new Set<string>()
    for (const url of urls) {
      const res = url ? await fetch(url) : undefined
      if (!res?.ok) {
        failed.push(url ?? 'missing')
        continue
      }
      const bitmap = await createImageBitmap(await res.blob())
      sizes.add(`${bitmap.width}x${bitmap.height}`)
      bitmap.close()
    }
    return { count: urls.length, failed, sizes: [...sizes] }
  })
  expect(r.count).toBeGreaterThan(90)
  expect(r.failed).toEqual([])
  expect(r.sizes).toEqual(['320x180'])
})

test('the 3D camera move preview plays the move through the sample depth map', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { media, plugins, testing } = window.mvStudio
    const store = async (mode: 'color' | 'depth') =>
      media.mediaStore.storeBlob(await plugins.preview.sampleSceneBlob(640, 360, mode), {
        kind: 'image',
        name: `scene-${mode}.png`,
        origin: { type: 'generated' },
      })
    const image = await store('color')
    const depth = await store('depth')
    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const frame = async (p: Project, t: number) => {
      await compositor.render(p, t)
      return testing.readPixels(compositor.canvas, W, H)
    }
    const diff = (a: Uint8Array, b: Uint8Array) => {
      let sum = 0
      for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!)
      return sum / (a.length / 2)
    }
    const withDepth: { project: Project } = plugins.preview.pluginPreview('camera-3d', { image, depth })
    const flat: { project: Project } = plugins.preview.pluginPreview('camera-3d', { image })
    const start = await frame(withDepth.project, 0)
    const later = await frame(withDepth.project, 3.5)
    const flatLater = await frame(flat.project, 3.5)
    compositor.dispose()
    return { moved: diff(start, later), parallax: diff(later, flatLater) }
  })
  console.log('camera-3d preview', JSON.stringify(r))
  expect(r.moved).toBeGreaterThan(4)
  expect(r.parallax).toBeGreaterThan(2.5)
})
