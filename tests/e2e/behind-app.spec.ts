import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/** Cutout clips on the Subject track, with their mattes and mask assets. */
function cutouts(page: Page) {
  return page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => c.meta?.behindSubjectOf)
      .map((c) => {
        const mask = project.assets[c.matte?.maskAssetId]
        return {
          host: c.meta.behindSubjectOf as string,
          track: project.tracks.find((t: Untyped) => t.id === c.trackId)?.name as string,
          matte: { mode: c.matte?.mode, source: c.matte?.sourceAssetId },
          mask: mask && {
            kind: mask.kind,
            parent: mask.origin.parentAssetId,
            provider: mask.origin.provider,
          },
        }
      })
  })
}

async function open(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

/** Imports a clip, adds it at the playhead and selects it on the timeline. */
async function importAndSelect(page: Page, file: string, name: string) {
  await page.getByLabel('Import media files').setInputFiles(file)
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(`${name}, video`)
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const block = page.getByRole('button', { name: new RegExp(`^${name}, `) })
  await expect(block).toHaveCount(1)
  await block.focus()
  await page.keyboard.press('Enter')
}

test('Assist › Behind the subject explains each shot and cuts the people out of the suitable ones', async ({
  page,
}) => {
  await open(page, '#/editor?tab=assist&assist=behind&t=66.9')
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const crowd = assist.getByText('Concert crowd', { exact: true }).locator('..').locator('..')
  await expect(crowd.getByText('People are too small in this wide shot.')).toBeVisible()
  await expect(crowd.getByText('Not suitable')).toBeVisible()
  const singer = assist.getByText('Singer close-up', { exact: true }).locator('..').locator('..')
  await expect(singer.getByText('Suitable', { exact: true })).toBeVisible()

  const hosts = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => c.assetId === 'm-singer' || c.assetId === 'm-dancer')
      .map((c) => c.id as string)
      .sort()
  })
  expect(hosts.length).toBeGreaterThan(1)
  await assist.getByRole('button', { name: `Apply to ${hosts.length} suitable clips` }).click()
  await expect(assist.getByText(`Lyrics now sit behind the person on ${hosts.length} clips`)).toBeVisible()
  const added = await cutouts(page)
  expect(added.map((c) => c.host).sort()).toEqual(hosts)
  for (const c of added) {
    expect(c.track).toBe('Subject')
    expect(c.matte.mode).toBe('inside')
    expect(c.mask).toMatchObject({ kind: 'image', parent: c.matte.source })
  }

  await assist.getByRole('button', { name: 'Undo' }).click()
  await expect(assist.getByRole('button', { name: `Apply to ${hosts.length} suitable clips` })).toBeVisible()
  expect(await cutouts(page)).toEqual([])
})

test('an imported clip with a person is cut out with a real person mask from the inspector switch', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await open(page, '#/editor?t=10')
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  await inspector.getByRole('switch', { name: 'Put text and effects behind the subject' }).click()
  await expect(inspector.getByText('Person found')).toBeVisible({ timeout: 90_000 })
  const [cut] = await cutouts(page)
  expect(cut).toMatchObject({
    track: 'Subject',
    matte: { mode: 'inside' },
    mask: { kind: 'video', provider: 'vision.person-mask' },
  })
  expect(cut!.mask.parent).toBe(cut!.matte.source)
  await expect(page.getByRole('button', { name: /^people-interview · subject, / })).toBeVisible()
})

test('a clip with no one in it says why it cannot be cut out', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, '#/editor?t=10')
  await importAndSelect(page, path.resolve('tests/fixtures/.cache/clip.mp4'), 'clip')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  const toggle = inspector.getByRole('switch', { name: 'Put text and effects behind the subject' })
  await toggle.click()
  await expect(
    inspector.getByText(/^(No one is in this shot|People are too small in this wide shot)\.$/),
  ).toBeVisible({
    timeout: 90_000,
  })
  await expect(toggle).not.toBeChecked()
  await expect(toggle).toBeDisabled()
  expect(await cutouts(page)).toEqual([])
})
