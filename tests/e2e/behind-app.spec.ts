import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/** Cutout clips on the Subject track, with their mattes and mask assets. */
function cutouts(page: Page) {
  return page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => c.meta?.behindSubjectOf)
      .map((c) => {
        const mask = project.assets[c.matte?.maskAssetId]
        return {
          host: c.meta.behindSubjectOf as string,
          track: project.tracks.find((t: Untyped) => t.id === c.trackId)?.name as string,
          matte: { mode: c.matte?.mode, source: c.matte?.sourceAssetId },
          mask: mask && {
            kind: mask.kind,
            parent: mask.origin.parentAssetId,
            provider: mask.origin.provider,
          },
        }
      })
  })
}

/** The person mask of the cutout of an imported clip (by file name), with what the project says it was made with. */
function cutoutMask(page: Page, name: string) {
  return page.evaluate((name) => {
    const project = window.mvStudio.app.project.editor.getProject()
    const clips = Object.values(project.clips as Record<string, Untyped>)
    const host = clips.find(
      (c) => project.assets[c.assetId]?.name?.startsWith(name) && !c.meta?.behindSubjectOf,
    )
    const id = clips.find((c) => c.meta?.behindSubjectOf === host?.id)?.matte?.maskAssetId as
      string | undefined
    if (!id) return null
    return {
      id,
      inProject: !!project.assets[id],
      made: project.extensions?.['vision.person-masks']?.[id] ?? null,
    }
  }, name)
}

async function open(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

/** Imports a clip, adds it at the playhead and selects it on the timeline. */
async function importAndSelect(page: Page, file: string, name: string) {
  await page.getByLabel('Import media files').setInputFiles(file)
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(`${name}, video`)
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const block = page.getByRole('button', { name: new RegExp(`^${name}, \\d`) })
  await expect(block).toHaveCount(1)
  await block.focus()
  await page.keyboard.press('Enter')
}

test('Assist › Behind the subject explains each shot and cuts the people out of the suitable ones', async ({
  page,
}) => {
  await open(page, '#/editor?tab=assist&assist=behind&t=66.9')
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const crowd = assist.getByText('Concert crowd', { exact: true }).locator('..').locator('..')
  await expect(crowd.getByText(/^People are too small in this wide shot\s· \d+ clips?$/)).toBeVisible()
  await expect(crowd.getByText('Not suitable')).toBeVisible()
  const singer = assist.getByText('Singer close-up', { exact: true }).locator('..').locator('..')
  await expect(singer.getByText('Suitable', { exact: true })).toBeVisible()

  const hosts = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => c.assetId === 'm-singer' || c.assetId === 'm-dancer')
      .map((c) => c.id as string)
      .sort()
  })
  expect(hosts.length).toBeGreaterThan(1)
  await assist.getByRole('button', { name: `Apply to ${hosts.length} suitable clips` }).click()
  await expect(assist.getByText(`Lyrics now sit behind the person on ${hosts.length} clips`)).toBeVisible()
  const added = await cutouts(page)
  expect(added.map((c) => c.host).sort()).toEqual(hosts)
  for (const c of added) {
    expect(c.track).toBe('Subject')
    expect(c.matte.mode).toBe('inside')
    expect(c.mask).toMatchObject({ kind: 'image', parent: c.matte.source })
  }

  await assist.getByRole('button', { name: 'Undo' }).click()
  await expect(assist.getByRole('button', { name: `Apply to ${hosts.length} suitable clips` })).toBeVisible()
  expect(await cutouts(page)).toEqual([])
})

test('an imported clip with a person is cut out with a real person mask from the inspector switch', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await open(page, '#/editor?t=10')
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  await inspector.getByRole('switch', { name: 'Put text and effects behind the subject' }).click()
  await expect(inspector.getByText('Person found')).toBeVisible({ timeout: 90_000 })
  const [cut] = await cutouts(page)
  expect(cut).toMatchObject({
    track: 'Subject',
    matte: { mode: 'inside' },
    mask: { kind: 'video', provider: 'vision.person-mask' },
  })
  expect(cut!.mask.parent).toBe(cut!.matte.source)
  await expect(page.getByRole('button', { name: /^people-interview · subject, / })).toBeVisible()
})

