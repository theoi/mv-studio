import { expect, openHarness, test } from './fixtures.ts'

test('a look shows as a compact labeled bar that keeps its label in view, and cut-off track names get a tooltip', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=lyric&t=73'
  })
  await expect(page.getByRole('img', { name: 'Video preview' })).toBeVisible()
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    window.mvStudio.plugins.looks.applyLook(editor, 'neon')
    const project = editor.getProject()
    const clips = Object.values(project.clips) as { id: string; meta?: { role?: unknown } }[]
    const look = clips.find((c) => c.meta?.role === 'look')
    if (!look) throw new Error('no look layer')
    editor.dispatch({ type: 'clip.set', clipId: look.id, path: ['opacity', 'value'], value: 0.7 })
    const tracks = project.tracks as { id: string; name: string }[]
    const video = tracks.find((t) => t.name === 'Video')
    if (!video) throw new Error('no Video track')
    editor.dispatch({ type: 'track.update', trackId: video.id, patch: { name: 'Director · Shots and more' } })
  })

  const bar = page.getByRole('button', { name: /^Neon night · 70%, 0:00\.0 to / })
  await expect(bar).toBeVisible()
  expect((await bar.boundingBox())?.height).toBeLessThanOrEqual(16)

  // The look starts at 0:00, which is scrolled out of view; its label stays at the left edge of the lanes.
  const scrolled = await bar.evaluate((el) => {
    const node = el.closest<HTMLElement>('[data-timeline-scroller]')
    if (!node) return 0
    node.scrollLeft = 600
    return node.scrollLeft
  })
  expect(scrolled).toBeGreaterThan(0)
  const label = bar.getByText('Neon night · 70%')
  const header = page.locator('span[class*="trackName"]').filter({ hasText: /^Look$/ })
  await expect
    .poll(async () => {
      const [l, h] = await Promise.all([label.boundingBox(), header.boundingBox()])
      return l && h ? l.x - h.x : -1
    })
    .toBeGreaterThan(100)

  const name = page.getByText('Director · Shots and more', { exact: true })
  await name.hover()
  await expect(name).toHaveAttribute('title', 'Director · Shots and more')
  await header.hover()
  await expect(header).toHaveAttribute('title', '')
})
