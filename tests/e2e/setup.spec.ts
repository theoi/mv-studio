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

test('a lyric video from a song file and pasted lyrics is analyzed, kept and reopened', async ({ page }) => {
  await startKind(page, /Lyric video/)
  const open = page.getByRole('button', { name: 'Open the editor' })
  await expect(open).toBeDisabled()
  await page.getByLabel('Song file').setInputFiles(fixture('song.wav'))
  const status = page.getByRole('status')
  await expect(status.getByText(/^\d+ BPM$/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('song · song.wav', { exact: false })).toBeVisible()
  await page.getByLabel('Lyrics').fill('Hello night\n\nNeon lights  ')
  await open.click()

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
  // The next step for pasted lyrics is timing them, in Assist › Lyrics.
  expect(project.panel).toBe('assist:lyrics')

  await page.reload()
  await waitForPreview(page)
  const reopened = await opened(page)
  expect(reopened).toMatchObject({ id: project.id, name: 'song', song: 'song.wav', lyrics: project.lyrics })
})

test('a visualizer with the sample song uses the chosen style and opens on its visualizer', async ({
  page,
}) => {
  await startKind(page, /^Visualizer/)
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await expect(page.getByText('Chorus at 1:04')).toBeVisible()
  await page.getByRole('radio', { name: 'Particles' }).click()
  await expect(page.getByRole('radio', { name: 'Particles' })).toBeChecked()
  await page.getByRole('button', { name: 'Open the editor' }).click()

  await waitForPreview(page)
  const project = await opened(page)
  expect(project).toMatchObject({ name: 'Neon Skyline', song: 'neon-skyline.wav', bpm: 120 })
  expect(project.generators).toContain('visualizer.particles')
  expect(project.generators).not.toContain('visualizer.spectrum')
  expect(project.selected).toBe('visualizer.particles')
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

test('beat-cut footage keeps the chosen clips, and one can be removed first', async ({ page }) => {
  await startKind(page, /Beat-cut footage/)
  await page.getByLabel('Clip files').setInputFiles([fixture('clip.mp4'), fixture('image.png')])
  const clips = page.getByRole('list', { name: 'Your clips' })
  await expect(clips.getByRole('listitem')).toHaveCount(2, { timeout: 30_000 })
  await clips.getByRole('button', { name: 'Remove image.png' }).click()
  await expect(clips.getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByRole('button', { name: 'Open the editor' }).click()

  await waitForPreview(page)
  const project = await opened(page)
  expect(project.assets).toEqual(['clip.mp4', 'neon-skyline.wav'])
  expect(project.tracks).toEqual(['Titles', 'Look', 'Video', 'Song'])
  expect(project.panel).toBe('assist:autocut')
})

test('a file that is not audio is refused as the song, and Skip for now opens the template without one', async ({
  page,
}) => {
  await startKind(page, /Lyric video/)
  await page.getByLabel('Song file').setInputFiles(fixture('image.png'))
  await expect(page.getByRole('alert')).toHaveText(/“image\.png” isn’t an audio file/)
  await expect(page.getByRole('button', { name: 'Open the editor' })).toBeDisabled()

  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByText('Start with a song')).toBeVisible()
  const project = await opened(page)
  expect(project).toMatchObject({
    song: undefined,
    tracks: ['Lyrics', 'Look', 'Background', 'Song'],
    assets: [],
  })
  await expect(page).toHaveURL(/project=empty/)
})

test('Blank project opens an empty timeline with a video and a song track', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /^Blank project/ }).click()
  await expect(page.getByText('Start with a song')).toBeVisible()
  expect((await opened(page)).tracks).toEqual(['Video 1', 'Song'])
})
