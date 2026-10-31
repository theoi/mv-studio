import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * How far from its center an element takes clicks, across and down: probes outward from the center with
 * elementFromPoint, so an enlarged click area (padding, a pseudo-element) counts and a smaller visual does not matter.
 */
async function hitSize(target: Locator): Promise<{ width: number; height: number }> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const reach = (dx: number, dy: number) => {
      let d = 0
      while (d < 40) {
        const hit = document.elementFromPoint(cx + dx * (d + 0.5), cy + dy * (d + 0.5))
        if (!hit || !el.contains(hit)) break
        d++
      }
      return d
    }
    return { width: reach(-1, 0) + reach(1, 0), height: reach(0, -1) + reach(0, 1) }
  })
}

async function openAt720(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=lyric&t=73.6'
  })
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
}

test('at 1280×720 every track of the sample fits in the timeline without scrolling', async ({ page }) => {
  await openAt720(page)
  const headers = page.locator('[class*="trackHeader"]')
  await expect(headers.filter({ hasText: /^Song/ })).toBeVisible()
  const names = await headers.allInnerTexts()
  expect(names.length).toBeGreaterThanOrEqual(5)
  const last = await headers.last().boundingBox()
  expect(last).not.toBeNull()
  expect(last!.y + last!.height).toBeLessThanOrEqual(720)
})

test('timeline, inspector and library controls take clicks over at least 24 by 24 px', async ({ page }) => {
  await openAt720(page)
  const targets: [string, Locator][] = [
    ['Hide track', page.getByRole('button', { name: 'Hide track' }).first()],
    ['Lock track', page.getByRole('button', { name: 'Lock track' }).first()],
    ['Mute', page.getByRole('button', { name: 'Mute' }).first()],
    ['Solo', page.getByRole('button', { name: 'Solo' }).first()],
    ['Snapping options', page.getByRole('button', { name: 'Snapping options' })],
    ['Select tool', page.getByRole('radio', { name: 'Select', exact: true })],
    ['Split tool', page.getByRole('radio', { name: 'Split: click a clip to cut it' })],
    ['Add keyframe', page.locator('button[aria-label^="Add keyframe:"]').first()],
    [
      'Zoom slider',
      page.getByRole('slider').first().locator('xpath=ancestor::*[contains(@class, "_slider_")][1]'),
    ],
  ]
  const small: string[] = []
  for (const [name, target] of targets) {
    await expect(target, name).toBeVisible()
    const size = await hitSize(target)
    if (size.width < 24 || size.height < 24) small.push(`${name} ${size.width}×${size.height}`)
  }

  const card = page.getByRole('tabpanel', { name: 'Media' }).locator('[class*="card"]').first()
  await card.hover()
  const add = await hitSize(card.getByRole('button', { name: 'Add at playhead' }))
  if (add.width < 24 || add.height < 24) small.push(`Add at playhead ${add.width}×${add.height}`)

  const lyric = await page.locator('[class*="_lyric_"]').first().boundingBox()
  if (!lyric || lyric.height < 24) small.push(`lyric chip height ${lyric?.height}`)
  expect(small).toEqual([])
})

test('stem lane mute and solo take clicks over at least 24 by 24 px', async ({ page }) => {
  await openAt720(page)
  // Four stems on the song, so its stem lanes show. They need files and features, not sound.
  await page.evaluate(async () => {
    const { app, media } = window.mvStudio
    const editor = app.project.editor
    const song = editor.getProject().songAssetId
    const n = 4800
    const data = new DataView(new ArrayBuffer(44 + n * 2))
    const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)))
    text(0, 'RIFF')
    data.setUint32(4, 36 + n * 2, true)
    text(8, 'WAVEfmt ')
    data.setUint32(16, 16, true)
    data.setUint16(20, 1, true)
    data.setUint16(22, 1, true)
    data.setUint32(24, 48_000, true)
    data.setUint32(28, 96_000, true)
    data.setUint16(32, 2, true)
    data.setUint16(34, 16, true)
    text(36, 'data')
    data.setUint32(40, n * 2, true)
    const commands: object[] = []
    const stems: Record<string, string> = {}
    const stemFeatures: Record<string, object> = {}
    for (const name of ['vocals', 'drums', 'bass', 'other']) {
      const asset = await media.mediaStore.storeBlob(new Blob([data.buffer], { type: 'audio/wav' }), {
        kind: 'audio',
        name: `song (${name}).wav`,
        origin: { type: 'stem', parentAssetId: song },
      })
      commands.push({ type: 'asset.add', asset })
      stems[name] = asset.id
      stemFeatures[name] = { rate: 4, loudness: [0.5, 0.5], bands: [], bandEdgesHz: [], onsets: [] }
    }
    commands.push({ type: 'analysis.setStems', assetId: song, stems, stemFeatures })
    editor.dispatch(commands, { history: 'skip' })
  })

  // Neighboring lanes would cover each other's areas if the lanes were shorter than 24 px.
  const small: string[] = []
  for (const name of ['Mute vocals', 'Solo vocals', 'Mute drums', 'Solo drums']) {
    const target = page.getByRole('button', { name, exact: true })
    await expect(target, name).toBeVisible()
    await target.scrollIntoViewIfNeeded()
    const size = await hitSize(target)
    if (size.width < 24 || size.height < 24) small.push(`${name} ${size.width}×${size.height}`)
  }
  expect(small).toEqual([])
})
