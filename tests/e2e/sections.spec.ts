import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

test('a section label guessed from the audio is muted and says "Probably the chorus" until the user renames it', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
  // Labels from the audio alone come with a low confidence.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const project = editor.getProject()
    editor.dispatch(
      {
        type: 'analysis.updateSection',
        assetId: project.songAssetId,
        sectionId: 's-c1',
        patch: { confidence: 0.4 },
      },
      { history: 'skip' },
    )
  })
  const guessed = page.getByRole('button', { name: 'Section Chorus, 1:04 to 1:36' })
  await expect(guessed).toBeVisible()
  await expect(guessed).toHaveAttribute(
    'title',
    'Probably the chorus. Click to go to its start, double-click to rename.',
  )
  const muted = await guessed
    .getByText('Chorus', { exact: true })
    .evaluate((el) => getComputedStyle(el).color)
  // Selected, the Inspector's header says it is a guess too. A mouse pointerdown: see below.
  await guessed.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText('Probably the chorus', { exact: true })).toBeVisible()
  await expect(inspector.getByText(/^1:04 – 1:36 · \d+ bars$/)).toBeVisible()

  // Escape leaves the name as it was; Enter keeps what the user typed, which is no longer a guess.
  await guessed.dblclick()
  await page.getByRole('textbox', { name: 'Rename section' }).fill('Drop')
  await page.keyboard.press('Escape')
  await expect(guessed).toBeVisible()
  await guessed.dblclick()
  await page.getByRole('textbox', { name: 'Rename section' }).fill('Hook')
  await page.keyboard.press('Enter')
  const named = page.getByRole('button', { name: 'Section Hook, 1:04 to 1:36' })
  await expect(named).toBeVisible()
  await expect(named).not.toHaveAttribute('title')
  expect(
    await named.getByText('Hook', { exact: true }).evaluate((el) => getComputedStyle(el).color),
  ).not.toBe(muted)
  // A mouse pointerdown: one without a pointer type counts as touch, whose long press opens the section menu.
  await named.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  await expect(page.getByText(/^Named by you/)).toBeVisible()
  await expect(page.getByText(/^1:04 – 1:36 · \d+ bars$/)).toBeVisible()
})

test('a guessed section header reads in full at 1280×720, the guess on its own line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=50'
  })
  await waitForPreview(page)
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const project = editor.getProject()
    editor.dispatch(
      {
        type: 'analysis.updateSection',
        assetId: project.songAssetId,
        sectionId: 's-pre',
        patch: { confidence: 0.4 },
      },
      { history: 'skip' },
    )
  })
  await page
    .getByRole('button', { name: 'Section Pre-chorus, 0:48 to 1:04' })
    .dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  const title = page
    .getByRole('tabpanel', { name: 'Inspector' })
    .getByText('Section: Pre-chorus', { exact: true })
  await expect(title).toBeVisible()
  // The lines under the title: none may end in an ellipsis, and the guess and the span each read whole.
  const lines = () =>
    title.evaluate((el) =>
      [...(el.parentElement?.children ?? [])]
        .filter((line) => line !== el)
        .map((line) => ({ text: line.textContent, cut: line.scrollWidth > line.clientWidth })),
    )
  expect(await lines()).toEqual([
    { text: 'Probably the pre-chorus', cut: false },
    { text: '0:48 – 1:04 · 8 bars', cut: false },
  ])

  // Without a beat there are no bars to count.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: editor.getProject().songAssetId,
        grid: { tempo: { bpm: 0, confidence: 0 }, beats: [], downbeats: [] },
      },
      { history: 'skip' },
    )
  })
  await expect.poll(lines).toEqual([
    { text: 'Probably the pre-chorus', cut: false },
    { text: '0:48 – 1:04', cut: false },
  ])
})
