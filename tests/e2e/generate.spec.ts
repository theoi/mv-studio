import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, openApp, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * Assist › Generate with the real fal.ai client. CI has no fal.ai key, so fal.ai's queue, storage and file hosts are
 * answered at the network level in the shapes fal.ai documents (CORS headers included).
 */

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/.cache')
const KEY = '11111111-2222-3333-4444-555555555555:0123456789abcdef0123456789abcdef'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
}

type Status = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'

interface Fal {
  /** Statuses for successive polls of a request; the last one repeats. */
  statuses: Status[]
  /** Answer to the submit request instead of queueing it. */
  submitError?: { status: number; body: unknown }
  output: 'image' | 'video'
  submits: { endpoint: string; input: Record<string, unknown> }[]
  cancels: string[]
  uploads: string[]
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) })

async function mockFal(
  page: Page,
  init: Partial<Pick<Fal, 'statuses' | 'submitError' | 'output'>> = {},
): Promise<Fal> {
  const fal: Fal = {
    statuses: ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'],
    output: 'image',
    ...init,
    submits: [],
    cancels: [],
    uploads: [],
  }
  const polls = new Map<string, number>()
  let next = 1
  const context = page.context()
  await context.route('https://queue.fal.run/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const parts = new URL(request.url()).pathname.split('/').filter(Boolean)
    const at = parts.indexOf('requests')
    if (request.method() === 'POST' && at < 0) {
      if (fal.submitError) return json(route, fal.submitError.status, fal.submitError.body)
      const id = `req-${next++}`
      fal.submits.push({ endpoint: parts.join('/'), input: request.postDataJSON() })
      const base = `https://queue.fal.run/${parts.slice(0, 2).join('/')}/requests/${id}`
      return json(route, 200, {
        request_id: id,
        status: 'IN_QUEUE',
        response_url: base,
        status_url: `${base}/status`,
        cancel_url: `${base}/cancel`,
      })
    }
    const id = parts[3] ?? ''
    if (parts[4] === 'status') {
      const n = polls.get(id) ?? 0
      polls.set(id, n + 1)
      const status = fal.statuses[Math.min(n, fal.statuses.length - 1)] ?? 'COMPLETED'
      return json(route, 200, { status, ...(status === 'IN_QUEUE' ? { queue_position: 2 - n } : {}) })
    }
    if (parts[4] === 'cancel') {
      fal.cancels.push(id)
      return json(route, 202, { status: 'CANCELLATION_REQUESTED' })
    }
    return json(
      route,
      200,
      fal.output === 'image'
        ? {
            images: [
              {
                url: 'https://v3.fal.media/files/mock/result.png',
                width: 1280,
                height: 720,
                content_type: 'image/png',
              },
            ],
            has_nsfw_concepts: [false],
            seed: 7,
          }
        : { video: { url: 'https://v3.fal.media/files/mock/result.mp4', content_type: 'video/mp4' } },
    )
  })
  await context.route('https://rest.fal.ai/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = request.postDataJSON() as { file_name: string }
    return json(route, 200, {
      upload_url: 'https://v3.fal.media/upload/up1?sig=x',
      file_url: `https://v3.fal.media/files/up1/${body.file_name}`,
    })
  })
  await context.route('https://v3.fal.media/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (request.method() === 'PUT') {
      fal.uploads.push(request.url())
      return route.fulfill({ status: 200, headers: CORS, body: '' })
    }
    const video = request.url().endsWith('.mp4')
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: video ? 'video/mp4' : 'image/png',
      body: readFileSync(path.join(FIXTURES, video ? 'clip.mp4' : 'image.png')),
    })
  })
  return fal
}

/** Opens Assist › Generate on the sample project with the playhead at 12 s, with or without a saved fal.ai key. */
async function openGenerate(page: Page, settings: Record<string, unknown> | null, { harness = false } = {}) {
  await page.addInitScript((saved) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    if (saved) localStorage.setItem('mv-studio.cloud.v1', JSON.stringify(saved))
  }, settings)
  await (harness ? openHarness(page) : openApp(page))
  await page.evaluate(() => {
    window.location.hash = '#/editor?tab=assist&assist=generate&t=12'
  })
  await waitForPreview(page)
  await expect(page.getByText('AI images and clips with fal.ai')).toBeVisible()
}

