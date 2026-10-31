import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('a music reaction moves the picture on the beat, identically in preview and export', async ({
  page,
}) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { media, model, plugins, testing } = window.mvStudio
    const image = await media.mediaStore.storeBlob(await plugins.preview.sampleSceneBlob(), {
      kind: 'image',
      name: 'scene.png',
      origin: { type: 'generated' },
    })
    const W = 320
    const H = 180
    const exp = testing.createCompositor('export', W, H)
    const pre = testing.createCompositor('preview', W, H)
    const render = async (c: typeof exp, p: Project, t: number) => {
      await c.compositor.render(p, t)
      return testing.readPixels(c.compositor.canvas, W, H)
    }
    const meanDiff = (a: Uint8Array, b: Uint8Array) => {
      let sum = 0
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
      return sum / a.length
    }
    const maxDiff = (a: Uint8Array, b: Uint8Array) => {
      let max = 0
      for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!))
      return max
    }
    // The vignette effect has no music mapping of its own, so any beat-to-beat change comes from the reaction.
    const { project }: { project: Project } = plugins.preview.pluginPreview('vignette', { image })
    const editor = new model.ProjectEditor(project)
    const clips: Project['clips'][string][] = Object.values(project.clips)
    const clip = clips.find((c) => c.type === 'image')!
    const effectId = clip.type === 'image' ? clip.effects[0]!.id : ''
    const still = {
      onBeat: await render(exp, editor.getProject(), 2.02),
      offBeat: await render(exp, editor.getProject(), 2.3),
    }
    plugins.reactions.applyReaction(
      editor,
      [{ clipId: clip.id, effectInstanceId: effectId, param: 'amount' }],
      'beat',
      {
        amount: 0.8,
      },
    )
    const p = editor.getProject()
    const onBeat = await render(exp, p, 2.02)
    const offBeat = await render(exp, p, 2.3)
    const onBeatPreview = await render(pre, p, 2.02)
    const offBeatPreview = await render(pre, p, 2.3)
    exp.compositor.dispose()
    pre.compositor.dispose()
    return {
      stillDiff: meanDiff(still.onBeat, still.offBeat),
      reactiveDiff: meanDiff(onBeat, offBeat),
      previewVsExport: [maxDiff(onBeat, onBeatPreview), maxDiff(offBeat, offBeatPreview)],
      summary: plugins.reactions.describeReaction(p, {
        clipId: clip.id,
        effectInstanceId: effectId,
        param: 'amount',
      })?.summary,
    }
  })
  console.log('reaction render', JSON.stringify(r))
  expect(r.summary).toBe('Beat · 80%')
  expect(r.stillDiff).toBeLessThan(0.5)
  expect(r.reactiveDiff).toBeGreaterThan(4)
  expect(r.previewVsExport).toEqual([0, 0])
})
