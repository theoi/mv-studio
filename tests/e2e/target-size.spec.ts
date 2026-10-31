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
    ['Select tool', page.getByRole('radio', { name: 'Select (V)' })],
    ['Split tool', page.getByRole('radio', { name: 'Split (S)' })],
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
