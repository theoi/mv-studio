import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'
import type { LyricsDoc } from '../../src/model/types.ts'

interface Estimate {
  separatesStems: boolean
  downloads: { name: string }[]
  seconds: number
}

interface LyricsRun {
  songId: string
  estimate: Estimate
  estimateAfter: Estimate
  pasted: LyricsDoc
  dragged?: LyricsDoc
  draft: { doc: LyricsDoc; language: string }
  alignMs: number
  realignMs: number
  transcribeMs: number
}

// speech.wav: two synthesized phrases, the first from 1.23 s to 2.86 s and the second from 6.21 s to 8.36 s.
test('times pasted lyrics on the vocals stem, re-aligns a dragged word and drafts lyrics with Whisper', async ({
  page,
}) => {
  test.setTimeout(300_000)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', path.join(FIXTURE_DIR, 'speech.wav'))

  const r: LyricsRun = await page.evaluate(async () => {
    const { analysis, media, model, files } = window.mvStudio
    const song = await media.mediaStore.importFile(files()[0])
    const editor = new model.ProjectEditor(model.createProject())
    editor.dispatch({ type: 'asset.add', asset: song })
    // The speech is its own vocals stem, so no separation runs.
    editor.dispatch(
      { type: 'analysis.setStems', assetId: song.id, stems: { vocals: song.id }, stemFeatures: {} },
      { history: 'skip' },
    )
    const service = new analysis.LyricsService()
    const deps = { editor, store: media.mediaStore }
    const estimate = await service.estimate(editor.getProject(), song.id, { kind: 'draft', size: 'base' })
    const t0 = performance.now()
    const text = '[Verse]\nWe were young and the night was long\n\nHold on tight, we are almost there\n'
    const pasted = (await service.run(song.id, { kind: 'time', text }, deps).promise).doc
    const t1 = performance.now()
    const dragged = service.realignFrom(pasted, 1, 1, 7)
    const t2 = performance.now()
    const draft = await service.run(song.id, { kind: 'draft', size: 'base' }, deps).promise
    const t3 = performance.now()
    const estimateAfter = await service.estimate(editor.getProject(), song.id, {
      kind: 'draft',
      size: 'base',
    })
    return {
      songId: song.id,
      estimate,
      estimateAfter,
      pasted,
      dragged,
      draft,
      alignMs: t1 - t0,
      realignMs: t2 - t1,
      transcribeMs: t3 - t2,
    }
  })

  test.info().annotations.push({
    type: 'lyrics',
    description: `align ${Math.round(r.alignMs)} ms, re-align ${Math.round(r.realignMs)} ms, transcribe ${Math.round(r.transcribeMs)} ms`,
  })
  // The song has a vocals stem, so nothing is separated; once both runs downloaded their models, none is left.
  expect(r.estimate.separatesStems).toBe(false)
  expect(r.estimate.downloads.map((d) => d.name)).not.toContain('HTDemucs stem separator')
  expect(r.estimate.seconds).toBeGreaterThan(5)
  expect(r.estimateAfter.downloads).toEqual([])
  expect(r.estimateAfter.seconds).toBe(r.estimate.seconds)
  const [first, second] = r.pasted.lines
  expect(r.pasted.source).toBe('pasted')
  expect(r.pasted.audioAssetId).toBe(r.songId)
  expect(r.pasted.lines.map((l) => l.words.length)).toEqual([8, 7])
  expect(Math.abs((first?.start ?? 0) - 1.23)).toBeLessThan(0.15)
  expect(Math.abs((second?.start ?? 0) - 6.21)).toBeLessThan(0.15)
  expect(first?.end).toBeLessThan(3.5)
  for (const line of r.pasted.lines)
    for (let i = 1; i < line.words.length; i++)
      expect(line.words[i]?.start).toBeGreaterThanOrEqual(line.words[i - 1]?.end ?? Infinity)

  // Dragging "on" to 7 s keeps everything before it and moves the rest of the line after it.
  expect(r.dragged?.lines[0]).toEqual(first)
  expect(r.dragged?.lines[1]?.words[0]).toEqual(second?.words[0])
  expect(r.dragged?.lines[1]?.words[1]?.start).toBe(7)
  expect(r.dragged?.lines[1]?.words[2]?.start).toBeGreaterThan(7)

  expect(r.draft.language).toBe('en')
  expect(r.draft.doc.source).toBe('transcribed')
  const words = r.draft.doc.lines.flatMap((l) => l.words)
  const text = words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ''))
  for (const w of ['young', 'night', 'long', 'tight', 'almost', 'there']) expect(text).toContain(w)
  const tight = words[text.indexOf('tight')]
  expect(tight?.start).toBeGreaterThan(6.2)
  expect(tight?.start).toBeLessThan(7.6)
  expect(r.draft.doc.lines.length).toBeGreaterThanOrEqual(2)
})
