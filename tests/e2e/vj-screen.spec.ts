import type { Page } from '@playwright/test'
import { expect, openApp, openHarness, test, waitForPreview } from './fixtures.ts'

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
  await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
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
async function plugInMidiController(
  page: Page,
  options: { ports?: { id: string; name: string }[]; failFirst?: { name: string; message: string } } = {},
) {
  await page.addInitScript((options) => {
    type Listener = (event: { data: Uint8Array; timeStamp: number }) => void
    const ports = (options.ports ?? [{ id: 'e2e-pads', name: 'E2E Pad Controller' }]).map((p) => ({
      ...p,
      manufacturer: 'Playwright',
      state: 'connected',
      onmidimessage: null as Listener | null,
    }))
    const access = { inputs: new Map(ports.map((p) => [p.id, p])), onstatechange: null }
    let fail = options.failFirst
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      value: () => {
        if (!fail) return Promise.resolve(access)
        const error = new DOMException(fail.message, fail.name)
        fail = undefined
        return Promise.reject(error)
      },
      configurable: true,
    })
    Object.defineProperty(window, 'e2eMidi', {
      value: (bytes: number[]) =>
        ports[0]?.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp: performance.now() }),
    })
  }, options)
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

test('Settings › VJ and MIDI connects a controller outside VJ mode and picks its default mapping', async ({
  page,
}) => {
  await plugInMidiController(page)
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=60'
  })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'VJ and MIDI' }).click()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByText('E2E Pad Controller')).toBeVisible()
  const mapping = dialog.getByRole('combobox', { name: 'MIDI mapping' })
  await expect(mapping).toHaveText('Pad controller')
  await expect(dialog.getByText(/^Notes 36–43 play the clip pads, 44–51 the effect pads\./)).toBeVisible()
  await mapping.click()
  await page.getByRole('option', { name: /^Keyboard/ }).click()
  await expect(mapping).toHaveText('Keyboard')
  await expect(dialog.getByText(/^Notes 60–67 play the clip pads, 68–75 the effect pads\./)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // VJ mode uses the same connection, with no second Connect, and the mapping picked in Settings.
  await page.getByRole('button', { name: 'VJ', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: 'E2E Pad Controller' })).toBeVisible()
  await expect(pad(page, 'Aurora over the city')).toHaveAttribute('title', 'MIDI Note 60')
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await sendMidi(page, [0x90, 60, 100])
  await expect(pad(page, 'Aurora over the city')).toHaveAttribute('aria-pressed', 'true')
})

test('[ and ] page through the clip banks, and Backspace turns every effect off', async ({ page }) => {
  await openVj(page)
  const bank = (n: number) => page.getByText(`tap · bank ${n} of 3`)
  await expect(bank(1)).toBeVisible()
  await page.keyboard.press('BracketRight')
  await expect(bank(2)).toBeVisible()
  await expect(pad(page, 'Spectrum bars')).toBeVisible()
  await expect(pad(page, 'Night city')).toHaveCount(0)
  await page.keyboard.press('BracketRight')
  await expect(bank(3)).toBeVisible()
  // The ends stop: past the last bank, ] stays there, so one [ goes back to bank 2.
  await page.keyboard.press('BracketRight')
  await page.keyboard.press('BracketLeft')
  await expect(bank(2)).toBeVisible()
  await page.keyboard.press('BracketLeft')
  await page.keyboard.press('BracketLeft')
  await page.keyboard.press('BracketRight')
  await expect(bank(2)).toBeVisible()
  await page.keyboard.press('BracketLeft')
  await expect(bank(1)).toBeVisible()
  await expect(pad(page, 'Night city')).toBeVisible()

  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  // Strobe (A) and RGB split (S) are held effects; Backspace lets go of both while the keys are still down.
  await page.keyboard.down('KeyA')
  await page.keyboard.down('KeyS')
  await expect(pad(page, 'Strobe')).toHaveAttribute('aria-pressed', 'true')
  await expect(pad(page, 'RGB split')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Backspace')
  await expect(pad(page, 'Strobe')).toHaveAttribute('aria-pressed', 'false')
  await expect(pad(page, 'RGB split')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.up('KeyA')
  await page.keyboard.up('KeyS')
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible()
})

async function openVjSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'VJ and MIDI' }).click()
  return dialog
}