const timelineClip = (page: Page, name: string, at: string) => page.locator(`[aria-label^="${name}, ${at}"]`)
const libraryCard = (page: Page, name: string) => page.locator(`[aria-label="${name}, generated"]`)

/**
 * Whether the preview shows the red bar on the left of the generated test image. Read from a screenshot because the
 * preview may render in a worker.
 */
async function previewShowsRed(page: Page): Promise<boolean> {
  const png = await page.getByRole('img', { name: 'Video preview' }).screenshot()
  const [r = 0, g = 0, b = 0] = await page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
    if (!ctx) return []
    ctx.drawImage(bitmap, 0, 0)
    return [...ctx.getImageData(Math.floor(bitmap.width * 0.07), Math.floor(bitmap.height * 0.6), 1, 1).data]
  }, png.toString('base64'))
  return r > 200 && g < 80 && b < 80
}

test('without a key, Generate says what it costs and opens Settings to connect fal.ai', async ({ page }) => {
  const fal = await mockFal(page)
  await openGenerate(page, null)
  await expect(page.getByText('About $0.20 per 5 s clip, charged by fal.ai to your key')).toBeVisible()
  await page.getByRole('radio', { name: 'Image' }).click()
  await expect(page.getByText('Under $0.01 per image, charged by fal.ai to your key')).toBeVisible()
  await page.getByRole('button', { name: 'Connect fal.ai to generate' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Settings' }).getByRole('heading', { name: 'AI and cloud' }),
  ).toBeVisible()
  expect(fal.submits).toHaveLength(0)
})

test('an image goes through fal.ai’s queue and lands in Media and at the playhead as one undo step', async ({
  page,
}, testInfo) => {
  const fal = await mockFal(page, { statuses: ['IN_QUEUE', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'] })
  await openGenerate(page, { falKey: KEY })
  await page.getByRole('radio', { name: 'Image' }).click()
  const generate = page.getByRole('button', { name: /^Generate · / })
  await expect(generate).toBeDisabled()
  await page.getByRole('textbox', { name: 'Describe the shot' }).fill('Neon city skyline at night')
  await expect(generate).toHaveText('Generate · under $0.01')
  await expect(page.getByText('1 MP × $0.003, charged by fal.ai to your key')).toBeVisible()
  expect(await previewShowsRed(page)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('generate-idle-1440x900.png') })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.screenshot({ path: testInfo.outputPath('generate-idle-1280x720.png') })
  await page.setViewportSize({ width: 1440, height: 900 })

  await generate.click()
  await expect(page.getByText('Waiting in line at fal.ai (2 ahead)')).toBeVisible()
  await expect(
    page.getByText('Cancelling stops the request if it is still waiting in line.', { exact: false }),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('generate-running-1440x900.png') })
  const added = page.locator('[data-toast]').filter({ hasText: 'Added AI image: Neon city skyline at night' })
  await expect(added).toBeVisible({ timeout: 20_000 })
  // The pointer on the toast keeps it open past the 5.2 s it otherwise lasts.
  await added.hover()
  const hoveredAt = Date.now()
  await expect.poll(() => previewShowsRed(page), { timeout: 10_000 }).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('generate-done-1440x900.png') })

  expect(fal.submits).toEqual([
    {
      endpoint: 'fal-ai/flux/schnell',
      input: expect.objectContaining({
        prompt: 'Neon city skyline at night',
        image_size: { width: 1280, height: 720 },
        num_images: 1,
      }),
    },
  ])
  const name = 'AI image: Neon city skyline at night'
  await expect(timelineClip(page, name, '0:12.0 to 0:16.0')).toHaveCount(1)
  await expect(libraryCard(page, name)).toHaveCount(1)
  await page.waitForTimeout(Math.max(0, 6000 - (Date.now() - hoveredAt)))
  await expect(added).toBeVisible()

  // Show in the toast selects the new clip. Focus stays on Show, which keeps the toast open with the pointer away.
  await added.getByRole('button', { name: 'Show', exact: true }).click()
  await expect(timelineClip(page, name, '0:12.0 to 0:16.0')).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByRole('tabpanel', { name: 'Inspector' }).getByText(name, { exact: true }),
  ).toBeVisible()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(6000)
  await expect(added).toBeVisible()

  // The result card in Assist has Show too, and it leaves the panel and its focus where they are.
  const assistTab = page.getByRole('tab', { name: 'Assist' })
  await assistTab.click()
  const cardShow = page
    .getByRole('tabpanel', { name: 'Assist' })
    .getByRole('button', { name: 'Show', exact: true })
  await cardShow.click()
  await expect(cardShow).toBeFocused()
  await expect(assistTab).toHaveAttribute('aria-selected', 'true')
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.screenshot({ path: testInfo.outputPath('generate-done-card-1280x720.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(timelineClip(page, name, '0:12.0 to 0:16.0')).toHaveAttribute('aria-pressed', 'true')

  // Undo in the toast puts focus back where it was before it came into the toast.
  await added.getByRole('button', { name: 'Undo', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(added).toHaveCount(0)
  await expect(cardShow).toBeFocused()
  await expect(timelineClip(page, name, '0:12')).toHaveCount(0)
  await expect(libraryCard(page, name)).toHaveCount(0)
  await expect.poll(() => previewShowsRed(page)).toBe(false)
  await cardShow.click()
  await expect(page.getByText('That clip is no longer in the project', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Generate another' }).click()
  await expect(page.getByRole('button', { name: /^Generate · / })).toBeVisible()
})

test('Show says when the new clip is on a hidden track, and Show track brings the track back', async ({
  page,
}) => {
  await mockFal(page)
  await openGenerate(page, { falKey: KEY }, { harness: true })
  await page.getByRole('radio', { name: 'Image' }).click()
  await page.getByRole('textbox', { name: 'Describe the shot' }).fill('Rain on a window')
  await page.getByRole('button', { name: /^Generate · / }).click()
  const added = page.locator('[data-toast]').filter({ hasText: 'Added AI image: Rain on a window' })
  await expect(added).toBeVisible({ timeout: 20_000 })
  const shownAt = Date.now()
  await added.hover()

  // Hide the track the result landed on (the result card's Show selects it).
  await page
    .getByRole('tabpanel', { name: 'Assist' })
    .getByRole('button', { name: 'Show', exact: true })
    .click()
  await added.hover()
  const trackName = await page.evaluate(() => {
    const { project, ui } = window.mvStudio.app
    const selection = ui.get().selection
    const p = project.editor.getProject()
    const clip = selection.type === 'clip' ? p.clips[selection.id] : undefined
    const track = (p.tracks as { id: string; name: string }[]).find((t) => t.id === clip?.trackId)
    if (!track) throw new Error('The result is not selected')
    project.dispatch({ type: 'track.update', trackId: track.id, patch: { hidden: true } })
    return track.name
  })
  const hidden = () =>
    page.evaluate(
      (n) =>
        window.mvStudio.app.project.editor
          .getProject()
          .tracks.find((t: { name: string; hidden: boolean }) => t.name === n)?.hidden,
      trackName,
    )

  await added.getByRole('button', { name: 'Show', exact: true }).click()
  const note = page.locator('[data-toast]').filter({ hasText: 'It’s on a hidden track' })
  await expect(note).toBeVisible()
  await note.getByRole('button', { name: 'Show track', exact: true }).click()
  expect(await hidden()).toBe(false)
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe(`Show ${trackName}`)

  // Focus came back to Show, which holds the toast. With the pointer and focus away, it gets its full time again,
  // counted from then, and closes.
  await page.waitForTimeout(Math.max(0, 6000 - (Date.now() - shownAt)))
  await page.mouse.move(0, 0)
  await page.getByRole('tab', { name: 'Assist' }).focus()
  await page.waitForTimeout(3000)
  await expect(added).toBeVisible()
  await expect(added).toBeHidden({ timeout: 4000 })
})

test('asks before spending when Settings says so, and Cancel stops the request at fal.ai', async ({
  page,
}, testInfo) => {
  const fal = await mockFal(page, { statuses: ['IN_PROGRESS'], output: 'video' })
  await openGenerate(page, { falKey: KEY, alwaysConfirmPaid: true })
  await page.getByRole('textbox', { name: 'Describe the shot' }).fill('Slow aerial over a neon city')
  await page.getByRole('button', { name: 'Generate · about $0.20' }).click()
  const dialog = page.getByRole('dialog', { name: 'Generate a video for about $0.20?' })
  await expect(
    dialog.getByText('5 s × $0.04/s at 768p, charged by fal.ai to your key.', { exact: false }),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('generate-confirm-1440x900.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(fal.submits).toHaveLength(0)

  await page.getByRole('button', { name: 'Generate · about $0.20' }).click()
  await dialog.getByRole('button', { name: 'Generate · about $0.20' }).click()
  await expect(page.getByText('Generating, usually about 2 min')).toBeVisible()
  await expect(page.getByText('About 2 min left')).toBeVisible()
  expect(fal.submits[0]).toMatchObject({
    endpoint: 'minimax/h3-max-turbo/text-to-video',
    input: { prompt: 'Slow aerial over a neon city', duration: 5, resolution: '768P', aspect_ratio: '16:9' },
  })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Generate · about $0.20' })).toBeVisible()
  await expect.poll(() => fal.cancels).toEqual(['req-1'])
  await expect(page.locator('[aria-label^="AI video: "]')).toHaveCount(0)
})

test('errors say what to do: a rejected key opens Settings, and Try again recovers from a fal.ai outage', async ({
  page,
}, testInfo) => {
  const fal = await mockFal(page, {
    submitError: { status: 401, body: { detail: 'invalid key credentials' } },
  })
  await openGenerate(page, { falKey: KEY })
  await page.getByRole('radio', { name: 'Image' }).click()
  await page.getByRole('textbox', { name: 'Describe the shot' }).fill('Rain on a window')
  await page.getByRole('button', { name: /^Generate · / }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('fal.ai rejected the key')
  await expect(alert).toContainText('Your project is unchanged.')
  await expect(page.getByText('Paste it in Settings › AI and cloud and choose Test key.')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('generate-failed-key-1440x900.png') })
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')

  fal.submitError = { status: 500, body: { detail: 'Internal server error' } }
  await page.getByRole('button', { name: /^Generate · / }).click()
  await expect(page.getByRole('alert')).toContainText('fal.ai had a problem')
  await expect(page.getByText('Choose Retry in a moment.')).toBeVisible()
  fal.submitError = undefined
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Added AI image: Rain on a window', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(timelineClip(page, 'AI image: Rain on a window', '0:12.0')).toHaveCount(1)
})

test('a video from one of your images uploads the image and lands as a video clip', async ({ page }) => {
  const fal = await mockFal(page, { output: 'video' })
  await openGenerate(page, { falKey: KEY })
  await page.getByRole('combobox', { name: 'Start image' }).click()
  await page.getByRole('option', { name: 'Rooftop sunset (image)' }).click()
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveText('MiniMax H3 Max Turbo · fast')
  await page.getByRole('combobox', { name: 'Length' }).click()
  await page.getByRole('option', { name: '3 s' }).click()
  await page.getByRole('textbox', { name: 'Describe the shot' }).fill('Clouds drift past the sun')
  await page.getByRole('button', { name: 'Generate · about $0.12' }).click()
  await expect(page.getByText('Added AI video: Clouds drift past the sun', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  expect(fal.uploads).toHaveLength(1)
  expect(fal.submits).toEqual([
    {
      endpoint: 'minimax/h3-max-turbo/image-to-video',
      input: expect.objectContaining({
        prompt: 'Clouds drift past the sun',
        image_url: expect.stringMatching(/^https:\/\/v3\.fal\.media\/files\/up1\//),
        duration: 3,
      }),
    },
  ])
  await expect(timelineClip(page, 'AI video: Clouds drift past the sun', '0:12.0')).toHaveCount(1)
})

/** Opens the sample project at `hash` with the e2e harness, with a saved fal.ai key unless `key` is false. */
async function openWithKey(page: Page, hash: string, key = true) {
  await page.addInitScript(
    (saved) => {
      localStorage.setItem('mv-studio.guide-seen', '1')
      if (saved) localStorage.setItem('mv-studio.cloud.v1', JSON.stringify(saved))
    },
    key ? { falKey: KEY } : null,
  )
  await openHarness(page)
  await page.evaluate((h) => (window.location.hash = h), hash)
  await waitForPreview(page)
}

/** The track of the clip named `name`, and whether it is layered above the footage track. */
function trackOf(page: Page, name: string) {
  return page.evaluate((n) => {
    type Clip = { name?: string; trackId: string }
    const project = window.mvStudio.app.project.editor.getProject()
    const clip = Object.values(project.clips as Record<string, Clip>).find((c) => c.name === n)
    const index = (id: string | undefined) =>
      (project.tracks as { id: string }[]).findIndex((t) => t.id === id)
    return { trackId: clip?.trackId, above: index(clip?.trackId) < index('t-video') }
  }, name)
}

test('Animate with AI in the image inspector makes a video from the still that lands over it', async ({
  page,
}) => {
  const fal = await mockFal(page, { output: 'video' })
  // A Rooftop sunset still at 0:28, with the playhead elsewhere.
  await openWithKey(page, '#/editor?sel=clip:c-s-v1-3&t=12')
  await page.getByRole('button', { name: 'Animate with AI' }).click()
  await expect(page.getByText('AI images and clips with fal.ai')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Video clip' })).toBeChecked()
  await expect(page.getByRole('combobox', { name: 'Start image' })).toHaveText('Rooftop sunset (image)')
  await expect(page.getByText('Results land in Media › Generated and at 0:28, over the image.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Describe the shot' }).fill('The sun sinks behind the towers')
  await page.getByRole('button', { name: /^Generate · / }).click()
  const name = 'AI video: The sun sinks behind the towers'
  await expect(page.getByText(`Added ${name}`, { exact: true })).toBeVisible({ timeout: 20_000 })
  expect(fal.uploads).toHaveLength(1)
  expect(fal.submits[0]?.endpoint).toMatch(/\/image-to-video$/)
  await expect(timelineClip(page, name, '0:28.0')).toHaveCount(1)
  expect((await trackOf(page, name)).above).toBe(true)
})

test('Generate a shot here: right-click an empty stretch of a track, and the shot lands there, trimmed to fit', async ({
  page,
}) => {
  const fal = await mockFal(page)
  await openWithKey(page, '#/editor?t=60', false)
  const spectrum = timelineClip(page, 'Spectrum bars', '1:04.0')
  const box = await spectrum.boundingBox()
  if (!box) throw new Error('The spectrum clip is not on screen')

  // A clip keeps its own menu.
  await spectrum.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: /^Split at playhead/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^Generate a shot here/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The empty stretch of the Overlay track just before it, between the title and the spectrum.
  await page.mouse.click(box.x - 20, box.y + box.height / 2, { button: 'right' })
  const item = page.getByRole('menuitem', { name: /^Generate a shot here/ })
  // Without fal.ai the item still leads on, to connecting it, and keeps the place.
  await expect(item).toContainText(/AI image or clip at 1:0\d · needs fal\.ai/)
  await expect(item).toBeEnabled()
  await item.click()
  await expect(page.getByText('AI images and clips with fal.ai')).toBeVisible()
  const note = page.getByText(
    /^Results land in Media › Generated and at 1:0\d on Overlay, in the gap up to 1:04\.$/,
  )
  await expect(note).toBeVisible()
  await page.getByRole('button', { name: 'Connect fal.ai to generate' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('textbox', { name: 'fal.ai key' }).fill(KEY)
  await page.keyboard.press('Enter')
  await expect(settings.getByText('Connected', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(note).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use the playhead instead' })).toBeVisible()
  await page.getByRole('radio', { name: 'Image' }).click()
  await page.getByRole('textbox', { name: 'Describe the shot' }).fill('Neon rain')
  await page.getByRole('button', { name: /^Generate · / }).click()
  const name = 'AI image: Neon rain'
  await expect(page.getByText(`Added ${name}`, { exact: true })).toBeVisible({ timeout: 20_000 })
  expect(fal.submits).toHaveLength(1)
  // Trimmed to end where the spectrum starts, on the track that was right-clicked.
  await expect(page.locator(`[aria-label^="${name}, 1:0"][aria-label$=" to 1:04.0"]`)).toHaveCount(1)
  expect((await trackOf(page, name)).trackId).toBe('t-overlay')
})
