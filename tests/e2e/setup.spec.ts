import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * The setup screen makes a real project: the chosen song is copied into browser storage and analyzed, and the editor
 * opens on the kind's starter template with the song, the pasted lyrics, the visualizer style or the clips.
 */

interface Opened {
  id: string
  name: string
  tracks: string[]
  song: string | undefined
  bpm: number | undefined
  assets: string[]
  lyrics: { text: string; timed: boolean }[]
  lyricClips: number
  generators: string[]
  /** The selected clip's generator, or its type. */
  selected: string | null
  panel: string
}

function opened(page: Page): Promise<Opened> {
  return page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    const ui = window.mvStudio.app.ui.get()
    const clips = Object.values(p.clips) as {
      type: string
      generatorId?: string
      lyricLineId?: string
      id: string
    }[]
    return {
      id: p.id,
      name: p.name,
      tracks: p.tracks.map((t: { name: string }) => t.name),
      song: p.songAssetId ? p.assets[p.songAssetId]?.name : undefined,
      bpm: p.songAssetId ? p.analysis.audio[p.songAssetId]?.tempo?.bpm : undefined,
      assets: Object.values(p.assets as Record<string, { name: string }>)
        .map((a) => a.name)
        .sort(),
      lyrics: (p.lyrics?.lines ?? []).map((l: { text: string; words: unknown[] }) => ({
        text: l.text,
        timed: l.words.length > 0,
      })),
      lyricClips: clips.filter((c) => c.type === 'text' && c.lyricLineId).length,
      generators: clips
        .flatMap((c) => (c.type === 'generator' && c.generatorId ? [c.generatorId] : []))
        .sort(),
      selected:
        ui.selection.type === 'clip'
          ? ((p.clips[ui.selection.id] as { generatorId?: string; type: string } | undefined)?.generatorId ??
            null)
          : null,
      panel: ui.rightTab === 'assist' ? `assist:${ui.assistView}` : ui.rightTab,
    }
  })
}

async function startKind(page: Page, kind: RegExp) {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: kind }).click()
}

const fixture = (name: string) => path.join(FIXTURE_DIR, name)

/** A stand-in for stem separation and the aligner (about 280 MB of models); `finishLyrics()` lands timed lines. */
async function fakeLyrics(page: Page) {
  await page.evaluate(() => {
    const { app, shared } = window.mvStudio
    const w = window as unknown as { finishLyrics?: () => void }
    app.lyrics.setLyricsServiceForTests({
      async estimate() {
        return {
          separatesStems: true,
          downloads: [{ name: 'Stems and aligner', bytes: 275_821_162 }],
          downloadBytes: 275_821_162,
          seconds: 230,
        }
      },
      run(songId: string, request: { text: string }) {
        return shared.jobs.run({
          kind: 'analysis.lyrics',
          title: 'Timing lyrics',
          run: (ctx: { progress: (p: object) => void }) =>
            new Promise((resolve) => {
              ctx.progress({ fraction: 0.4, stage: 'align', message: 'Timing words' })
              w.finishLyrics = () => {
                const lines = request.text
                  .split('\n')
                  .filter((t: string) => t.trim())
                  .map((text: string, i: number) => ({
                    id: `timed-${i}`,
                    text: text.trim(),
                    start: 1 + i * 2,
                    end: 2.5 + i * 2,
                    words: [{ text: text.trim(), start: 1 + i * 2, end: 2.5 + i * 2 }],
                  }))
                resolve({ doc: { audioAssetId: songId, source: 'pasted', lines } })
              }
            }),
        })
      },
    })
  })
}

/** A WAV file of silence, which has no beat to find. */
function silentWav(seconds: number): Buffer {
  const rate = 8000
  const data = rate * seconds * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + data, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(data, 40)
  return b
}

