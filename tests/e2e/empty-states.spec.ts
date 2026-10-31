import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
}

test('the Media and Assist empty states say what to do next, before and after a song', async ({ page }) => {
  await openEditor(page, '#/editor?project=empty&kind=blank')
  await expect(page.getByText('Start with a song')).toBeVisible()
  const media = page.getByRole('tabpanel', { name: 'Media' })
  await expect(media.getByText('Bring in your media')).toBeVisible()
  await expect(
    media.getByText('Drop a song, clips and images anywhere, or Import. Files are kept in this browser.'),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Assist' }).click()
  await expect(page.getByText('Add a song to unlock smart tools')).toBeVisible()

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await expect(media.getByText('song.mp3')).toBeVisible()
  await expect(page.getByText('Add a song to unlock smart tools')).toBeHidden()
  // A song but no clips: the library says how to add them, not "No matches".
  await expect(media.getByText('No clips or images yet')).toBeVisible()
  await expect(media.getByText('Drop clips and images, or Import.')).toBeVisible()
  await expect(media.getByText('No matches')).toHaveCount(0)
  // No "0" next to an empty group.
  await expect(media.getByText('Clips and images', { exact: true })).toBeVisible()
  await media.getByRole('tab', { name: 'Generated' }).click()
  await expect(media.getByText('Nothing generated yet')).toBeVisible()
  await expect(media.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)

  await media.getByRole('tab', { name: 'Images' }).click()
  await expect(media.getByText('No images yet')).toBeVisible()
  const clipChooser = page.waitForEvent('filechooser')
  await media.getByRole('button', { name: 'Import', exact: true }).click()
  await (await clipChooser).setFiles(path.join(FIXTURE_DIR, 'image.png'))
  await expect(media.getByText('No images yet')).toBeHidden()
  await expect(media.getByText('Clips and images 1')).toBeVisible()
})

test('a Lyric video made on the start screen with a song says how to add clips, not "No matches"', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /Lyric video/ }).click()
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByRole('button', { name: 'Open the editor' }).click()
  await waitForPreview(page)
  await page.getByRole('tab', { name: 'Media' }).click()
  const media = page.getByRole('tabpanel', { name: 'Media' })
  await expect(media.getByText('neon-skyline.wav')).toBeVisible()
  await expect(media.getByText('No clips or images yet')).toBeVisible()
  await expect(media.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
  await expect(media.getByText('No matches')).toHaveCount(0)
})

test('an empty Lyrics track offers Add lyrics, which opens Assist › Lyrics', async ({ page }) => {
  await openEditor(page, '#/editor?kind=blank&t=73')
  await waitForPreview(page)
  const addLyrics = page.getByRole('button', { name: 'Add lyrics' })
  await expect(page.getByRole('button', { name: /^Lyric: / }).first()).toBeVisible()
  await expect(addLyrics).toHaveCount(0)

  // Removing every line leaves the Lyrics track empty.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const clips = Object.values(editor.getProject().clips) as { id: string; lyricLineId?: string }[]
    editor.dispatch([
      { type: 'clip.remove', clipIds: clips.filter((c) => c.lyricLineId).map((c) => c.id) },
      { type: 'lyrics.set', lyrics: null },
    ])
  })
  await expect(addLyrics).toBeVisible()
  await addLyrics.click()
  await expect(page.getByRole('tab', { name: 'Assist' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Lyrics', exact: true })).toBeVisible()

  // A new lyric video from its template, with the song and no lyrics yet.
  await page.evaluate(() => {
    const { app, plugins } = window.mvStudio
    const current = app.project.editor.getProject()
    const song = current.assets[current.songAssetId]
    app.project.editor.load(
      plugins.templates.createFromTemplate('lyric', { song, analysis: current.analysis?.audio }),
    )
  })
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await expect(addLyrics).toBeVisible()
  await expect(page.getByRole('button', { name: /^Lyric: / })).toHaveCount(0)
})

test('Help › Documentation opens the README', async ({ page, context }) => {
  await context.route('https://github.com/**', (route) => route.fulfill({ body: 'readme' }))
  await openEditor(page, '#/editor?kind=blank')
  await waitForPreview(page)
  await page.getByRole('button', { name: 'Help' }).click()
  const [docs] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('menuitem', { name: 'Documentation' }).click(),
  ])
  await docs.waitForURL('https://github.com/theoi/mv-studio#readme')
})
