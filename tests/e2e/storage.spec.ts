import path from 'node:path'
import type { Page } from '@playwright/test'
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

/** The asset folders ("media/<id>") in the profile's browser storage. */
function mediaFolderNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const media = await root.getDirectoryHandle('media').catch(() => null)
    const names: string[] = []
    if (media) for await (const name of media.keys()) names.push(name)
    return names.sort()
  })
}

/** A file in a folder no project names, as a project file open leaves when its tab closes part way. */
function leaveFileBehind(page: Page, folder: string): Promise<void> {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory()
    const media = await root.getDirectoryHandle('media', { create: true })
    const dir = await media.getDirectoryHandle(name, { create: true })
    const writable = await (await dir.getFileHandle('song.wav', { create: true })).createWritable()
    await writable.write(new Uint8Array(1000))
    await writable.close()
  }, folder)
}

/** Writes or deletes a record in the projects store directly, as another build or a damaged save might leave it. */
function projectRecord(page: Page, op: 'put' | 'delete', value: unknown): Promise<void> {
  return page.evaluate(
    ([op, value]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('mv-studio')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const tx = open.result.transaction('projects', 'readwrite')
          if (op === 'put') tx.objectStore('projects').put(value)
          else tx.objectStore('projects').delete(value as string)
          tx.onerror = () => reject(tx.error)
          tx.oncomplete = () => {
            open.result.close()
            resolve()
          }
        }
      }),
    [op, value] as const,
  )
}

test('media no kept project uses is deleted once a day old, unless another tab is open or this one was edited', async ({
  page,
}) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'image.png'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  // A kept project with the song. The image is stored but in no project, like a song left on the setup screen.
  const kept = await page.evaluate(async () => {
    const { model, media } = window.mvStudio
    const [song, image] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const editor = new model.ProjectEditor(model.createProject({ name: 'Sweep test' }))
    editor.dispatch({ type: 'asset.add', asset: song })
    await media.projectStore.save(editor.getProject())
    const folder = (a: { storageKey: string }) => a.storageKey.split('/')[1]
    return { song: folder(song), image: folder(image), songSize: song.byteSize as number, imageAsset: image }
  })
  await leaveFileBehind(page, 'left-behind')
  const all = [kept.song, kept.image, 'left-behind'].sort()
  expect(await mediaFolderNames(page)).toEqual(all)
  const sweep = (minAgeMs?: number) =>
    page.evaluate((age) => window.mvStudio.app.persistence.removeUnusedMedia(age), minAgeMs)

  const other = await page.context().newPage()
  await openHarness(other)
  expect(await sweep(0)).toBeNull()
  expect(await mediaFolderNames(page)).toEqual(all)
  await other.close()
  // Alone again, but the files are new: they may be writes not saved into a project yet.
  await expect.poll(() => sweep()).toBe(0)
  expect(await mediaFolderNames(page)).toEqual(all)

  // A kept project that can't be read could use any folder.
  await projectRecord(page, 'put', { id: 'broken', name: 'Broken' })
  expect(await sweep(0)).toBeNull()
  expect(await mediaFolderNames(page)).toEqual(all)
  await projectRecord(page, 'delete', 'broken')

  // The open project uses the image without being kept (an edit that isn't the user's, so it isn't saved).
  await page.evaluate(
    (asset) =>
      window.mvStudio.app.persistence.untracked(() =>
        window.mvStudio.app.project.editor.dispatch({ type: 'asset.add', asset }, { history: 'skip' }),
      ),
    kept.imageAsset,
  )
  expect(await sweep(0)).toBe(1)
  expect(await mediaFolderNames(page)).toEqual([kept.song, kept.image].sort())
  expect(
    await page.evaluate(async () =>
      (await window.mvStudio.media.projectStore.list()).map((s: { name: string }) => s.name),
    ),
  ).toEqual(['Sweep test'])
  const songSize = await page.evaluate(async () => {
    const [summary] = await window.mvStudio.media.projectStore.list()
    const project = await window.mvStudio.media.projectStore.load(summary.id)
    const song = Object.values(project.assets as Record<string, { kind: string }>).find(
      (a) => a.kind === 'audio',
    )
    return (await window.mvStudio.media.mediaStore.getFile(song)).size
  })
  expect(songSize).toBe(kept.songSize)

  // After an edit in this tab, undo could bring back media the edit removed.
  await leaveFileBehind(page, 'left-behind')
  await page.evaluate(() =>
    window.mvStudio.app.project.editor.dispatch({ type: 'project.rename', name: 'Edited' }),
  )
  expect(await sweep(0)).toBeNull()
  expect(await mediaFolderNames(page)).toEqual([kept.song, kept.image, 'left-behind'].sort())
})