test('a lyric video from a song file and pasted lyrics is analyzed, timed, kept and reopened', async ({
  page,
}) => {
  await startKind(page, /Lyric video/)
  await fakeLyrics(page)
  await expect(page.getByRole('button', { name: 'Open the editor' })).toBeDisabled()
  await page.getByLabel('Song file').setInputFiles(fixture('song.wav'))
  const status = page.getByRole('status')
  await expect(status.getByText(/^\d+ BPM$/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('song · WAV · ', { exact: false })).toBeVisible()
  // With a song on the card, Skip for now would drop it, so it is gone.
  await expect(page.getByRole('button', { name: 'Skip for now' })).toHaveCount(0)
  await page.getByLabel('Lyrics').fill('Hello night\n\nNeon lights  ')
  // Pasted lyrics are timed on open, and the cost is said first.
  const time = page.getByRole('button', { name: 'Time my lyrics' })
  await expect(
    page.getByText('Separates the vocals first · 276 MB download, once · about 4 min on this device'),
  ).toBeVisible()
  await time.click()

  await waitForPreview(page)
  await expect(page).toHaveURL(/#\/editor\?.*project=/)
  const project = await opened(page)
  expect(project).toMatchObject({
    name: 'song',
    tracks: ['Lyrics', 'Look', 'Background', 'Song'],
    song: 'song.wav',
    assets: ['song.wav'],
    lyrics: [
      { text: 'Hello night', timed: false },
      { text: 'Neon lights', timed: false },
    ],
  })
  expect(project.bpm).toBeGreaterThan(0)
  // Timing runs in Assist › Lyrics, and the timed lines replace the pasted ones.
  expect(project.panel).toBe('assist:lyrics')
  await expect(page.getByText('Timing words to the vocals')).toBeVisible()
  await page.evaluate(() => (window as unknown as { finishLyrics: () => void }).finishLyrics())
  await expect.poll(async () => (await opened(page)).lyrics.every((l) => l.timed)).toBe(true)
  const timed = await opened(page)
  expect(timed.lyrics.map((l) => l.text)).toEqual(['Hello night', 'Neon lights'])

  await page.reload()
  await waitForPreview(page)
  const reopened = await opened(page)
  expect(reopened).toMatchObject({ id: project.id, name: 'song', song: 'song.wav', lyrics: timed.lyrics })
})

test('a visualizer with the sample song uses the chosen style and opens on its visualizer', async ({
  page,
}) => {
  await startKind(page, /^Visualizer/)
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await expect(page.getByText('Chorus at 1:04')).toBeVisible()
  // The song card replaces the buttons, so focus moves to its Replace button.
  await expect(page.getByRole('button', { name: 'Replace' })).toBeFocused()
  // The styles are one radio group: one Tab stop, arrow keys move the choice.
  const spectrum = page.getByRole('radio', { name: 'Spectrum' })
  await spectrum.focus()
  await page.keyboard.press('ArrowRight')
  await expect(spectrum).not.toBeChecked()
  await expect(page.getByRole('radio', { checked: true })).toBeFocused()
  await expect(page.getByRole('radio', { name: 'Spectrum' })).toHaveAttribute('tabindex', '-1')
  await page.getByRole('radio', { name: 'Particles' }).click()
  await expect(page.getByRole('radio', { name: 'Particles' })).toBeChecked()
  await page.getByRole('button', { name: 'Open the editor' }).click()

  await waitForPreview(page)
  const project = await opened(page)
  expect(project).toMatchObject({ name: 'Neon Skyline', song: 'neon-skyline.wav', bpm: 120 })
  expect(project.generators).toContain('visualizer.particles')
  expect(project.generators).not.toContain('visualizer.spectrum')
  expect(project.selected).toBe('visualizer.particles')
  // Template clips are named after their plugin, never by its id.
  await expect(page.getByRole('button', { name: /^Particles, \d/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Nebula, \d/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(visualizer|generator)\./ })).toHaveCount(0)
})

test('a lyric video with the sample song gets its timed lyrics', async ({ page }) => {
  await startKind(page, /Lyric video/)
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await expect(page.getByText('The sample song comes with timed lyrics.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Open the editor' }).click()
  await waitForPreview(page)
  const project = await opened(page)
  expect(project.lyrics.length).toBeGreaterThan(10)
  expect(project.lyrics.every((l) => l.timed)).toBe(true)
  expect(project.lyricClips).toBe(project.lyrics.length)
})

test('beat-cut footage keeps the chosen clips, one can be removed first, and they are cut on open', async ({
  page,
}) => {
  await startKind(page, /Beat-cut footage/)
  // Model-free footage analysis (mean color), so the cut downloads nothing. It waits for __embedGate, so the test
  // decides when the clips are analyzed.
  await page.evaluate(() => {
    const w = window as unknown as { __embedGate: Promise<void>; __releaseEmbed: () => void }
    w.__embedGate = new Promise((resolve) => (w.__releaseEmbed = resolve))
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        await w.__embedGate
        for (const b of bitmaps) b.close()
        return { dim: 2, data: new Float32Array(bitmaps.flatMap(() => [0.6, 0.8])) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        return { dim: 2, data: new Float32Array(texts.flatMap(() => [0.6, 0.8])) }
      },
    }
    window.mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
  })
  await page
    .getByLabel('Clip files')
    .setInputFiles([fixture('clip.mp4'), fixture('image.png'), fixture('song.mp3')])
  const clips = page.getByRole('list', { name: 'Your clips' })
  await expect(clips.getByRole('listitem')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.getByRole('alert')).toHaveText(
    '“song.mp3” isn’t a video clip or image. Add it as your song in step 1.',
  )
  await clips.getByRole('button', { name: 'Remove image.png' }).click()
  await expect(clips.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Cut my clips' })).toBeDisabled()

  // Going back to pick another kind keeps what was given.
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByRole('button', { name: 'All kinds' }).click()
  await page.getByRole('button', { name: /^Visualizer/ }).click()
  await expect(page.getByText('Neon Skyline · WAV', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'All kinds' }).click()
  await page.getByRole('button', { name: /Beat-cut footage/ }).click()
  await expect(clips.getByRole('listitem')).toHaveCount(1)

  await expect(page.getByText(/Runs on this device · free · \d+ MB download, once/)).toBeVisible()
  await page.getByRole('button', { name: 'Cut my clips' }).click()

  await waitForPreview(page)
  const project = await opened(page)
  expect(project.assets).toEqual(['clip.mp4', 'neon-skyline.wav'])
  expect(project.panel).toBe('assist:autocut')
  // The cut first waits for the clips to be analyzed, so it can match them to the mood.
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(assist.getByText('Analyzing your footage… 0 of 1 clip')).toBeVisible()
  const videoClips = () =>
    page.evaluate(
      () =>
        Object.values(
          window.mvStudio.app.project.editor.getProject().clips as Record<string, { type: string }>,
        ).filter((c) => c.type === 'video').length,
    )
  expect(await videoClips()).toBe(0)
  await page.evaluate(() => (window as unknown as { __releaseEmbed: () => void }).__releaseEmbed())
  // Then the clips are cut to the beat without another click, on the template's Video track.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Object.values(
              window.mvStudio.app.project.editor.getProject().clips as Record<string, { type: string }>,
            ).filter((c) => c.type === 'video').length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(1)
  await expect(assist.getByText(/^On the Video track\./)).toBeVisible()
  await expect(assist.getByText(/picked for variety/)).toHaveCount(0)
  const placed = await page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    const video = p.extensions.template.tracks.video as string
    const clips = Object.values(p.clips as Record<string, { type: string; trackId: string }>)
    return {
      offVideo: clips.filter((c) => c.type === 'video' && c.trackId !== video).length,
      autoCutTrack: (p.tracks as { name: string }[]).some((t) => t.name === 'Auto-cut'),
    }
  })
  expect(placed).toEqual({ offVideo: 0, autoCutTrack: false })
})

