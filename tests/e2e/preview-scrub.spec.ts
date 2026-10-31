import { expect, openHarness, test } from './fixtures.ts'

/**
 * The main-thread preview draws on the page's own thread. A drag there has to draw smaller frames when a full-size
 * frame takes longer than a display frame, or every step holds up the page and the next step.
 */
test('a drag on the main-thread preview draws smaller frames and settles at full size', async ({ page }) => {
  await openHarness(page)
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : ''
  })
  // On a real GPU a full-size frame of this project fits in a display frame, so drags rightly stay at full size.
  test.skip(!/SwiftShader/i.test(gpu), `needs software GL (headless Chromium in CI), not ${gpu}`)
  const r = await page.evaluate(async () => {
    const { model, media, engine } = window.mvStudio
    const p = model.createProject({ name: 'scrub' })
    const solid = model.createSolidClip({ trackId: p.tracks[0].id, color: '#3366ff', start: 0, duration: 4 })
    solid.effects.push(
      { id: 'fx1', effectId: 'glow', enabled: true, params: { radius: 80, threshold: 0.1 } },
      { id: 'fx2', effectId: 'blur', enabled: true, params: { radius: 60 } },
      { id: 'fx3', effectId: 'film-grain', enabled: true, params: {} },
      { id: 'fx4', effectId: 'rgb-split', enabled: true, params: {} },
    )
    const title = model.createTextClip({ trackId: p.tracks[0].id, text: 'SCRUB', start: 0, duration: 4 })
    p.clips[solid.id] = solid
    p.clips[title.id] = title

    const preview = new engine.PreviewController({
      canvas: document.createElement('canvas'),
      media: media.mediaStore,
      renderer: 'main',
    })
    preview.setViewport(1280, 720, 1)
    preview.setProject(p)
    await preview.rendered()
    const idle = () => new Promise((resolve) => setTimeout(resolve, 300))
    await idle()

    // One step of a drag: an edit, then the next one as soon as its frame is drawn, as pointer events queued during
    // a blocking draw arrive.
    let x = 0.5
    const step = async () => {
      x += 0.01
      const drawn = new Promise<void>((resolve) => {
        const off = preview.onFrame(() => {
          off()
          resolve()
        })
      })
      const started = performance.now()
      preview.setProject({
        ...p,
        clips: { ...p.clips, [title.id]: { ...title, transform: { ...title.transform, x: { value: x } } } },
      })
      await drawn
      const ms = performance.now() - started
      await new Promise((resolve) => setTimeout(resolve, 0))
      const s = preview.stats()
      return { ms, width: s.width, height: s.height }
    }
    const first = await step()
    const drag: { ms: number; width: number; height: number }[] = []
    for (let i = 0; i < 6; i++) drag.push(await step())
    await idle()
    const settled = preview.stats()

    // rendered() does not wait for the drag to settle by itself: it draws the settled frame at once.
    await step()
    await step()
    await preview.rendered()
    const awaited = preview.stats()
    preview.dispose()
    return {
      first,
      drag,
      settled: [settled.width, settled.height],
      awaited: [awaited.width, awaited.height],
    }
  })
  console.log('main-thread scrub', JSON.stringify(r))
  expect([r.first.width, r.first.height]).toEqual([1280, 720])
  // A draw finishes when the GPU has drawn the frame. Headless Chromium draws WebGL in software, so a full-size frame
  // of this project takes far longer than a display frame and the drag has to draw smaller to keep up.
  expect(r.first.ms, 'a full-size still takes its GPU time').toBeGreaterThan(30)
  for (const s of r.drag) {
    expect(s.width).toBeLessThan(1280)
    expect(s.width / s.height).toBeCloseTo(16 / 9, 1)
  }
  const dragMs = r.drag.reduce((a, s) => a + s.ms, 0) / r.drag.length
  expect(dragMs).toBeLessThan(r.first.ms)
  expect(r.settled).toEqual([1280, 720])
  expect(r.awaited).toEqual([1280, 720])
})
