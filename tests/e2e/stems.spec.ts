import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('separates stems in a worker, stores them as assets and measures each stem', async ({ page }) => {
  test.setTimeout(300_000)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', path.join(FIXTURE_DIR, 'song.mp3'))

  const r = await page.evaluate(async () => {
    const { analysis, media, model, files } = window.mvStudio
    const file = files()[0]
    const song = await media.mediaStore.importFile(file)
    const audio = await analysis.decodeAudioFile(file)
    const t0 = performance.now()
    const result = await new analysis.StemSeparationService().separate(audio).promise
    const ms = performance.now() - t0
    const editor = new model.ProjectEditor(model.createProject())
    const commands = await analysis.stemEdits(
      result,
      song,
      { assetId: song.id, version: 'e2e' },
      media.mediaStore,
    )
    editor.dispatch([{ type: 'asset.add', asset: song }, ...commands])
    const project = editor.getProject()
    const stems: Record<string, string> = project.analysis.audio[song.id].stems
    const drumsFile = await media.mediaStore.getFile(project.assets[stems.drums])
    const drums = await analysis.decodeAudioFile(drumsFile)
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]
    return {
      ms,
      device: result.device,
      separateSeconds: result.seconds,
      stemNames: Object.keys(stems).sort(),
      stemKinds: Object.values(stems).map((id) => project.assets[id].kind),
      stemDuration: project.assets[stems.drums].duration,
      stemBytes: drumsFile.size,
      drumsSeconds: drums.channels[0].length / drums.sampleRate,
      drumOnsets: result.stemFeatures.drums.onsets.length,
      vocalsLoudness: median(result.stemFeatures.vocals.loudness),
      drumsLoudness: median(result.stemFeatures.drums.loudness),
    }
  })

  test.info().annotations.push({
    type: 'stem separation',
    description: `${Math.round(r.ms)} ms total, ${r.separateSeconds.toFixed(1)} s separating 8 s on ${r.device}`,
  })
  expect(r.stemNames).toEqual(['bass', 'drums', 'other', 'vocals'])
  expect(r.stemKinds).toEqual(['audio', 'audio', 'audio', 'audio'])
  expect(r.stemDuration).toBeCloseTo(8, 0)
  expect(r.drumsSeconds).toBeGreaterThan(7.9)
  expect(r.drumsSeconds).toBeLessThan(8.2)
  // The fixture is a kick every 0.5 s over a pad, with no voice.
  expect(r.drumOnsets).toBeGreaterThan(10)
  expect(r.drumsLoudness).toBeGreaterThan(r.vocalsLoudness + 0.3)
})