for (const { failure, error, file, note } of [
  {
    failure: 'stops with an error',
    error: 'Array buffer allocation failed',
    file: 'clip.mp4',
    note: 'Footage analysis ran out of memory, so your clip was picked for variety. Try again in Match footage, then cut again to match the mood.',
  },
  {
    failure: 'can’t read the clip',
    error: 'Corrupt frame',
    file: 'clip.mp4',
    note: '“clip.mp4” couldn’t be analyzed, so it was picked for variety.',
  },
  {
    failure: 'can’t read a clip with a long name',
    error: 'Corrupt frame',
    file: 'my_holiday_footage_from_the_beach_2024_final_version_v2.mp4',
    note: '“my_holiday_foot…_v2.mp4” couldn’t be analyzed, so it was picked for variety.',
  },
])
  test(`when footage analysis ${failure}, Cut my clips still cuts and says why the clips were picked for variety`, async ({
    page,
  }) => {
    // The narrowest editor layout, where the Assist panel's notes have the least room.
    await page.setViewportSize({ width: 1280, height: 720 })
    await startKind(page, /Beat-cut footage/)
    await page.evaluate((message) => {
      const onnx = {
        async embedImages({
          bitmaps,
        }: {
          bitmaps: ImageBitmap[]
        }): Promise<{ dim: number; data: Float32Array }> {
          for (const b of bitmaps) b.close()
          throw new Error(message)
        },
        async embedTexts({ texts }: { texts: string[] }) {
          return { dim: 2, data: new Float32Array(texts.flatMap(() => [0.6, 0.8])) }
        },
      }
      window.mvStudio.app.footage.setVisionBackendsForTests({
        onnx: () => onnx,
        segmentation: () => {
          throw new Error('unused')
        },
      })
    }, error)
    await page
      .getByLabel('Clip files')
      .setInputFiles([{ name: file, mimeType: 'video/mp4', buffer: readFileSync(fixture('clip.mp4')) }])
    await expect(page.getByRole('list', { name: 'Your clips' }).getByRole('listitem')).toHaveCount(1, {
      timeout: 30_000,
    })
    await page.getByRole('button', { name: 'Use a sample song' }).click()
    await page.getByRole('button', { name: 'Cut my clips' }).click()

    await waitForPreview(page)
    const assist = page.getByRole('tabpanel', { name: 'Assist' })
    await expect(assist.getByText(/^On the Video track\./)).toBeVisible({ timeout: 60_000 })
    const shown = assist.getByText(note, { exact: true })
    await expect(shown).toBeVisible()
    await expect(assist.getByText(/analyzed yet/)).toHaveCount(0)
    // The note wraps inside its callout instead of running out of it.
    const overflow = await shown.evaluate((el) => {
      const callout = el.closest('[role="status"]')!.getBoundingClientRect()
      return Math.round(el.getBoundingClientRect().right - callout.right)
    })
    expect(overflow).toBeLessThanOrEqual(0)
    const cut = await page.evaluate(
      () =>
        Object.values(
          window.mvStudio.app.project.editor.getProject().clips as Record<string, { type: string }>,
        ).filter((c) => c.type === 'video').length,
    )
    expect(cut).toBeGreaterThan(1)
  })

