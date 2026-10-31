import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures.ts'

/** Opens VJ mode on the sample project with the playhead at `t`. */
async function openVj(page: Page, t = 60) {
  await openApp(page)
  await page.evaluate((t) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = `#/vj?t=${t}`
  }, t)
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  await expect(pad(page, 'Night city')).toBeVisible()
}

const pad = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const recordButton = (page: Page) => page.getByRole('button', { name: /^Record/ })
const timelineClips = (page: Page, name: string) => page.locator(`[aria-label^="${name}, "]`)

test('keys played while recording land on the timeline as one take, and Esc brings it to the editor', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openVj(page, 64)
  await page.screenshot({ path: testInfo.outputPath('22-vj-mode-1440x900.png') })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('22-vj-mode-1280x720.png') })
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.keyboard.press('Shift+KeyZ')
  await expect(recordButton(page)).toHaveText('Recording · 0 events')
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.waitForTimeout(300)
  await page.keyboard.press('KeyT')
  await expect(pad(page, 'Night city')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(400)
  await page.keyboard.press('KeyQ')
  await expect(pad(page, 'Aurora over the city')).toHaveAttribute('aria-pressed', 'true')
  await expect(pad(page, 'Night city')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.down('KeyK')
  await expect(page.getByRole('button', { name: 'Mono' }).first()).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(400)
  await page.keyboard.up('KeyK')
  await page.keyboard.press('Digit3')
  await expect(pad(page, 'Golden hour')).toHaveAttribute('aria-pressed', 'true')
  await expect(recordButton(page)).toHaveText('Recording · 4 events')
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('22-vj-mode-recording-1440x900.png') })
  await page.keyboard.press('Space')
  await expect(page.getByText('Take 1 added to the timeline: 2 clips, 1 effect, 1 look')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('img', { name: 'Live output' })).toBeHidden()
  await expect(page.getByText('Performance added to the timeline: 1 take, all editable')).toBeVisible()
  // The take is ordinary timeline content: its own tracks, with clips named after the pads.
  await expect(page.getByText('VJ clips', { exact: true })).toBeVisible()
  await expect(page.getByText('VJ looks', { exact: true })).toBeVisible()
  const auroraClips = await timelineClips(page, 'Aurora over the city').count()
  expect(auroraClips).toBeGreaterThan(0)
  // One undo removes the whole take, including the one Aurora clip it played.
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByText('VJ clips', { exact: true })).toHaveCount(0)
  await expect(timelineClips(page, 'Aurora over the city')).toHaveCount(auroraClips - 1)
  expect(errors).toEqual([])
})

test('playing without Record is a rehearsal, a take can be discarded, and one Undo removes a performance', async ({
  page,
}) => {
  await openVj(page)
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.waitForTimeout(300)
  await page.keyboard.press('KeyT')
  await page.waitForTimeout(400)
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await page.waitForTimeout(300)
  await expect(page.getByText(/^Take \d/)).toHaveCount(0)

  await recordButton(page).click()
  await expect(recordButton(page)).toHaveText('Recording · 0 events')
  await page.keyboard.press('Space')
  await page.waitForTimeout(300)
  await page.keyboard.press('KeyQ')
  await page.waitForTimeout(400)
  await page.keyboard.press('Space')
  await expect(page.getByText(/^Take 1 added to the timeline/)).toBeVisible()
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('Take 1 discarded')).toBeVisible()

  // Two more takes: the performance's Undo removes both, walking back over the discard.
  for (const [n, key] of [
    [2, 'KeyW'],
    [3, 'KeyE'],
  ] as const) {
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
    await page.waitForTimeout(300)
    await page.keyboard.press(key)
    await page.waitForTimeout(400)
    await page.keyboard.press('Space')
    await expect(page.getByText(new RegExp(`^Take ${n} added to the timeline`))).toBeVisible()
  }
  await page.getByRole('button', { name: 'Back to editor' }).click()
  await expect(page.getByRole('img', { name: 'Live output' })).toBeHidden()
  await expect(page.getByText('Performance added to the timeline: 2 takes, all editable')).toBeVisible()
  await expect(page.getByText('VJ clips', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByText('Removed 2 takes from the timeline')).toBeVisible()
  await expect(page.getByText('VJ clips', { exact: true })).toHaveCount(0)
})