test('a project file open that reuses media already stored keeps it when unused media is swept meanwhile', async ({
  page,
}) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'image.png'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  // A tab closed part way through opening this project's file left the song stored, used by no kept project.
  const song = await page.evaluate(async () => {
    const { model, media } = window.mvStudio
    const [song, image] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const editor = new model.ProjectEditor(model.createProject({ name: 'Reopened' }))
    editor.dispatch([
      { type: 'asset.add', asset: song },
      { type: 'asset.add', asset: image },
    ])
    const project = editor.getProject()
    await media.projectStore.save(project)
    const portable = new Blob([await (await media.projectStore.exportPortable(project)).arrayBuffer()])
    Object.assign(window, { portable })
    const songData = new Blob([await (await media.mediaStore.getFile(song)).arrayBuffer()])
    await media.projectStore.remove(project.id)
    await media.mediaStore.restore(song, songData)
    return song as { name: string; byteSize: number; storageKey: string }
  })
  await page.waitForTimeout(2500)

  // A sweep runs just before the open saves its project, with 2 s standing in for a day.
  const swept = await page.evaluate(async () => {
    const { app, media } = window.mvStudio
    const proto = Object.getPrototypeOf(media.projectStore) as { save: (...args: unknown[]) => Promise<void> }
    const save = proto.save
    let result: number | null | undefined
    proto.save = async function (this: unknown, ...args: unknown[]) {
      if ((args[0] as { name: string }).name === 'Reopened') {
        proto.save = save
        result = await app.persistence.removeUnusedMedia(2000)
      }
      return save.apply(this, args)
    }
    const portable = (window as unknown as { portable: Blob }).portable
    await app.persistence.importProjectFile(new File([portable], 'Reopened.mvstudio'))
    return result
  })
  expect(swept).toBeNull()
  await expect(page.getByRole('button', { name: 'Project: Reopened' })).toBeVisible()
  const size = await page.evaluate(
    async (asset) => (await window.mvStudio.media.mediaStore.getFile(asset)).size,
    song,
  )
  expect(size).toBe(song.byteSize)
})

test('the sweep keeps media a kept project’s saved undo history can bring back, and runs with that history open', async ({
  page,
}) => {
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'image.png')])
  // A kept project the image was added to and then removed from, saved with that undo history.
  const kept = await page.evaluate(async () => {
    const { model, media } = window.mvStudio
    const image = await media.mediaStore.importFile(window.mvStudio.files()[0])
    const editor = new model.ProjectEditor(model.createProject({ name: 'History test' }))
    editor.dispatch({ type: 'asset.add', asset: image })
    editor.dispatch({ type: 'asset.remove', assetId: image.id })
    const project = editor.getProject()
    await media.projectStore.save(project, undefined, undefined, editor.savedHistory())
    return { id: project.id as string, folder: image.storageKey.split('/')[1] as string, image }
  })
  await leaveFileBehind(page, 'left-behind')
  // Opened with its history, which the editor can undo: no edit has been made in this tab.
  expect(await page.evaluate((id) => window.mvStudio.app.persistence.openStoredProject(id), kept.id)).toBe(
    true,
  )
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.canUndo())).toBe(true)

  expect(await page.evaluate(() => window.mvStudio.app.persistence.removeUnusedMedia(0))).toBe(1)
  expect(await mediaFolderNames(page)).toEqual([kept.folder])
  await page.evaluate(() => window.mvStudio.app.project.editor.undo())
  expect(
    await page.evaluate(
      async (asset) => (await window.mvStudio.media.mediaStore.getFile(asset)).size,
      kept.image,
    ),
  ).toBe(kept.image.byteSize)
})