test('a clip with no one in it says why it cannot be cut out', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, '#/editor?t=10')
  await importAndSelect(page, path.resolve('tests/fixtures/.cache/clip.mp4'), 'clip')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  const toggle = inspector.getByRole('switch', { name: 'Put text and effects behind the subject' })
  await toggle.click()
  await expect(
    inspector.getByText(
      /^(No one in this shot is large enough to cut out|People are too small in this wide shot)\.$/,
    ),
  ).toBeVisible({
    timeout: 90_000,
  })
  await expect(toggle).not.toBeChecked()
  await expect(toggle).toBeDisabled()
  expect(await cutouts(page)).toEqual([])
})

test('a clip is cut out when the person and face detectors cannot download, says the people check was skipped, and is cut out again once back online', async ({
  page,
}) => {
  test.setTimeout(240_000)
  let blocked = 0
  const detectors = /\/(efficientdet_lite0|blaze_face_short_range)\.tflite$/
  await page.context().route(detectors, (route) => {
    blocked++
    return route.abort('internetdisconnected')
  })
  await open(page, '#/editor?t=10')
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const row = assist.getByText('people-interview', { exact: true }).locator('..').locator('..')
  const note =
    'Couldn’t check for people, so the cutout may include animals or objects. It checks again when you’re back online.'
  await expect(row.getByText('Not checked for people · 1 clip', { exact: true })).toBeVisible({
    timeout: 90_000,
  })
  // The sample clips of the demo project are suitable too.
  await assist.getByRole('button', { name: /^Apply to \d+ suitable clips$/ }).click()
  await expect(assist.getByText(`people-interview: ${note}`)).toBeVisible({ timeout: 90_000 })
  expect(await uncut(page, 'people-interview')).toEqual([expect.objectContaining({ cut: true })])
  const masks = (await cutouts(page)).filter((c) => c.mask?.provider === 'vision.person-mask')
  expect(masks).toEqual([
    expect.objectContaining({ track: 'Subject', mask: expect.objectContaining({ kind: 'video' }) }),
  ])
  expect(blocked).toBeGreaterThan(0)
  await assist.getByRole('button', { name: 'Show' }).click()

  const block = page.getByRole('button', { name: /^people-interview, \d/ })
  await block.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('tab', { name: 'Inspector' }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  // Layering opens by itself on a clip that is behind, unless the inspector kept it closed from before the cutout. A
  // click on an open section closes it, and its content stays on screen while it animates closed.
  const layering = inspector.getByRole('button', { name: 'Layering' })
  if ((await layering.getAttribute('aria-expanded')) === 'false') await layering.click()
  await expect(layering).toHaveAttribute('aria-expanded', 'true')
  await expect(
    inspector.getByRole('switch', { name: 'Put text and effects behind the subject' }),
  ).toBeChecked()
  await expect(inspector.getByText(note, { exact: true })).toBeVisible()
  const offline = await cutoutMask(page, 'people-interview')
  expect(offline).toEqual({
    id: expect.any(String),
    inProject: true,
    made: { trackVersion: expect.any(Number), peopleSkipped: true },
  })

  // Back online, the mask is made again with the person detector, and the cutout uses it. The detectors are held
  // back until the test lets them through, to see the check while it runs: the note stays until then, whatever the
  // check says meanwhile, without the promise of a check later.
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.context().unroute(detectors)
  await page.context().route(detectors, async (route) => {
    await held
    await route.continue()
  })
  await page.context().setOffline(true)
  await page.context().setOffline(false)
  await expect(inspector.getByText(/^Checking… \d+%$/)).toBeVisible()
  await expect(inspector.getByText(note.replace(/ It checks.+$/, ''), { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Assist' }).click()
  await expect(assist.getByText('Checking for people', { exact: true })).toBeVisible()
  await expect(assist.getByRole('progressbar', { name: 'Check progress' })).toBeVisible()
  await expect(assist.getByText('Cutouts made offline keep only the people once this is done.')).toBeVisible()
  await expect(assist.getByRole('button', { name: 'Cancel' })).toBeVisible()
  release()
  await expect
    .poll(
      async () => {
        const mask = await cutoutMask(page, 'people-interview')
        return mask?.id === offline!.id ? null : mask
      },
      { timeout: 120_000 },
    )
    .toEqual({ id: expect.any(String), inProject: true, made: { trackVersion: offline!.made.trackVersion } })
  await expect(row.getByText(/^(Person found|Works in parts of this shot.+)\s· 1 clip$/)).toBeVisible({
    timeout: 90_000,
  })
  // The mask made offline stays while an undo can bring back a cutout that used it.
  expect(
    await page.evaluate((id) => id in window.mvStudio.app.project.editor.getProject().assets, offline!.id),
  ).toBe(true)
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await expect(inspector.getByText(/^Couldn’t check for people/)).toBeHidden()
  await expect(inspector.getByText('Person found', { exact: true })).toBeVisible()
})

test('Assist › Behind the subject does not offer a shot of an animal, which the person segmenter cuts out, and says it found no person', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await open(page, '#/editor?t=10')
  await importAndSelect(page, path.resolve('tests/fixtures/animal-horse.webm'), 'animal-horse')
  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const row = assist.getByText('animal-horse', { exact: true }).locator('..').locator('..')
  await expect(row.getByText('Couldn’t find a person to cut out in this shot · 1 clip')).toBeVisible({
    timeout: 90_000,
  })
  await expect(row.getByText('Not suitable')).toBeVisible()
})

/**
 * Model-free vision: the quick check finds a person, but the export track's detector finds no one, as when a shot is
 * offered and the cutout then turns it down.
 */
const offeredThenRefused = (page: Page) => modelFreeVision(page, { trackFindsPeople: false })

/**
 * Model-free vision with a person in every frame of the quick check (before `personUntil` seconds of the footage
 * when set). The export track finds them too when `trackFindsPeople`, and with `popEvery` its stored pops say the
 * cutout pops in every nth frame.
 */
async function modelFreeVision(
  page: Page,
  opts: { trackFindsPeople: boolean; popEvery?: number; personUntil?: number },
) {
  await page.evaluate((opts) => {
    const { vision } = window.mvStudio
    const hang = () => new Promise(() => undefined)
    const until = opts.personUntil ?? Infinity
    let at = 0
    const person = (width: number, height: number) => {
      const data = new Uint8Array(width * height)
      if (at < until)
        for (let y = Math.floor(height * 0.15); y < height; y++)
          data.fill(255, y * width + Math.floor(width * 0.35), y * width + Math.floor(width * 0.65))
      return { width, height, data }
    }
    let track: Untyped
    const seg: Record<string, (...args: Untyped[]) => Promise<Untyped>> = {
      configure: async () => undefined,
      resetStream: async () => undefined,
      analyze: async (req) => {
        const size = req.maskSize ?? { width: req.bitmap.width, height: req.bitmap.height }
        req.bitmap.close()
        at = req.timestampMs / 1000
        return {
          ...(req.mask ? { mask: person(size.width, size.height) } : {}),
          ...(req.people
            ? { people: at < until ? [{ box: { x: 0.3, y: 0.1, width: 0.4, height: 0.9 }, score: 0.9 }] : [] }
            : {}),
          ...(req.faces ? { faces: [] } : {}),
        }
      },
      beginTrack: async ({ meta }) => {
        track = vision.createPackedTrack(meta)
        return { id: 1 }
      },
      pushTrackFrame: async (req) => {
        req.bitmap.close()
        at = req.timestampMs / 1000
        const { width, height } = track.meta.maskSize
        vision.appendFrame(track, person(width, height), 0.26)
        return {
          coverage: 0.26,
          box: { x: 0.35, y: 0.15, width: 0.3, height: 0.85 },
          usedHq: false,
          ...(req.faces ? { faces: [] } : {}),
          ...(req.people
            ? {
                people:
                  opts.trackFindsPeople && at < until
                    ? [{ box: { x: 0.3, y: 0.1, width: 0.4, height: 0.9 }, score: 0.9 }]
                    : [],
              }
            : {}),
        }
      },
      endTrack: async () => {
        const every = opts.popEvery
        track.meta.pops = Array.from({ length: track.meta.frameCount }, (_, i) =>
          every && i % every === 0 ? 0.2 : 0,
        )
        const box = { x: 0.35, y: 0.15, width: 0.3, height: 0.85 }
        return { track, boxes: Array.from({ length: track.meta.frameCount }, () => box) }
      },
      cancelTrack: async () => undefined,
    }
    window.mvStudio.app.footage.setVisionBackendsForTests({
      segmentation: () =>
        new Proxy(seg, { get: (t, key) => (key === 'then' ? undefined : (t[key as string] ?? hang)) }),
      onnx: () => new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : hang) }) as Untyped,
    })
  }, opts)
}