test('quantize set in Settings lines the next take up with the beats, and open menus keep their keys', async ({
  page,
}) => {
  await openVj(page)
  // Esc and Space in an open menu belong to the menu, not to VJ mode.
  await page.getByRole('button', { name: 'No MIDI device' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Space')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await page.keyboard.press('Control+Comma')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'VJ and MIDI' }).click()
  await expect(dialog.getByText('None connected')).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Quantize' }).click()
  await page.getByRole('option', { name: 'Nearest beat' }).click()
  await expect(dialog.getByRole('combobox', { name: 'Quantize' })).toHaveText('Nearest beat')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible()

  await page.keyboard.press('Shift+KeyZ')
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.waitForTimeout(300)
  await page.keyboard.press('KeyR')
  await page.waitForTimeout(500)
  await page.keyboard.press('Space')
  await expect(page.getByText('Take 1 added to the timeline: 1 clip, lined up with the beats')).toBeVisible()
})

test('pads are changed from their menu and the layout is saved with the project', async ({ page }) => {
  await openVj(page)
  await expect(page.getByText('tap · bank 1 of 3')).toBeVisible()
  await pad(page, 'Rain on glass').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Clear pad' }).click()
  await expect(pad(page, 'Rain on glass')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Empty pad' })).toHaveCount(1)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('img', { name: 'Live output' })).toBeHidden()
  await page.keyboard.press('Shift+KeyV')
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Empty pad' })).toHaveCount(1)

  await page.getByRole('button', { name: 'Empty pad' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Tunnel lights' }).click()
  await expect(page.getByRole('button', { name: 'Tunnel lights', exact: true })).toHaveCount(2)
  await page.getByRole('button', { name: 'Tunnel lights', exact: true }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reset all pads' }).click()
  await expect(pad(page, 'Rain on glass')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tunnel lights', exact: true })).toHaveCount(1)
})

/**
 * CI machines have no MIDI hardware (and headless Chromium no MIDI backend), so this stands in for one controller
 * at the Web MIDI API boundary. `window.e2eMidi(bytes)` sends a message from it.
 */
async function plugInMidiController(page: Page) {
  await page.addInitScript(() => {
    type Listener = (event: { data: Uint8Array; timeStamp: number }) => void
    const port = {
      id: 'e2e-pads',
      name: 'E2E Pad Controller',
      manufacturer: 'Playwright',
      state: 'connected',
      onmidimessage: null as Listener | null,
    }
    const access = { inputs: new Map([[port.id, port]]), onstatechange: null }
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      value: () => Promise.resolve(access),
      configurable: true,
    })
    Object.defineProperty(window, 'e2eMidi', {
      value: (bytes: number[]) =>
        port.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp: performance.now() }),
    })
  })
}

const sendMidi = (page: Page, bytes: number[]) =>
  page.evaluate((b) => (window as unknown as { e2eMidi(b: number[]): void }).e2eMidi(b), bytes)

test('pads are mapped to a key and to a MIDI pad by clicking them and pressing the input', async ({
  page,
}) => {
  await plugInMidiController(page)
  await openVj(page)
  await page.getByRole('button', { name: 'No MIDI device' }).click()
  await page.getByRole('menuitem', { name: /Connect a MIDI controller/ }).click()
  await page.getByRole('button', { name: 'E2E Pad Controller' }).click()
  await expect(page.getByRole('menuitem', { name: /E2E Pad Controller/ })).toBeVisible()
  await page.getByRole('menuitem', { name: /Map keys and MIDI pads/ }).click()
  await expect(page.getByText('Click a pad, then press a key or a MIDI pad to map it.')).toBeVisible()

  await pad(page, 'Ocean drive').click()
  await expect(page.getByText('Press a key or a MIDI pad for “Ocean drive”')).toBeVisible()
  await page.keyboard.press('KeyM')
  await expect(page.getByText('Click a pad, then press a key or a MIDI pad to map it.')).toBeVisible()
  await expect(pad(page, 'Ocean drive')).toContainText('M')

  await pad(page, 'Rain on glass').click()
  await expect(page.getByText('Press a key or a MIDI pad for “Rain on glass”')).toBeVisible()
  await sendMidi(page, [0x90, 36, 100])
  await expect(pad(page, 'Rain on glass')).toHaveAttribute('title', 'MIDI Note 36 · ch 1')
  // Esc ends mapping, not VJ mode.
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Click a pad, then press a key/)).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible()

  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.keyboard.press('KeyM')
  await expect(pad(page, 'Ocean drive')).toHaveAttribute('aria-pressed', 'true')
  await sendMidi(page, [0x80, 36, 0])
  await sendMidi(page, [0x90, 36, 100])
  await expect(pad(page, 'Rain on glass')).toHaveAttribute('aria-pressed', 'true')
  await expect(pad(page, 'Ocean drive')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')

  // Back to editor leaves even while mapping (only Esc ends mapping first).
  await page.getByRole('button', { name: 'E2E Pad Controller' }).click()
  await page.getByRole('menuitem', { name: /Map keys and MIDI pads/ }).click()
  await expect(page.getByText('Click a pad, then press a key or a MIDI pad to map it.')).toBeVisible()
  await page.getByRole('button', { name: 'Back to editor' }).click()
  await expect(page.getByRole('img', { name: 'Live output' })).toBeHidden()
})
