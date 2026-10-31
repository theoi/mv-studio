import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openEditor(page: Page, hash = '#/editor?kind=lyric&t=73') {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

/** The playhead in seconds, read from the preview's timecode. */
async function playhead(page: Page): Promise<number> {
  const text = (await page.locator('[class*="tcNow"]').textContent()) ?? ''
  const [m, s] = text.split(':')
  return Number(m) * 60 + Number(s)
}

test('J, K and L shuttle the playhead back and forward and stop it', async ({ page }) => {
  await openEditor(page)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  const start = await playhead(page)

  await page.keyboard.press('l')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  // L again runs at 2× without sound: the play button shows Play while the playhead keeps moving.
  await page.keyboard.press('l')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  const fast = await playhead(page)
  await page.waitForTimeout(600)
  expect(await playhead(page)).toBeGreaterThan(fast + 0.8)

  await page.keyboard.press('k')
  const stopped = await playhead(page)
  await page.waitForTimeout(300)
  expect(await playhead(page)).toBe(stopped)
  expect(stopped).toBeGreaterThan(start)

  await page.keyboard.press('j')
  await page.waitForTimeout(500)
  const back = await playhead(page)
  expect(back).toBeLessThan(stopped - 0.2)
  await page.keyboard.press('k')
  await page.waitForTimeout(200)
  expect(await playhead(page)).toBeLessThanOrEqual(back)
})

/** Presses Tab until `target` has focus, so it is focused the way a keyboard user reaches it. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error('Tab never reached the target')
}

test('Space presses a control reached with the keyboard and plays after a click on one; K plays whatever has focus', async ({
  page,
}) => {
  await openEditor(page)
  const play = page.getByRole('button', { name: 'Play', exact: true })
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  const media = page.getByRole('tabpanel', { name: 'Media' })
  const videoFilter = media.getByRole('tab', { name: 'Video' })

  await media.getByRole('textbox', { name: 'Search media by content' }).click()
  await tabTo(page, videoFilter)
  await page.keyboard.press('Space')
  await expect(videoFilter).toHaveAttribute('aria-selected', 'true')
  await expect(play).toBeVisible()

  // K plays and pauses with that control still focused.
  await page.keyboard.press('k')
  await expect(pause).toBeVisible()
  await expect(videoFilter).toBeFocused()
  await page.keyboard.press('k')
  await expect(play).toBeVisible()

  // After a click on a control, Space plays and pauses instead of pressing it again.
  const splitTool = page.getByRole('radio', { name: 'Split: click a clip to cut it' })
  await splitTool.click()
  await expect(splitTool).toBeFocused()
  await page.keyboard.press('Space')
  await expect(pause).toBeVisible()
  await expect(splitTool).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Space')
  await expect(play).toBeVisible()
})

test('on a timeline clip reached with the keyboard, Enter selects it and Space plays and pauses', async ({
  page,
}) => {
  await openEditor(page)
  const play = page.getByRole('button', { name: 'Play', exact: true })
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  const clip = page.getByRole('button', { name: /, \d+:\d+\.\d to \d+:\d+\.\d$/ }).first()
  await expect(clip).toHaveAttribute('aria-keyshortcuts', 'Enter Shift+Enter')
  await page.keyboard.press('Tab')
  await clip.focus()
  await page.keyboard.press('Enter')
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Space')
  await expect(pause).toBeVisible()
  await expect(clip).toBeFocused()
  await page.keyboard.press('Space')
  await expect(play).toBeVisible()
  await expect(clip).toHaveAttribute('aria-pressed', 'true')

  // Lyric lines on the Lyrics track work the same way.
  const lyric = page.getByRole('button', { name: /^Lyric: / }).first()
  await lyric.focus()
  await page.keyboard.press('Enter')
  await expect(lyric).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('textbox', { name: 'Lyric text' })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(pause).toBeVisible()
  await page.keyboard.press('Space')
  await expect(play).toBeVisible()
})

test('Shift Z fits the whole song, V picks the select tool and Alt K keyframes the focused property', async ({
  page,
}) => {
  await openEditor(page, '#/editor?sel=clip:c-s-c1-1&t=67.2')
  const zoom = page.getByRole('slider', { name: 'Timeline zoom' })
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  const fitted = await zoom.getAttribute('aria-valuenow')
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('ControlOrMeta+=')
  await page.keyboard.press('ControlOrMeta+=')
  await expect(zoom).not.toHaveAttribute('aria-valuenow', fitted ?? '')
  await page.keyboard.press('Shift+Z')
  await expect(zoom).toHaveAttribute('aria-valuenow', fitted ?? '')

  const split = page.getByRole('radio', { name: 'Split: click a clip to cut it' })
  await split.click()
  await expect(split).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('v')
  await expect(page.getByRole('radio', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  await expect(page.getByRole('button', { name: 'Add keyframe: Opacity' })).toBeVisible()
  await page.getByRole('slider', { name: 'Opacity' }).focus()
  await page.keyboard.press('Alt+K')
  await expect(page.getByRole('button', { name: 'Remove keyframe: Opacity' })).toBeVisible()
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('Alt+K')
  await expect(
    page.getByText('Click a value in the Inspector, then press Alt K to keyframe it'),
  ).toBeVisible()
})

test('Esc closes an open Inspector select or clip menu without clearing the selection', async ({ page }) => {
  await openEditor(page, '#/editor?sel=clip:c-s-c1-1&t=67.2')
  const blend = page.getByRole('combobox', { name: 'Blend mode' })
  await blend.click()
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(blend).toBeVisible()

  // The same for the clip's context menu.
  await page
    .getByRole('button', { pressed: true, name: /, \d+:\d+\.\d to \d+:\d+\.\d$/ })
    .click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(blend).toBeVisible()
  // The next Esc, with nothing open, deselects.
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('Escape')
  await expect(blend).toBeHidden()
})

test('Settings › Shortcuts lists the keys that work, from the shortcut table', async ({ page }) => {
  await openEditor(page)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('?')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('button', { name: 'Shortcuts' })).toHaveAttribute('aria-current', 'page')
  for (const label of [
    'Play / pause',
    'Shuttle back',
    'Shuttle forward',
    'Select tool',
    'Zoom to fit',
    'Redo',
    'Loop playback',
    'Full-screen preview',
    'Add marker',
  ])
    await expect(dialog.getByText(label, { exact: true })).toBeVisible()

  await dialog.getByRole('textbox', { name: 'Search shortcuts' }).fill('zoom')
  await expect(dialog.getByText(/^Zoom /)).toHaveCount(3)
  await expect(dialog.getByText('Redo', { exact: true })).toHaveCount(0)
})

test('the palette applies a look, walks the edit history and opens Song analysis and settings pages', async ({
  page,
}) => {
  await openEditor(page)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByRole('combobox')

  await page.keyboard.press('ControlOrMeta+k')
  const applyLook = palette.getByRole('option', { name: 'Apply a look…' })
  await applyLook.click()
  await expect(input).toHaveAttribute('placeholder', 'Search looks')
  // Esc goes back to the actions, then closes.
  await page.keyboard.press('Escape')
  await expect(input).toHaveAttribute('placeholder', /^Search actions/)
  await applyLook.click()
  // The sample video has Neon night.
  await input.fill('golden')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByText('Look “Golden hour” applied to the whole video')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Golden hour · / })).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('edit history')
  await page.keyboard.press('Enter')
  await expect(input).toHaveAttribute('placeholder', 'Search edits')
  await palette.getByRole('option', { name: 'Undo “Apply look: Golden hour”' }).click()
  await expect(page.getByRole('button', { name: /^Neon night · / })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await palette.getByRole('option', { name: /^Redo/ }).first().click()
  await expect(page.getByRole('button', { name: /^Golden hour · / })).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('song analysis')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Song analysis', { exact: true }).first()).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('storage')
  await page.keyboard.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('button', { name: 'Storage' })).toHaveAttribute('aria-current', 'page')
})

test('an action that can’t run stays in the palette with the reason, and Enter on it does nothing', async ({
  page,
}) => {
  await openEditor(page)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByRole('combobox')
  const selected = palette.locator('[cmdk-item][data-selected="true"]')

  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('redo')
  await expect(selected).toHaveText(/^Redo\s*Nothing to redo$/)
  await page.keyboard.press('Enter')
  await expect(palette).toBeVisible()
  // The arrow keys still reach it.
  await input.fill('undo')
  await expect(selected).toHaveText(/^Undo\s*Nothing to undo$/)
  await page.keyboard.press('ArrowDown')
  await expect(selected).toHaveText(/^Edit history…\s*No edits yet$/)
  await page.keyboard.press('Enter')
  await expect(input).toHaveAttribute('placeholder', /^Search actions/)
  await page.keyboard.press('Escape')

  await page.evaluate(() => window.mvStudio.app.project.addTextAtPlayhead())
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('undo')
  await expect(selected).toHaveText(/^Undo\s*(Ctrl|⌘)/)
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('redo')
  await expect(palette.getByText('Nothing to redo')).toHaveCount(0)
})

test('typing an action’s name in the palette and pressing Enter runs it, even as three words', async ({
  page,
}) => {
  await openEditor(page)
  const zoom = page.getByRole('slider', { name: 'Timeline zoom' })
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  const fitted = (await zoom.getAttribute('aria-valuenow')) ?? ''
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('ControlOrMeta+=')
  await expect(zoom).not.toHaveAttribute('aria-valuenow', fitted)

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByRole('combobox')
  const first = palette.locator('[cmdk-item][data-selected="true"]')
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('look')
  await expect(first).toHaveText(/^Apply a look…/)
  await input.fill('hotkeys')
  await expect(first).toHaveText(/^Keyboard shortcuts/)
  await input.fill('make the chorus more intense')
  await expect(first).toHaveText(/^Ask Assist/)
  await input.fill('zoom to fit')
  await expect(first).toHaveText(/^Zoom to fit/)
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(zoom).toHaveAttribute('aria-valuenow', fitted)
})
