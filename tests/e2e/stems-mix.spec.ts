import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

/**
 * Opens the demo project in Assist › Stems and attaches four short synthetic stems (WAV tones, no model) to its song,
 * with loudness features so the stem lanes draw them. The `broken` stem's file is overwritten with bytes no decoder reads.
 */
async function openWithStems(page: Page, broken?: string): Promise<void> {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?tab=assist&assist=stems&t=10'
  })
  await waitForPreview(page)
  await page.evaluate(async (broken) => {
    const { app, media } = window.mvStudio
    const sr = 48_000
    const n = sr * 2
    const wav = (hz: number) => {
      const data = new DataView(new ArrayBuffer(44 + n * 2))
      const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)))
      text(0, 'RIFF')
      data.setUint32(4, 36 + n * 2, true)
      text(8, 'WAVEfmt ')
      data.setUint32(16, 16, true)
      data.setUint16(20, 1, true)
      data.setUint16(22, 1, true)
      data.setUint32(24, sr, true)
      data.setUint32(28, sr * 2, true)
      data.setUint16(32, 2, true)
      data.setUint16(34, 16, true)
      text(36, 'data')
      data.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++)
        data.setInt16(44 + i * 2, Math.round(3000 * Math.sin((2 * Math.PI * hz * i) / sr)), true)
      return new Blob([data.buffer], { type: 'audio/wav' })
    }
    const editor = app.project.editor
    const song = editor.getProject().songAssetId
    const tones: Record<string, number> = { vocals: 1000, drums: 150, bass: 80, other: 300 }
    const commands: object[] = []
    const stems: Record<string, string> = {}
    const stemFeatures: Record<string, object> = {}
    for (const [i, [name, hz]] of Object.entries(tones).entries()) {
      const asset = await media.mediaStore.storeBlob(wav(hz), {
        kind: 'audio',
        name: `song (${name}).wav`,
        origin: { type: 'stem', parentAssetId: song },
      })
      if (name === broken) await media.mediaStore.restore(asset, new Blob([new Uint8Array(4096).fill(7)]))
      commands.push({ type: 'asset.add', asset })
      stems[name] = asset.id
      stemFeatures[name] = {
        rate: 4,
        loudness: Array.from({ length: 800 }, (_, k) => 0.2 + 0.7 * Math.abs(Math.sin(k / (3 + i)))),
        bands: [],
        bandEdgesHz: [],
        onsets: [],
      }
    }
    commands.push({ type: 'analysis.setStems', assetId: song, stems, stemFeatures })
    editor.dispatch(commands, { history: 'skip' })
  }, broken ?? null)
}

const undoLabel = (page: Page) => page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())
const songStems = (page: Page) =>
  page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return project.tracks.find((t: { id: string }) => t.id === 't-song')?.stems ?? null
  })

