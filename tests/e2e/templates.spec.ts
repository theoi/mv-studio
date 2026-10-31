import type { Asset, Project } from '../../src/model/types.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('starter templates render their visuals, identically in preview and export', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { plugins, testing } = window.mvStudio
    const song: Asset = {
      id: 'song',
      kind: 'audio',
      name: 'neon-skyline.wav',
      mimeType: 'audio/wav',
      byteSize: 1,
      storageKey: 'song',
      duration: 8,
      origin: { type: 'import' },
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const analysis = plugins.preview.sampleAnalysis('song', 8)
    const W = 320
    const H = 180
    const exp = testing.createCompositor('export', W, H)
    const pre = testing.createCompositor('preview', W, H)
    const stats = async (p: Project, t: number) => {
      await exp.compositor.render(p, t)
      const a = testing.readPixels(exp.compositor.canvas, W, H)
      await pre.compositor.render(p, t)
      const b = testing.readPixels(pre.compositor.canvas, W, H)
      let lit = 0
      let diff = 0
      for (let i = 0; i < a.length; i += 4) {
        if (a[i]! + a[i + 1]! + a[i + 2]! > 120) lit++
        for (let c = 0; c < 4; c++) diff = Math.max(diff, Math.abs(a[i + c]! - b[i + c]!))
      }
      return { lit: lit / (W * H), diff }
    }
    const out: Record<string, { lit: number; diff: number }> = {}
    for (const style of plugins.templates.VISUALIZER_STYLES)
      out[`visualizer/${style.id}`] = await stats(
        plugins.templates.createFromTemplate('visualizer', { song, analysis, visualizerStyle: style.id }),
        2.04,
      )
    // Lyric video with one line timed: the background and the karaoke-styled line.
    const editor = new window.mvStudio.model.ProjectEditor(
      plugins.templates.createFromTemplate('lyric', { song, analysis, lyrics: 'Under the neon skyline' }),
    )
    const line = editor.getProject().lyrics!.lines[0]!
    editor.dispatch({
      type: 'lyrics.updateLine',
      lineId: line.id,
      patch: { start: 1, end: 4, words: [{ text: 'Under', start: 1, end: 1.5 }] },
    })
    editor.dispatch(plugins.templates.templateCommands(editor.getProject()))
    out.lyric = await stats(editor.getProject(), 2.5)
    const lyricFrame = testing.readPixels(exp.compositor.canvas, W, H)
    const tracks: Project['tracks'] = editor.getProject().tracks
    const lyrics = tracks.find((t) => t.name === 'Lyrics')!
    editor.dispatch({ type: 'track.update', trackId: lyrics.id, patch: { hidden: true } })
    await exp.compositor.render(editor.getProject(), 2.5)
    const withoutLyrics = testing.readPixels(exp.compositor.canvas, W, H)
    let textDiff = 0
    for (let i = 0; i < lyricFrame.length; i++) textDiff += Math.abs(lyricFrame[i]! - withoutLyrics[i]!)
    out['lyric/text'] = { lit: textDiff / lyricFrame.length, diff: 0 }
    out.footage = await stats(plugins.templates.createFromTemplate('footage', { song, analysis }), 1.5)
    exp.compositor.dispose()
    pre.compositor.dispose()
    return out
  })
  console.log('templates', JSON.stringify(r))
  for (const [id, s] of Object.entries(r)) expect(s.diff, `${id} preview equals export`).toBe(0)
  for (const id of [
    'visualizer/spectrum',
    'visualizer/ring',
    'visualizer/particles',
    'visualizer/shader-flow',
  ])
    expect(r[id]!.lit, `${id} draws`).toBeGreaterThan(0.01)
  expect(r['lyric/text']!.lit, 'the timed line shows over the background').toBeGreaterThan(0.5)
  expect(r.footage!.lit, 'the song title shows').toBeGreaterThan(0.005)
  expect(errors).toEqual([])
})