/** Clips of an imported asset (by file name) that got no cutout. */
function uncut(page: Page, name: string) {
  return page.evaluate((name) => {
    const project = window.mvStudio.app.project.editor.getProject()
    const clips = Object.values(project.clips as Record<string, Untyped>)
    const hosts = new Set(clips.map((c) => c.meta?.behindSubjectOf).filter(Boolean))
    return clips
      .filter((c) => project.assets[c.assetId]?.name?.startsWith(name) && !c.meta?.behindSubjectOf)
      .map((c) => ({ id: c.id as string, cut: hosts.has(c.id) }))
  }, name)
}

test('a shot the check offers but the cutout turns down says why in the inspector', async ({ page }) => {
  await open(page, '#/editor?t=10')
  await offeredThenRefused(page)
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  const toggle = inspector.getByRole('switch', { name: 'Put text and effects behind the subject' })
  await toggle.click()
  await expect(
    page.getByRole('status').getByText('On a closer look, the cutout couldn’t find a person in this shot.'),
  ).toBeVisible()
  await expect(toggle).not.toBeChecked()
  expect(await uncut(page, 'people-interview')).toEqual([expect.objectContaining({ cut: false })])
})

test('Assist › Behind the subject lists a shot the cutout turned down, with why', async ({ page }) => {
  await open(page, '#/editor?t=10')
  await offeredThenRefused(page)
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const row = assist.getByText('people-interview', { exact: true }).locator('..').locator('..')
  await expect(row.getByText('Suitable', { exact: true })).toBeVisible()
  await assist.getByRole('button', { name: /^Apply to \d+ suitable clips?$/ }).click()
  await expect(
    assist.getByText('people-interview: On a closer look, the cutout couldn’t find a person in this shot.'),
  ).toBeVisible()
  expect(await uncut(page, 'people-interview')).toEqual([expect.objectContaining({ cut: false })])
})

