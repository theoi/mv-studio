import type { Locator, Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * How far from its center an element takes clicks, across and down: probes outward from the center with
 * elementFromPoint, so an enlarged click area (padding, a pseudo-element) counts and a smaller visual does not matter.
 * `x` probes at that viewport x instead of the center, for an element wider than the view.
 */
async function hitSize(target: Locator, x?: number): Promise<{ width: number; height: number }> {
  return target.evaluate((el, x) => {
    const r = el.getBoundingClientRect()
    const cx = x ?? r.left + r.width / 2
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
  }, x)
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
    ['Track grip', page.getByRole('button', { name: /^Move the .+ track$/ }).first()],
    ['Section edge', page.getByRole('slider', { name: /^Edge between / }).first()],
  ]
  const small: string[] = []
  for (const [name, target] of targets) {
    await expect(target, name).toBeVisible()
    await target.scrollIntoViewIfNeeded()
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

test('switches and the fal.ai key link take clicks over at least 24 by 24 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?dialog=settings&page=general'
  })
  const small: string[] = []
  const check = async (name: string, target: Locator) => {
    await expect(target, name).toBeVisible()
    await target.scrollIntoViewIfNeeded()
    const size = await hitSize(target)
    if (size.width < 24 || size.height < 24) small.push(`${name} ${size.width}×${size.height}`)
  }
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await check('Inline suggestions', dialog.getByRole('switch', { name: 'Inline suggestions' }))
  await check('Reduce motion', dialog.getByRole('switch', { name: 'Reduce motion' }))

  await page.evaluate(() => (window.location.hash = '#/editor?dialog=settings&page=ai'))
  const link = dialog.getByRole('link', { name: 'Get a key at fal.ai' })
  await check('Get a key at fal.ai', link)
  // The link ends with its text, so a click beside it in the card does not open the page.
  const box = (await link.boundingBox())!
  expect(box.width).toBeLessThan(200)

  await page.evaluate(() => (window.location.hash = '#/editor?sel=clip:o-title&t=4'))
  await expect(dialog).toBeHidden()
  for (const name of ['Outline on', 'Shadow on', 'Background on'])
    await check(name, page.getByRole('tabpanel', { name: 'Inspector' }).getByRole('switch', { name }))
  expect(small).toEqual([])
})

test('the Look clip takes clicks over at least 24 px of height, and a drag from above its bar keeps it on its track', async ({
  page,
}) => {
  await openAt720(page)
  const look = page.locator('[class*="clip-look"]').first()
  await expect(look).toBeVisible()
  // The bar spans the song, wider than the view: probe where its name sticks in view.
  const label = (await look.locator('[class*="clipLabel"]').boundingBox())!
  const x = label.x + label.width / 2
  const { height } = await hitSize(look, x)
  expect(height).toBeGreaterThanOrEqual(24)

  // Above the bar, in the edge of the lane above, the press grabs the look and the drag stays on the Look track.
  const bar = (await look.boundingBox())!
  const y = bar.y - 4.5
  const id = (await look.getAttribute('data-clip-id'))!
  const placed = () =>
    page.evaluate((id) => {
      const project: Project = window.mvStudio.app.project.editor.getProject()
      const clip = project.clips[id]!
      return { trackId: clip.trackId, start: clip.start, duration: clip.duration }
    }, id)
  const before = await placed()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 40, y, { steps: 8 })
  await expect(page.getByText('No looks here', { exact: true })).toHaveCount(0)
  await page.mouse.up()
  await expect(look).toHaveAttribute('aria-pressed', 'true')
  expect(await placed()).toEqual(before)
})