test('Settings › VJ and MIDI names a controller once for all its ports, and undoes a mapping that replaced hand mappings', async ({
  page,
}) => {
  await plugInMidiController(page, {
    ports: [
      { id: 'lk-midi', name: 'Launchkey Mini MK3 MIDI Port' },
      { id: 'lk-daw', name: 'Launchkey Mini MK3 DAW Port' },
      { id: 'e2e-pads', name: 'E2E Pad Controller' },
    ],
  })
  await openHarness(page)
  // One pad learned by hand in VJ mode, on top of the pad controller mapping.
  await page.evaluate(() => {
    const { vj } = window.mvStudio
    const learned = vj.bindMidi(
      vj.defaultBindings(),
      { type: 'note', number: 99 },
      { kind: 'pad', row: 'looks', index: 0 },
    )
    vj.localVjStore().saveBindings(learned)
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=60'
  })
  const dialog = await openVjSettings(page)
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  const badge = dialog.getByText('Launchkey Mini MK3 +1', { exact: true })
  await expect(badge).toBeVisible()
  await expect(
    dialog.getByTitle('Launchkey Mini MK3 MIDI Port, Launchkey Mini MK3 DAW Port, E2E Pad Controller'),
  ).toContainText('Launchkey Mini MK3 +1')

  const mapping = dialog.getByRole('combobox', { name: 'MIDI mapping' })
  const handNote = dialog.getByText('1 MIDI control mapped by hand in VJ mode. Pick a mapping to replace it.')
  await expect(mapping).toHaveText('Mapped by hand')
  await expect(handNote).toBeVisible()
  await mapping.click()
  await page.getByRole('option', { name: /^Keyboard/ }).click()
  await expect(mapping).toHaveText('Keyboard')
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect(mapping).toHaveText('Mapped by hand')
  await expect(handNote).toBeVisible()
  await expect(dialog).toBeVisible()

  await mapping.click()
  await page.getByRole('option', { name: /^Pad controller/ }).click()
  await expect(page.getByText('MIDI mapping set to Pad controller')).toBeVisible()
  // Between the two default mappings there is nothing to lose, so no toast.
  await mapping.click()
  await page.getByRole('option', { name: /^Keyboard/ }).click()
  await expect(mapping).toHaveText('Keyboard')
  await expect(page.getByText('MIDI mapping set to Keyboard')).toHaveCount(0)
})

test('without Web MIDI, Settings › VJ and MIDI offers no mapping', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: undefined, configurable: true }),
  )
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=60'
  })
  const dialog = await openVjSettings(page)
  await expect(dialog.getByText('No Web MIDI', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Quantize' })).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'MIDI mapping' })).toHaveCount(0)
})

test('VJ mode offers Try again when MIDI access was blocked', async ({ page }) => {
  await plugInMidiController(page, { failFirst: { name: 'NotAllowedError', message: 'Permission denied' } })
  await openVj(page)
  await page.getByRole('button', { name: 'No MIDI device' }).click()
  await page.getByRole('menuitem', { name: /Connect a MIDI controller/ }).click()
  await page.getByRole('button', { name: 'MIDI blocked' }).click()
  await expect(page.getByRole('menuitem', { name: /MIDI access was blocked/ })).toBeDisabled()
  await page.getByRole('menuitem', { name: /^Try again/ }).click()
  await expect(page.getByRole('button', { name: 'E2E Pad Controller' })).toBeVisible()
})

