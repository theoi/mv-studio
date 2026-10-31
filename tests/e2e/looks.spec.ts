import { expect, openHarness, test } from './fixtures.ts'

test('every look renders and visibly restyles footage and text', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, media, plugins, testing } = window.mvStudio
    const W = 192
    const H = 108
    const canvas = new OffscreenCanvas(W, H)
    const ctx = canvas.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, '#203a8f')
    g.addColorStop(0.5, '#e07a3f')
    g.addColorStop(1, '#f2e8c9')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    const image = await media.mediaStore.storeBlob(await canvas.convertToBlob({ type: 'image/png' }), {
      kind: 'image',
      name: 'gradient.png',
      origin: { type: 'generated' },
    })
    const base = model.createProject({ name: 'looks' })
    base.assets[image.id] = image
    const img = model.createImageClip({
      trackId: base.tracks[0].id,
      assetId: image.id,
      start: 0,
      duration: 4,
    })
    img.fit = 'stretch'
    base.clips[img.id] = img
    const textTrack = model.createTrack('visual', 'Lyrics')
    base.tracks.unshift(textTrack)
    const text = model.createTextClip({ trackId: textTrack.id, text: 'Night', start: 0, duration: 4 })
    base.clips[text.id] = text
    const { compositor } = testing.createCompositor('export', W, H)
    const grab = async (p: unknown) => {
      await compositor.render(p, 1)
      return testing.readPixels(compositor.canvas, W, H)
    }
    const reference = await grab(base)
    const out: Record<string, number> = {}
    for (const look of plugins.looks.lookRegistry.list()) {
      const editor = new model.ProjectEditor(structuredClone(base))
      plugins.looks.applyLook(editor, look.id)
      const pixels = await grab(editor.getProject())
      let diff = 0
      for (let i = 0; i < pixels.length; i += 4)
        diff +=
          Math.abs(pixels[i] - reference[i]) +
          Math.abs(pixels[i + 1] - reference[i + 1]) +
          Math.abs(pixels[i + 2] - reference[i + 2])
      out[look.id] = diff / (pixels.length / 4) / 3
    }
    compositor.dispose()
    return out
  })
  console.log('look mean pixel change', JSON.stringify(r))
  expect(Object.keys(r)).toHaveLength(12)
  for (const [id, diff] of Object.entries(r)) expect(diff, id).toBeGreaterThan(1)
  expect(errors).toEqual([])
})