test('a shot the check finds a person in only in parts says the cutout may still turn it down, and then says why it did', async ({
  page,
}) => {
  await open(page, '#/editor?t=10')
  // The check finds a person in the first half of the 3 s clip; the cutout's detector finds no one.
  await modelFreeVision(page, { trackFindsPeople: false, personUntil: 1.5 })
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const row = assist.getByText('people-interview', { exact: true }).locator('..').locator('..')
  await expect(
    row.getByText('Works in parts of this shot, may change on a closer look · 1 clip'),
  ).toBeVisible()
  await expect(row.getByText('Suitable', { exact: true })).toBeVisible()

  const [host] = await uncut(page, 'people-interview')
  await page.evaluate((id) => (window.location.hash = `#/editor?sel=clip:${id}&t=10`), host!.id)
  await page.getByRole('tab', { name: 'Inspector' }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  await expect(
    inspector.getByText(
      'Works in parts of this shot. In the other parts, no one is large enough to cut out. The cutout takes a closer look and may still turn it down.',
      { exact: true },
    ),
  ).toBeVisible()

  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  await assist.getByRole('button', { name: /^Apply to \d+ suitable clips?$/ }).click()
  await expect(
    assist.getByText('people-interview: On a closer look, the cutout couldn’t find a person in this shot.'),
  ).toBeVisible()
  expect(await uncut(page, 'people-interview')).toEqual([expect.objectContaining({ cut: false })])
})

test('Assist › Behind the subject cuts out a shot whose cutout flickers, and then says so', async ({
  page,
}) => {
  await open(page, '#/editor?t=10')
  await modelFreeVision(page, { trackFindsPeople: true, popEvery: 4 })
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const row = assist.getByText('people-interview', { exact: true }).locator('..').locator('..')
  await expect(row.getByText('Person found · 1 clip')).toBeVisible()
  await assist.getByRole('button', { name: /^Apply to \d+ suitable clips?$/ }).click()
  await expect(
    assist.getByText(
      'people-interview: The cutout flickers in places, so the lyrics can blink around the person for a moment.',
    ),
  ).toBeVisible()
  expect(await uncut(page, 'people-interview')).toEqual([expect.objectContaining({ cut: true })])
})

test('the inspector says a cutout flickers when it lands, and keeps saying so while the clip is behind', async ({
  page,
}) => {
  await open(page, '#/editor?t=10')
  await modelFreeVision(page, { trackFindsPeople: true, popEvery: 4 })
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  const toggle = inspector.getByRole('switch', { name: 'Put text and effects behind the subject' })
  await toggle.click()
  const why = 'The cutout flickers in places, so the lyrics can blink around the person for a moment.'
  await expect(
    page.getByRole('status').getByText(`Lyrics now sit behind the person on this clip. ${why}`),
  ).toBeVisible()
  await expect(toggle).toBeChecked()
  await expect(inspector.getByText(why, { exact: true })).toBeVisible()
})

test('a clip that shows part of its footage is judged on that part, in Assist and in the inspector', async ({
  page,
}) => {
  await open(page, '#/editor?t=10')
  // A person in the first half of the 3 s clip only.
  await modelFreeVision(page, { trackFindsPeople: true, personUntil: 1.5 })
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  // Split it in the middle: the first part shows the person, the second shows no one.
  const [host] = await uncut(page, 'people-interview')
  await page.evaluate((id) => (window.location.hash = `#/editor?sel=clip:${id}&t=11.6`), host!.id)
  await page.keyboard.press('s')
  await expect(page.getByRole('button', { name: /^people-interview, \d/ })).toHaveCount(2)

  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const rows = assist.getByText('people-interview', { exact: true }).locator('..').locator('..')
  await expect(rows.getByText('Person found · 1 clip')).toBeVisible()
  await expect(rows.getByText('No one in this shot is large enough to cut out · 1 clip')).toBeVisible()
  await assist.getByRole('button', { name: /^Apply to \d+ suitable clips$/ }).click()
  await expect(assist.getByText(/^Lyrics now sit behind the person on \d+ clips$/)).toBeVisible()
  const parts = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const clips = Object.values(project.clips as Record<string, Untyped>)
    const hosts = new Set(clips.map((c) => c.meta?.behindSubjectOf).filter(Boolean))
    return clips
      .filter(
        (c) => project.assets[c.assetId]?.name?.startsWith('people-interview') && !c.meta?.behindSubjectOf,
      )
      .sort((a, b) => a.start - b.start)
      .map((c) => hosts.has(c.id))
  })
  expect(parts).toEqual([true, false])

  const second = page.getByRole('button', { name: /^people-interview, \d/ }).nth(1)
  await second.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('tab', { name: 'Inspector' }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Layering' }).click()
  await expect(inspector.getByText('No one in this shot is large enough to cut out.')).toBeVisible()
  await expect(
    inspector.getByRole('switch', { name: 'Put text and effects behind the subject' }),
  ).toBeDisabled()
})