/** Mean brightness (0 to 255) of what is on screen in a locator's box. */
async function brightness(page: Page, locator: ReturnType<Page['locator']>): Promise<number> {
  const png = (await locator.screenshot()).toString('base64')
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const ctx = new OffscreenCanvas(image.width, image.height).getContext(
      '2d',
    ) as OffscreenCanvasRenderingContext2D
    ctx.drawImage(image, 0, 0)
    const d = ctx.getImageData(0, 0, image.width, image.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4)
      sum += ((d[i] as number) + (d[i + 1] as number) + (d[i + 2] as number)) / 3
    return sum / (d.length / 4)
  }, png)
}

test('opened from the editor, VJ mode shows the frame at the playhead at once; leaving gives focus back to VJ', async ({
  page,
}) => {
  const problems: string[] = []
  page.on('console', (m) => {
    if (/Preview render failed|VideoFrame was garbage collected/.test(m.text())) problems.push(m.text())
  })
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=60'
  })
  await waitForPreview(page)
  const shown = await brightness(page, page.getByRole('img', { name: 'Video preview' }))
  expect(shown).toBeGreaterThan(5)

  const vjButton = page.getByRole('button', { name: 'VJ', exact: true })
  await vjButton.click()
  const live = page.getByRole('img', { name: 'Live output' })
  await expect(live).toBeVisible()
  // The live output takes a second or two to start its own renderer; meanwhile the stage shows the editor's frame.
  let busyWhenShown: string | null = null
  await expect
    .poll(async () => {
      busyWhenShown = await live.getAttribute('aria-busy')
      return brightness(page, live)
    })
    .toBeGreaterThan(shown * 0.85)
  expect(busyWhenShown).toBe('true')
  await expect(live).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 })
  await expect.poll(() => brightness(page, live)).toBeGreaterThan(shown * 0.85)

  // Leaving while playing, with frames in flight, logs no failed render or unclosed frame.
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(live).toBeHidden()
  await expect(vjButton).toBeFocused()
  // Focus from the keyboard shows the button's ring and tooltip.
  const tooltip = page.getByRole('tooltip').filter({ hasText: 'VJ mode' })
  await expect(tooltip).toHaveCount(1)

  await page.keyboard.press('Shift+KeyV')
  await expect(live).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Back to editor' }).click()
  await expect(live).toBeHidden()
  await expect(vjButton).toBeFocused()
  // After a click, the focus draws no ring, and no tooltip opens over the panels below.
  await page.waitForTimeout(700)
  await expect(tooltip).toHaveCount(0)
  await waitForPreview(page)

  // Each preview closed on the way (the editor's twice, VJ mode's twice) closed its video frames. The browser reports
  // a frame collected unclosed about 10 s after the collection.
  const cdp = await page.context().newCDPSession(page)
  for (let i = 0; i < 12; i++) {
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(1000)
  }
  expect(problems).toEqual([])
})

test('the first VJ entry keeps the editor on screen until VJ mode has loaded', async ({ page }) => {
  // VJ mode's code arrives late, as on a first visit over a slow connection.
  let delayed = 0
  await page.context().route(/\/assets\/VjMode-[^/]+\.js$/, async (route) => {
    delayed++
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=60'
  })
  await waitForPreview(page)
  // Before each paint: whether the screen's loading placeholder is up instead of a screen.
  await page.evaluate(() => {
    const w = window as unknown as { blankFrames: number }
    w.blankFrames = 0
    const tick = () => {
      if (document.querySelector('.screen-loading')) w.blankFrames++
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.getByRole('button', { name: 'VJ', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Live output' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  expect(delayed).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as unknown as { blankFrames: number }).blankFrames)).toBe(0)
})

test('opened directly, the VJ stage says it is preparing until the live output draws', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/vj?t=60'
  })
  const note = page.getByRole('status').filter({ hasText: 'Preparing the live output' })
  await expect(note).toBeVisible()
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  await expect(note).toBeHidden()
})