test('a file that is not audio is refused as the song, and Skip for now opens the template without one', async ({
  page,
}) => {
  await startKind(page, /Lyric video/)
  await page.getByLabel('Song file').setInputFiles(fixture('image.png'))
  await expect(page.getByRole('alert')).toHaveText(/“image\.png” isn’t an audio file/)
  await expect(page.getByRole('button', { name: 'Open the editor' })).toBeDisabled()

  // A first visit: the guide skips "Your song, mapped" in a project without a song.
  await page.evaluate(() => localStorage.removeItem('mv-studio.guide-seen'))
  await page.getByRole('button', { name: 'Skip for now' }).click()
  const guide = page.getByRole('dialog', { name: 'Getting started guide' })
  await expect(guide.getByText('Add anything')).toBeVisible()
  await expect(guide.getByText('1 of 3')).toBeVisible()
  // Enter presses the focused Next once: one step, not two.
  await page.keyboard.press('Enter')
  await expect(guide.getByText('2 of 3')).toBeVisible()
  await guide.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByText('Start with a song')).toBeVisible()
  const project = await opened(page)
  expect(project).toMatchObject({
    song: undefined,
    tracks: ['Lyrics', 'Look', 'Background', 'Song'],
    assets: [],
  })
  await expect(page).toHaveURL(/project=empty/)
})

test('a song without a beat says no beat was found, as the editor does, and shows no tempo', async ({
  page,
}) => {
  await startKind(page, /Lyric video/)
  await page
    .getByLabel('Song file')
    .setInputFiles({ name: 'quiet.wav', mimeType: 'audio/wav', buffer: silentWav(20) })
  const status = page.getByRole('status').filter({ hasText: 'No beat found' })
  await expect(status).toBeVisible({ timeout: 60_000 })
  // The badge stays once the analysis job has finished, not only between storing the analysis and the job ending.
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.mvStudio.shared.jobs
          .list()
          .some(
            (j: { kind: string; status: string }) => j.kind === 'analysis.song' && j.status === 'succeeded',
          ),
      ),
    )
    .toBe(true)
  await expect(status).toBeVisible()
  await expect(page.getByText(/Couldn’t find the beat/)).toHaveCount(0)
  await expect(page.getByText(/BPM$/)).toHaveCount(0)
})

test('Blank project opens an empty timeline with a video and a song track', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  // The privacy line promises no more than the app keeps: cloud features upload what they work on.
  await expect(page.getByRole('contentinfo')).toHaveText(
    'Runs in your browser. Your songs and footage stay on this device unless you use a cloud feature.',
  )
  await page.getByRole('button', { name: /^Blank project/ }).click()
  await expect(page.getByText('Start with a song')).toBeVisible()
  expect((await opened(page)).tracks).toEqual(['Video 1', 'Song'])
})

test('the Start cards are named by their title and description, not by their preview art', async ({
  page,
}) => {
  await openHarness(page)
  for (const name of [
    'Lyric video Words timed to the vocals, with karaoke and kinetic type.',
    'Visualizer Visuals that move with the beat, bass and vocals.',
    'Beat-cut footage Your clips, cut to the beat and the song’s sections.',
    'AI music video A complete, editable draft from your song and an idea.',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
})