test('while clips are being checked, the top bar opens Behind the subject, not Export', async ({ page }) => {
  await open(page, '#/editor?t=10')
  await page.evaluate(() => {
    const hang = () => new Promise(() => undefined)
    window.mvStudio.app.footage.setVisionBackendsForTests({
      segmentation: () =>
        new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : hang) }) as Untyped,
      onnx: () => new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : hang) }) as Untyped,
    })
  })
  await importAndSelect(page, path.resolve('tests/fixtures/people-interview.webm'), 'people-interview')
  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=behind&t=10'))
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const row = assist.getByText('people-interview', { exact: true }).locator('..').locator('..')
  await expect(row.getByText('Checking…')).toBeVisible()

  await page.getByRole('tab', { name: 'Inspector' }).click()
  await page
    .getByRole('banner')
    .getByRole('button', { name: /Looking for a person in the clip/ })
    .click()
  await expect(assist.getByText('Text sits between the person and the background')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeHidden()
})

test('a clip name cut short in Behind the subject’s list shows in full on hover', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await open(page, '#/editor?tab=assist&assist=behind&t=10')
  const name = page
    .getByRole('tabpanel', { name: 'Assist' })
    .getByText('Aurora over the city', { exact: true })
  await expect(name).toBeVisible()
  // At 1280×720 the name doesn't fit its row and ends in an ellipsis.
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expect(name).toHaveAttribute('title', 'Aurora over the city')
})