test('stem solo and mute show in Assist, the stem lanes, the song header and the export dialog', async ({
  page,
}) => {
  await openWithStems(page)
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const row = (stem: string) => panel.getByText(stem, { exact: true }).locator('xpath=..')
  const badge = page.getByText(/^Stems: /)
  const note = panel.getByRole('status')
  await expect(row('Vocals').getByRole('button', { name: 'Solo' })).toBeVisible()

  // No flags: no badge, no note, no export warning.
  await expect(badge).toHaveCount(0)
  await expect(note).toHaveCount(0)
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await expect(dialog.getByRole('button', { name: /^Export \d+ file/ })).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Solo from the panel.
  await row('Vocals').getByRole('button', { name: 'Solo' }).click()
  await expect(row('Vocals').getByRole('button', { name: 'Unsolo' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Solo vocals', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Solo drums', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(badge).toHaveText('Stems: vocals solo')
  await expect(badge).toHaveAttribute('title', 'Stems: vocals solo')
  await expect(note).toHaveText('Only the vocals play, in the preview and the export.')
  expect(await undoLabel(page)).toBe('Solo vocals')
  expect(await songStems(page)).toEqual({ vocals: { solo: true } })
  // The other stems are not heard, so their lanes are dimmed.
  const lane = (stem: string) => page.locator(`[data-stem="${stem}"]`)
  await expect(lane('drums')).toHaveClass(/rowHidden/)
  await expect(lane('vocals')).not.toHaveClass(/rowHidden/)
  await shot(page, 'stems-solo-panel')

  // At 1280x720, the narrowest panel, "Unsolo" still fits beside "Almost silent" (a soloed stem that is nearly
  // silent), and the song header shows the badge.
  const viewport = page.viewportSize()
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const analysis = project.analysis.audio[project.songAssetId]
    const vocals = analysis.stemFeatures.vocals
    editor.dispatch(
      {
        type: 'analysis.setStems',
        assetId: project.songAssetId,
        stems: analysis.stems,
        stemFeatures: {
          ...analysis.stemFeatures,
          vocals: { ...vocals, loudness: vocals.loudness.map(() => 0.01) },
        },
      },
      { history: 'skip' },
    )
  })
  await expect(row('Vocals').getByText('Almost silent')).toBeVisible()
  const unsolo = await row('Vocals').getByRole('button', { name: 'Unsolo' }).boundingBox()
  const panelBox = await panel.boundingBox()
  expect(unsolo && panelBox && unsolo.x + unsolo.width <= panelBox.x + panelBox.width).toBe(true)
  await shot(page, 'stems-solo-panel-1280x720')
  await badge.scrollIntoViewIfNeeded()
  await expect(badge).toBeInViewport()
  await shot(page, 'stems-badge-1280x720')
  if (viewport) await page.setViewportSize(viewport)

  // Mute from the drums lane.
  await page.getByRole('button', { name: 'Mute drums', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unmute drums', exact: true })).toBeVisible()
  await expect(note).toHaveText('Only the vocals play, in the preview and the export. The drums are muted.')
  await expect(badge).toHaveText('Stems: vocals solo · drums muted')
  expect(await undoLabel(page)).toBe('Mute drums')
  await lane('bass').scrollIntoViewIfNeeded()
  await shot(page, 'stems-lanes')

  // The export dialog warns, and one click plays all stems again as one undo step.
  await page.keyboard.press('ControlOrMeta+e')
  const warning = dialog.getByRole('status')
  await expect(warning).toContainText('Only the vocals will play in this export, without the drums.')
  await shot(page, 'export-stems-warning')
  await warning.getByRole('button', { name: 'Play all stems' }).click()
  await expect(warning).toHaveCount(0)
  expect(await songStems(page)).toEqual({})
  expect(await undoLabel(page)).toBe('Play all stems')
  await page.keyboard.press('Escape')
  await expect(badge).toHaveCount(0)
  await expect(note).toHaveCount(0)
  await page.evaluate(() => window.mvStudio.app.project.editor.undo())
  expect(await songStems(page)).toEqual({ vocals: { solo: true }, drums: { muted: true } })
  await expect(badge).toHaveText('Stems: vocals solo · drums muted')

  // The stem lanes follow the song's track wherever it is.
  await page.evaluate(() =>
    window.mvStudio.app.project.editor.dispatch({ type: 'track.move', trackId: 't-song', toIndex: 0 }),
  )
  const neighbors = await page.evaluate(() => {
    const name = (el: Element | null | undefined) =>
      el?.querySelector('[class*="trackName"], [class*="stemName"]')?.textContent ?? null
    const first = document.querySelector('[data-stem="vocals"]')
    const last = document.querySelector('[data-stem="other"]')
    return [name(first?.previousElementSibling), name(last?.nextElementSibling)]
  })
  expect(neighbors).toEqual(['Song', 'Lyrics'])

  // Lanes draw only measured loudness: a stem without features gets an empty clip, not made-up peaks.
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const analysis = project.analysis.audio[project.songAssetId]
    const { other: _, ...stemFeatures } = analysis.stemFeatures
    editor.dispatch(
      { type: 'analysis.setStems', assetId: project.songAssetId, stems: analysis.stems, stemFeatures },
      { history: 'skip' },
    )
  })
  await expect(lane('other').locator('canvas')).toHaveCount(0)
  await expect(lane('bass').locator('canvas')).toHaveCount(1)
})

test('the song header and Assist › Stems say the full song plays while a heard stem cannot be decoded', async ({
  page,
}) => {
  await openWithStems(page, 'vocals')
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const row = (stem: string) => panel.getByText(stem, { exact: true }).locator('xpath=..')
  const badge = page.getByText(/^Stems: /)
  const note = panel.getByRole('status')
  const scheduled = () =>
    page.evaluate(() =>
      window.mvStudio.app
        .stagePreview()
        .clock.scheduledClips.map((c: { stem?: string }) => c.stem ?? 'song')
        .join(),
    )

  await row('Vocals').getByRole('button', { name: 'Solo' }).click()
  await expect(
    page.getByText('The vocals stem could not be decoded. Playing the full song instead.'),
  ).toBeVisible()
  await expect(badge).toHaveText('Stems: full song plays · vocals solo')
  await expect(note).toHaveText('The vocals stem could not be decoded, so the preview plays the full song.')
  expect(await scheduled()).toBe('song')
  await shot(page, 'stems-fallback')

  // The drums alone decode, so they play and the texts say so.
  await row('Drums').getByRole('button', { name: 'Solo' }).click()
  await expect(badge).toHaveText('Stems: full song plays · vocals, drums solo')
  await row('Vocals').getByRole('button', { name: 'Unsolo' }).click()
  await expect(badge).toHaveText('Stems: drums solo')
  await expect(note).toHaveText('Only the drums play, in the preview and the export.')
  await expect.poll(scheduled).toBe('drums')

  // Playing all stems forgets the failure; soloing the vocals again tries them again and fails again.
  await panel.getByRole('button', { name: 'Unsolo' }).click()
  await expect(badge).toHaveCount(0)
  await row('Vocals').getByRole('button', { name: 'Solo' }).click()
  await expect(badge).toHaveText('Stems: full song plays · vocals solo')
  expect(await scheduled()).toBe('song')
})
