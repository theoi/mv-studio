import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

test('imports media into OPFS, saves and reloads projects, and round-trips a portable project file', async ({
  page,
}) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'song.wav', 'clip.mp4', 'image.png'].map((f) => path.join(FIXTURE_DIR, f)),
  )

  const result = await page.evaluate(async () => {
    const { model, media } = window.mvStudio
    const assets = []
    for (const file of window.mvStudio.files()) assets.push(await media.mediaStore.importFile(file))
    const [song, wav, clip, image] = assets
    const project = model.createProject({ name: 'Storage test' })
    const editor = new model.ProjectEditor(project)
    const visual = project.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const audio = project.tracks.find((t: { kind: string }) => t.kind === 'audio')
    editor.dispatch([
      ...assets.map((asset: unknown) => ({ type: 'asset.add', asset })),
      { type: 'project.setSong', assetId: song.id },
      {
        type: 'clip.add',
        clip: model.createAudioClip({
          trackId: audio.id,
          assetId: song.id,
          start: 0,
          duration: song.duration,
        }),
      },
      {
        type: 'clip.add',
        clip: model.createVideoClip({ trackId: visual.id, assetId: clip.id, start: 0, duration: 4 }),
      },
    ])
    await media.projectStore.save(editor.getProject())
    const listed = await media.projectStore.list()
    const loaded = await media.projectStore.load(project.id)

    // The portable Blob references OPFS files lazily; copy it before deleting the media it points to.
    const portable = new Blob([await (await media.projectStore.exportPortable(loaded)).arrayBuffer()])
    const originalSizes = await Promise.all(
      assets.map(async (a: unknown) => (await media.mediaStore.getFile(a)).size),
    )
    await media.projectStore.remove(project.id)
    const mediaGone = await Promise.all(
      assets.map((a: unknown) =>
        media.mediaStore.getFile(a).then(
          () => false,
          () => true,
        ),
      ),
    )
    const imported = await media.projectStore.importPortable(new File([portable], 'test.mvstudio'))
    const restoredSizes = await Promise.all(
      Object.values(imported.assets).map(async (a: unknown) => (await media.mediaStore.getFile(a)).size),
    )
    return {
      song: {
        kind: song.kind,
        duration: song.duration,
        sampleRate: song.sampleRate,
        channels: song.channels,
      },
      wav: { kind: wav.kind, duration: wav.duration },
      clip: {
        kind: clip.kind,
        width: clip.width,
        height: clip.height,
        frameRate: clip.frameRate,
        hasAudio: clip.hasAudio,
        duration: clip.duration,
      },
      image: { kind: image.kind, width: image.width, height: image.height },
      listedNames: listed.map((s: { name: string }) => s.name),
      loadedClipCount: Object.keys(loaded.clips).length,
      loadedSong: loaded.songAssetId === song.id,
      portableBytes: portable.size,
      mediaGone,
      importedName: imported.name,
      originalSizes,
      restoredSizes,
      reloaded: (await media.projectStore.list()).map((s: { name: string }) => s.name),
    }
  })

  expect(result.song).toMatchObject({ kind: 'audio', sampleRate: 44100, channels: 2 })
  expect(result.song.duration).toBeCloseTo(8, 0)
  expect(result.wav.kind).toBe('audio')
  expect(result.wav.duration).toBeCloseTo(8, 1)
  expect(result.clip).toMatchObject({ kind: 'video', width: 640, height: 360, hasAudio: true })
  expect(result.clip.frameRate).toBeCloseTo(30, 0)
  expect(result.clip.duration).toBeCloseTo(4, 1)
  expect(result.image).toMatchObject({ kind: 'image', width: 640, height: 360 })
  expect(result.listedNames).toEqual(['Storage test'])
  expect(result.loadedClipCount).toBe(2)
  expect(result.loadedSong).toBe(true)
  expect(result.mediaGone).toEqual([true, true, true, true])
  expect(result.importedName).toBe('Storage test')
  expect(result.restoredSizes).toEqual(result.originalSizes)
  expect(result.portableBytes).toBeGreaterThan(
    result.originalSizes.reduce((a: number, b: number) => a + b, 0),
  )
  expect(result.reloaded).toEqual(['Storage test'])
})

test('rejects unsupported files with a typed error', async ({ page }) => {
  await openHarness(page)
  const error = await page.evaluate(async () => {
    try {
      await window.mvStudio.media.mediaStore.importFile(
        new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      )
      return null
    } catch (e) {
      return { name: (e as Error).name, code: (e as { code?: string }).code }
    }
  })
  expect(error).toEqual({ name: 'JobError', code: 'unsupported' })
})

test('reads a song’s title and artist tags from MP3 and M4A files, trimmed', async ({ page }) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['tagged.mp3', 'tagged.m4a', 'song.mp3'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const tags = await page.evaluate(async () => {
    const assets = []
    for (const file of window.mvStudio.files())
      assets.push(await window.mvStudio.media.mediaStore.importFile(file))
    return assets.map((a) => ({ name: a.name, tags: a.tags }))
  })
  expect(tags).toEqual([
    { name: 'tagged.mp3', tags: { title: 'Neon Skyline', artist: 'The Night Shift' } },
    { name: 'tagged.m4a', tags: { title: 'Neon Skyline', artist: 'The Night Shift' } },
    // No tags: no field at all, as in projects saved before tags were read.
    { name: 'song.mp3', tags: undefined },
  ])
})

test('imports an audio-only WebM recording as audio even when typed video/webm', async ({ page }) => {
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'voice.webm')])
  const asset = await page.evaluate(async () => {
    const file = window.mvStudio.files()[0] as File
    // Browsers type .webm files video/webm whatever they contain.
    const typed = new File([file], 'voice.webm', { type: 'video/webm' })
    const a = await window.mvStudio.media.mediaStore.importFile(typed)
    return { kind: a.kind, mimeType: a.mimeType, duration: a.duration, hasAudio: a.hasAudio, width: a.width }
  })
  expect(asset).toMatchObject({ kind: 'audio', hasAudio: true })
  expect(asset.mimeType).toMatch(/^audio\/webm/)
  expect(asset.width).toBeUndefined()
  expect(asset.duration).toBeCloseTo(2, 1)
})
