import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, Route, TestInfo } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'
import { FIXTURE_DIR } from './global-setup.ts'

/*
 * Assist › Director with the real director on the sample project. Language models and fal.ai are answered at the
 * network level, as Ollama and fal.ai answer; no keys or model servers are needed.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
}

const OLLAMA = { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' }

async function openDirector(page: Page, cloud?: Record<string, unknown>, kind = 'ai') {
  // Ollama's own API (the context check before a long request) answers as an Ollama without it, so an Ollama running
  // on this computer stays out of the test.
  await page
    .context()
    .route('http://localhost:11434/api/**', (route) => route.fulfill({ status: 404, headers: CORS }))
  await openHarness(page)
  await page.evaluate((settings) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    if (settings) localStorage.setItem('mv-studio.cloud.v1', JSON.stringify(settings))
  }, cloud)
  if (cloud) {
    await page.reload()
    await page.waitForFunction(() => window.mvStudio?.ready === true)
  }
  await page.evaluate((k) => {
    window.location.hash = `#/editor?kind=${k}&tab=assist&assist=director`
  }, kind)
  await expect(page.getByRole('button', { name: 'Draft video' })).toBeVisible()
  // Screenshots of the panel are reviewed with the preview beside it.
  await expect(page.getByText('Preparing the preview')).toBeHidden()
}

/** Clips the director made (they carry meta.director), and the editor's undo label. */
const draftState = (page: Page) =>
  page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const clips = Object.values(project.clips) as { id: string; meta?: { director?: unknown } }[]
    const ours = clips.filter((c) => c.meta?.director)
    return {
      clips: clips.length,
      director: ours.length,
      ids: ours.map((c) => c.id).sort(),
      hiddenTracks: (project.tracks as { hidden: boolean }[]).filter((t) => t.hidden).length,
      undo: editor.undoLabel() as string | undefined,
    }
  })

async function recordRequests(
  page: Page,
  url: string | RegExp,
  answer: (route: Route) => Promise<void> | void,
) {
  const seen: string[] = []
  await page.context().route(url, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    seen.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return answer(route)
  })
  return seen
}

const placed = (page: Page) => page.getByText(/^Placed \d+ (shots|scenes)/)

test('drafts a lyric video on this device, lists the plan, and undoes it', async ({ page }, testInfo) => {
  await openDirector(page, undefined, 'lyric')
  const note = page.getByText('The built-in planner writes the plan.', { exact: false })
  await expect(note).toBeVisible()
  // The note wraps; its icon keeps its size and sits on the first line.
  const icon = (await page.locator('[class*="plannerRow"] svg').boundingBox())!
  const lines = (await note.boundingBox())!
  expect(lines.height).toBeGreaterThan(24)
  expect(icon.width).toBe(14)
  expect(Math.abs(icon.y + icon.height / 2 - (lines.y + 8))).toBeLessThan(1.5)
  await expect(page.getByText('Runs on this device with your clips · free')).toBeVisible()
  const before = await draftState(page)
  expect(before.director).toBe(0)

  await page.getByRole('textbox', { name: 'Idea for the video' }).fill('neon night drive')
  await page.getByRole('button', { name: 'Draft video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  await expect(placed(page)).toHaveText(/^Placed \d+ shots, \d+ lyric lines and the .+ look$/)
  await expect(page.getByText('The plan')).toBeVisible()
  await expect(
    page.getByText(/cuts (on every beat|every 2 beats|every bar|every 2 bars)/).first(),
  ).toBeVisible()
  const after = await draftState(page)
  expect(after.director).toBeGreaterThan(10)
  expect(after.undo).toBe('Director: neon night drive')
  // The sample's own tracks are covered by the draft's shots, so the same step hides them.
  expect(after.hiddenTracks).toBeGreaterThan(before.hiddenTracks)
  await expect(page.getByText('Your own tracks are kept below the draft, hidden.')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('director-done.png') })

  await page.getByRole('button', { name: 'Undo draft' }).click()
  await expect(page.getByRole('button', { name: 'Draft video' })).toBeVisible()
  expect(await draftState(page)).toMatchObject({
    clips: before.clips,
    director: 0,
    hiddenTracks: before.hiddenTracks,
  })
})

test('a project reopened without its kind in the link drafts as the kind it was made as', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /AI music video/ }).click()
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByRole('button', { name: 'Draft my video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  // An AI video without fal.ai says so; a lyric video without lyrics would ask for them instead.
  const noAi = page.getByText('This draft uses your media or visuals.', { exact: false })
  const addLyrics = page.getByText('Add lyrics in Assist › Lyrics', { exact: false })
  await expect(noAi).toBeVisible()
  const id = await page.evaluate(() => window.mvStudio.app.project.editor.getProject().id as string)
  // A bookmark or the typed address opens the kept project without the kind.
  await page.evaluate((project) => {
    window.location.hash = `#/editor?project=${project}&tab=assist&assist=director`
  }, id)
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await expect.poll(() => page.evaluate(() => window.mvStudio.app.ui.get().kind)).toBe('lyric')
  await page.getByRole('button', { name: 'Draft video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  await expect(noAi).toBeVisible()
  await expect(addLyrics).toHaveCount(0)
})

test('drafts from the setup screen with the idea typed there', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /^AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('a rainy city at dawn')
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByRole('button', { name: 'Draft my video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  const first = await draftState(page)
  expect(first.undo).toBe('Director: a rainy city at dawn')

  // The setup screen drafts into a new project, so there are no tracks of the user's to hide.
  await expect(page.getByText('Your own tracks are kept below the draft, hidden.')).toBeHidden()
  expect(first.hiddenTracks).toBe(0)

  // The built-in planner only takes the look, mood and pace from Refine, so it offers another version instead.
  await expect(
    page.getByText('The built-in planner takes the look, mood and pace from your words', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Try another version' }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await draftState(page)).ids.join()).not.toBe(first.ids.join())
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  // The new version goes on the timeline right away, and focus goes to its main action instead of the page.
  await expect(page.getByRole('button', { name: 'Play the draft' })).toBeFocused()
})

test('an AI video drafts with the clips given on the setup screen, and offers to draft again with clips imported later', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('neon night drive')
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByLabel('Clip files').setInputFiles([path.join(FIXTURE_DIR, 'clip.mp4')])
  await expect(page.getByRole('list', { name: 'Your clips' }).getByRole('listitem')).toHaveCount(1, {
    timeout: 30_000,
  })
  // The note on what a draft uses sits under the clips step, above the button that starts the draft.
  const clipList = (await page.getByRole('list', { name: 'Your clips' }).boundingBox())!
  const note = (await page.getByText(/^Drafts work on this device with your clips\./).boundingBox())!
  const draftButton = (await page.getByRole('button', { name: 'Draft my video' }).boundingBox())!
  expect(note.y).toBeGreaterThanOrEqual(clipList.y + clipList.height)
  expect(note.y + note.height).toBeLessThanOrEqual(draftButton.y)
  await page.screenshot({ path: testInfo.outputPath('setup-ai-clips.png'), fullPage: true })
  await page.getByRole('button', { name: 'Draft my video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  /** The media the draft's shots show. */
  const used = () =>
    page.evaluate(() => {
      const project = window.mvStudio.app.project.editor.getProject()
      const clips = Object.values(project.clips) as { assetId?: string; meta?: { director?: unknown } }[]
      const names = clips.flatMap((c) =>
        c.meta?.director && c.assetId ? [project.assets[c.assetId]?.name] : [],
      )
      return [...new Set(names)].sort()
    })
  expect(await used()).toEqual(['clip.mp4'])

  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const offer = assist.getByText('1 image added after this draft. Draft again to use it.')
  await expect(offer).toBeHidden()
  await page.getByLabel('Import media files').setInputFiles(path.join(FIXTURE_DIR, 'image.png'))
  await expect(offer).toBeVisible({ timeout: 30_000 })
  // The open panel makes the offer, so no notice repeats it.
  await expect(page.getByText('1 image added after the draft. Draft again to use it?')).toBeHidden()
  await page.screenshot({ path: testInfo.outputPath('director-new-clips.png') })
  await assist.getByRole('button', { name: 'Draft again', exact: true }).click()
  await expect.poll(used, { timeout: 30_000 }).toEqual(['clip.mp4', 'image.png'])
  await expect(placed(page)).toBeVisible()
  await expect(offer).toBeHidden()
})

test('a draft from the setup screen goes on the template’s tracks, with one look and no empty tracks', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /^AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('neon night drive')
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByRole('button', { name: 'Draft my video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })

  const layout = () =>
    page.evaluate(() => {
      const project = window.mvStudio.app.project.editor.getProject()
      const clips = Object.values(project.clips) as { trackId: string; type: string }[]
      return (project.tracks as { id: string; name: string }[]).map((t) => {
        const on = clips.filter((c) => c.trackId === t.id)
        return { name: t.name, clips: on.length, looks: on.filter((c) => c.type === 'adjustment').length }
      })
    })
  const first = await layout()
  // The song has no lyrics yet: the template's Lyrics track waits for them, and the title card is not on it.
  const empty = (tracks: { name: string; clips: number }[]) =>
    tracks.filter((t) => t.clips === 0).map((t) => t.name)
  expect(empty(first)).toEqual(['Lyrics'])
  expect(first.filter((t) => t.looks > 0)).toHaveLength(1)
  // The timeline shows the template's Lyrics, Look and Video tracks holding the draft, and no stand-ins for them.
  const headers = page.locator('span[class*="trackName"]')
  for (const name of ['Lyrics', 'Look', 'Video'])
    await expect(headers.filter({ hasText: name })).toHaveCount(1)
  await expect(headers.filter({ hasText: /^(Text|Shots)$/ })).toHaveCount(0)
  // The title card has a Titles track of its own above the lyrics, says the song's title rather than its file name,
  // and the editor opens where it is faded in, not on the black first frame.
  const titles = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const track = (project.tracks as { id: string; name: string }[]).find((t) => t.name === 'Titles')
    return (Object.values(project.clips) as { trackId: string; text?: string }[])
      .filter((c) => c.trackId === track?.id)
      .map((c) => c.text)
  })
  expect(titles).toEqual(['Neon Skyline'])
  expect(first.map((t) => t.name).indexOf('Titles')).toBeLessThan(first.map((t) => t.name).indexOf('Lyrics'))
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().playhead)).toBeGreaterThanOrEqual(1)

  await page.getByRole('button', { name: 'Try another version' }).click()
  await expect
    .poll(async () => (await layout()).map((t) => t.name).join())
    .toBe(first.map((t) => t.name).join())
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  expect(empty(await layout())).toEqual(['Lyrics'])
})
test('uses the language model’s creative plan when it answers', async ({ page }) => {
  const sections = 9
  const brief = {
    title: 'Rain Run',
    concept: 'A runner crosses the city in the rain.',
    lookId: 'neon',
    visual: 'footage',
    sections: Array.from({ length: sections }, (_, i) => ({
      sectionId: `s${i + 1}`,
      mood: `test mood ${i + 1}`,
      intensity: 0.5,
      pace: 'medium',
    })),
  }
  const bodies: string[] = []
  const seen = await recordRequests(page, 'http://localhost:11434/v1/chat/completions', (route) => {
    bodies.push(route.request().postData() ?? '')
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: 'qwen2.5:7b',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'make_brief', arguments: JSON.stringify(brief) },
                },
              ],
            },
          },
        ],
      }),
    })
  })
  await openDirector(page, { llm: OLLAMA })
  await expect(page.getByText('Ollama · qwen2.5:7b writes the creative plan')).toBeVisible()
  await page.getByRole('button', { name: 'Draft video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/^Test mood 1 · /)).toBeVisible()
  expect(seen).toEqual(['POST /v1/chat/completions'])
  expect(bodies[0]).toContain('make_brief')
})

test('offers the local draft while a slow model is still planning', async ({ page }, testInfo) => {
  const seen = await recordRequests(
    page,
    'http://localhost:11434/v1/chat/completions',
    () => new Promise(() => {}),
  )
  await openDirector(page, { llm: OLLAMA })
  await page.getByRole('button', { name: 'Draft video' }).click()
  // The model is flagged slow after 8 s; the elapsed time counts from the start of the draft.
  await expect(page.getByText(/^Still working… 0:(0[89]|[1-5]\d)$/)).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: testInfo.outputPath('director-still-working.png') })
  expect(seen).toEqual(['POST /v1/chat/completions'])
  await page.getByRole('button', { name: 'Use the local draft instead' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  expect((await draftState(page)).director).toBeGreaterThan(10)
})

test('shows the price of AI shots and asks before spending anything', async ({ page }, testInfo) => {
  const fal = await recordRequests(page, /https:\/\/(queue\.)?fal\.run\/.*/, (route) =>
    route.fulfill({ status: 500, headers: CORS, body: '{}' }),
  )
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  await page.getByRole('radio', { name: 'Mix' }).click()
  await expect(
    page.getByText('Free to plan. AI shots show their price before anything is generated'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Draft video' }).click()
  const generate = page.getByRole('button', { name: /^Generate \d+ shots? · about \$\d+\.\d\d$/ })
  await expect(generate).toBeVisible({ timeout: 30_000 })
  expect((await draftState(page)).director).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('director-cost.png') })

  await generate.click()
  const dialog = page.getByRole('dialog', { name: /^Generate \d+ shots?\?$/ })
  await expect(dialog).toBeVisible()
  // Its buttons are the dialog's own footer, laid out as in the other dialogs.
  await expect(dialog.locator('footer > button')).toHaveText(['Cancel', /^Generate \d+ shots? · about/])
  await expect(dialog.getByText(/^Costs about \$\d+\.\d\d, charged by fal\.ai to your key\.$/)).toBeVisible()
  // One line per model, by its name, not one per shot. A single model's line has no price: it would repeat the total.
  const shots = Number(/\d+/.exec((await generate.textContent()) ?? '')?.[0])
  const lines = await dialog.getByRole('listitem').allTextContents()
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.length).toBeLessThan(shots)
  for (const line of lines)
    expect(line).toMatch(
      lines.length === 1
        ? /^\d+ (images?|clips?) with [A-Z][^·]*$/
        : /^\d+ (images?|clips?) with [A-Z][^·]* · (about \$\d+\.\d\d|under \$0\.01)$/,
    )
  expect(lines.reduce((n, line) => n + Number(/^\d+/.exec(line)?.[0]), 0)).toBe(shots)
  await page.screenshot({ path: testInfo.outputPath('director-confirm.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Apply without AI shots' }).click()
  await expect(placed(page)).toBeVisible()
  expect((await draftState(page)).director).toBeGreaterThan(10)
  expect(fal).toEqual([])
})

test('Generate shows its whole price in the narrowest inspector, on a line of its own', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page
    .context()
    .route(/https:\/\/(queue\.)?fal\.run\/.*/, (route) =>
      route.fulfill({ status: 500, headers: CORS, body: '{}' }),
    )
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  // Drag the inspector to its narrowest.
  const splitter = (await page.getByRole('separator', { name: 'Resize inspector' }).boundingBox())!
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2)
  await page.mouse.down()
  await page.mouse.move(splitter.x + 200, splitter.y + splitter.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await page.locator('[data-guide="right"]').boundingBox())?.width).toBe(272)

  await page.getByRole('radio', { name: 'Mix' }).click()
  await page.getByRole('button', { name: 'Draft video' }).click()
  const generate = page.getByRole('button', { name: /^Generate \d+ shots · about \$\d+\.\d\d$/ })
  await expect(generate).toBeVisible({ timeout: 30_000 })
  const fit = await generate.evaluate((button) => {
    const label = button.lastElementChild as HTMLElement
    const separator = [...label.querySelectorAll('span')].find((s) => s.textContent?.trim() === '·')
    // Where the label's text is laid out, the price at its end included, whether or not it is clipped.
    const text = document.createRange()
    text.selectNodeContents(label)
    const last = [...text.getClientRects()].at(-1)!
    const b = button.getBoundingClientRect()
    return {
      clipped: label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight,
      inside: last.left >= b.left && last.right <= b.right && last.top >= b.top && last.bottom <= b.bottom,
      lines: Math.round(
        label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight),
      ),
      separatorShown: !separator || separator.getBoundingClientRect().width > 1,
    }
  })
  expect(fit).toMatchObject({ clipped: false, inside: true })
  // Too long for one line here, so the price goes onto its own, and the first line doesn't end in a lone "·".
  expect(fit).toMatchObject({ lines: 2, separatorShown: false })
  await generate.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('director-cost-narrow.png') })
})

test('a retry after failed AI shots shows its price and asks again; Back returns to the plan', async ({
  page,
}, testInfo) => {
  const fal = await recordRequests(page, /https:\/\/(queue\.)?fal\.run\/.*/, (route) =>
    route.fulfill({ status: 500, headers: CORS, body: '{}' }),
  )
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  await page.getByRole('radio', { name: 'Mix' }).click()
  await page.getByRole('button', { name: 'Draft video' }).click()
  const generate = page.getByRole('button', { name: /^Generate \d+ shots? · about \$\d+\.\d\d$/ })
  await generate.click()
  const dialog = page.getByRole('dialog', { name: /^Generate \d+ shots?\?$/ })
  await dialog.getByRole('button', { name: /^Generate \d+ shots? · about/ }).click()

  const retry = page.getByRole('button', { name: /^Retry · about \$\d+\.\d\d$/ })
  await expect(retry).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Your project is unchanged\.$/)).toBeVisible()
  const sent = fal.length
  expect(sent).toBeGreaterThan(0)
  expect((await draftState(page)).director).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('director-failed.png') })

  await retry.click()
  await expect(dialog).toBeVisible()
  expect(fal).toHaveLength(sent)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Back to the plan' }).click()
  await expect(generate).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply without AI shots' })).toBeVisible()
  expect(fal).toHaveLength(sent)
})

test('AI shot prompts carry the picture the idea describes, not what it asks of the edit', async ({
  page,
}) => {
  const prompts: string[] = []
  await page.context().route(/https:\/\/(queue\.)?fal\.run\/.*/, (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (request.method() === 'POST') prompts.push((request.postDataJSON() as { prompt: string }).prompt)
    return route.fulfill({ status: 500, headers: CORS, body: '{}' })
  })
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  await page.getByRole('radio', { name: 'Generate' }).click()
  await page
    .getByRole('textbox', { name: 'Idea for the video' })
    .fill(
      'Summer day outdoors: ocean waves, skaters at night, bees in lavender, a city at night. Use my own clips.',
    )
  await page.getByRole('button', { name: 'Draft video' }).click()
  await page.getByRole('button', { name: /^Generate \d+ shots? · about/ }).click()
  await page
    .getByRole('dialog', { name: /^Generate \d+ shots?\?$/ })
    .getByRole('button', { name: /^Generate \d+ shots? · about/ })
    .click()
  await expect(page.getByRole('button', { name: /^Retry · about/ })).toBeVisible({ timeout: 30_000 })
  expect(prompts.length).toBeGreaterThan(0)
  for (const prompt of prompts) {
    expect(prompt).toMatch(
      /^Summer day outdoors: ocean waves, skaters at night, bees in lavender, a city at night\. \w/,
    )
    expect(prompt).not.toContain('clips')
  }
})
/**
 * fal.ai's queue for video clips (or images, with `images`), in the shapes fal.ai documents: each request is in
 * progress for one poll, then done with a video. Submits numbered in `failing` (from 1) answer HTTP 500; the `held`
 * ones stay in progress and the `queued` one waits in line with 2 ahead until `release()`.
 */
async function mockFalVideo(
  page: Page,
  o: {
    failing?: number[]
    held?: number | number[]
    queued?: number
    heldDownload?: number
    images?: boolean
  } = {},
) {
  const clip = readFileSync(path.join(FIXTURE_DIR, 'clip.mp4'))
  const still = readFileSync(path.join(FIXTURE_DIR, 'image.png'))
  const heldIds = [o.held ?? []].flat().map((n) => `req-${n}`)
  let released = false
  const waiting: (() => void)[] = []
  const fal = {
    submits: [] as string[],
    cancels: [] as string[],
    downloads: [] as string[],
    release: () => {
      released = true
      for (const go of waiting.splice(0)) go()
    },
  }
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) })
  const polls = new Map<string, number>()
  await page.context().route('https://queue.fal.run/**', (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const parts = new URL(request.url()).pathname.split('/').filter(Boolean)
    const at = parts.indexOf('requests')
    if (request.method() === 'POST' && at < 0) {
      fal.submits.push(parts.join('/'))
      const n = fal.submits.length
      if (o.failing?.includes(n)) return json(route, 500, { detail: 'Internal server error' })
      const id = `req-${n}`
      const base = `https://queue.fal.run/${parts.slice(0, 2).join('/')}/requests/${id}`
      return json(route, 200, {
        request_id: id,
        status: 'IN_QUEUE',
        response_url: base,
        status_url: `${base}/status`,
        cancel_url: `${base}/cancel`,
      })
    }
    const id = parts[at + 1] ?? ''
    if (parts[at + 2] === 'cancel') {
      fal.cancels.push(id)
      return json(route, 202, { status: 'CANCELLATION_REQUESTED' })
    }
    if (parts[at + 2] === 'status') {
      if (id === `req-${o.queued}` && !released)
        return json(route, 200, { status: 'IN_QUEUE', queue_position: 2 })
      const n = polls.get(id) ?? 0
      polls.set(id, n + 1)
      const held = heldIds.includes(id) && !released
      return json(route, 200, { status: n === 0 || held ? 'IN_PROGRESS' : 'COMPLETED', logs: [] })
    }
    if (o.images) {
      const url = `https://v3.fal.media/files/mock/${id}.png`
      return json(route, 200, { images: [{ url, width: 1280, height: 720, content_type: 'image/png' }] })
    }
    return json(route, 200, {
      video: { url: `https://v3.fal.media/files/mock/${id}.mp4`, content_type: 'video/mp4' },
    })
  })
  await page.context().route('https://v3.fal.media/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const id = /\/(req-\d+)\.(mp4|png)$/.exec(route.request().url())?.[1] ?? ''
    fal.downloads.push(id)
    if (id === `req-${o.heldDownload}` && !released) await new Promise<void>((go) => waiting.push(go))
    return o.images
      ? route.fulfill({ status: 200, headers: CORS, contentType: 'image/png', body: still })
      : route.fulfill({ status: 200, headers: CORS, contentType: 'video/mp4', body: clip })
  })
  return fal
}

/** The director's video clips from generated media, and its placeholders for clips not made yet. */
const directorClips = (page: Page) =>
  page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    type C = { type: string; assetId?: string; meta?: { director?: { pending?: { task: string } } } }
    const ours = (Object.values(project.clips) as C[]).filter((c) => c.meta?.director)
    const assets = project.assets as Record<string, { origin: { type: string } }>
    return {
      videos: ours.filter((c) => c.type === 'video' && assets[c.assetId ?? '']?.origin.type === 'generated')
        .length,
      pending: ours.filter((c) => c.meta?.director?.pending?.task === 'text-to-video').length,
    }
  })

/** Drafts with AI video clips and confirms their price; returns how many clips the plan makes. */
async function draftVideoClips(page: Page, testInfo?: TestInfo) {
  await page.getByRole('radio', { name: 'Generate' }).click()
  await page.getByRole('radio', { name: 'Video clips' }).click()
  await expect(
    page.getByText('Free to plan. Video clips cost more and show their price before anything is generated'),
  ).toBeVisible()
  await expect(page.getByText('Clips with real motion. Each takes a few minutes to make.')).toBeVisible()
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('director-video-idle.png') })
  await page.getByRole('button', { name: 'Draft video' }).click()
  const generate = page.getByRole('button', { name: /^Generate \d+ clips · about \$\d+\.\d\d$/ })
  await expect(generate).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Apply without AI clips' })).toBeVisible()
  const count = Number(/\d+/.exec((await generate.textContent()) ?? '')?.[0])
  await expect(
    page.getByText(`If you apply without AI clips, dark placeholders mark where the ${count} AI clips go.`),
  ).toBeVisible()
  await generate.click()
  const dialog = page.getByRole('dialog', { name: `Generate ${count} clips?` })
  // One line for the model, with the clips' seconds: video is priced by the second.
  await expect(dialog.getByRole('listitem')).toHaveText([
    new RegExp(`^${count} clips, \\d+ s in all, with MiniMax H3 Max Turbo$`),
  ])
  await expect(dialog.getByText('Clips already made are kept if you cancel.', { exact: false })).toBeVisible()
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('director-video-confirm.png') })
  await dialog.getByRole('button', { name: /^Generate \d+ clips · about/ }).click()
  await expect(dialog).toBeHidden()
  return count
}

test('drafts with AI video clips: priced per clip, each clip’s progress shows, a failed clip is retried, and they land as video clips', async ({
  page,
}, testInfo) => {
  // The second request fails; the third stays in progress until released.
  const fal = await mockFalVideo(page, { failing: [2], held: 3 })
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  // The switch shows only when the draft uses AI shots.
  await expect(page.getByRole('radio', { name: 'Video clips' })).toHaveCount(0)
  const count = await draftVideoClips(page, testInfo)

  // Every clip but the held one is done or failed: the held clip's own progress moves the bar past that count.
  await expect(page.getByText(new RegExp(`^${count} clips\\s· ${count - 2} done\\s· 1 failed$`))).toBeVisible(
    {
      timeout: 60_000,
    },
  )
  // The failed clip gets a row while the others go on; it opens to show fal.ai's reason and the clip it stopped.
  const failedRow = page.getByRole('button', { name: /^1 failed\s· retry when the run ends$/ })
  await expect(failedRow).toHaveAttribute('aria-expanded', 'false')
  await failedRow.click()
  await expect(failedRow).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('listitem').filter({ hasText: 'fal.ai said' })).toHaveText(
    /^fal\.ai said: Internal server error\S.* · clip \d+$/,
  )
  await expect(page.getByText(/^(About \d+ min|Less than a minute) left$/)).toBeVisible()
  const pct = Number(
    (
      await page
        .getByText(/^\d+%$/)
        .first()
        .textContent()
    )?.replace('%', ''),
  )
  expect(pct).toBeGreaterThan(Math.floor(((count - 1) / count) * 100))
  await page.screenshot({ path: testInfo.outputPath('director-video-generating.png') })
  fal.release()

  const retry = page.getByRole('button', { name: /^Retry 1 failed clip · about \$\d+\.\d\d$/ })
  await expect(retry).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText('1 clip couldn’t be generated. Retry it below; a dark placeholder marks its place.'),
  ).toBeVisible()
  await expect(page.getByText(/not generated yet/)).toHaveCount(0)
  // The reason shows under Retry, and screen readers hear it with the button.
  await expect(page.getByRole('listitem').filter({ hasText: 'fal.ai said' })).toHaveText(
    'fal.ai said: Internal server error',
  )
  await expect(retry).toHaveAccessibleDescription('fal.ai said: Internal server error')
  const first = await directorClips(page)
  expect(first.videos).toBeGreaterThanOrEqual(count - 1)
  expect(first.pending).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('director-video-done.png') })

  await retry.click()
  const dialog = page.getByRole('dialog', { name: 'Generate 1 clip?' })
  await dialog.getByRole('button', { name: /^Retry 1 failed clip · about/ }).click()
  await expect(retry).toBeHidden({ timeout: 30_000 })
  await expect(placed(page)).toBeVisible()
  const after = await directorClips(page)
  expect(after.pending).toBe(0)
  expect(after.videos).toBeGreaterThan(first.videos)
  expect(fal.submits).toHaveLength(count + 1)
})

test('AI images say how long is left once the first ones are made', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  // The third and fourth images stay in progress until released, so the run can be read mid-way.
  const fal = await mockFalVideo(page, { images: true, held: [3, 4] })
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  await page.getByRole('radio', { name: 'Generate' }).click()
  await page.getByRole('button', { name: 'Draft video' }).click()
  const generate = page.getByRole('button', {
    name: /^Generate \d+ shots · (about \$\d+\.\d\d|under \$0\.01)$/,
  })
  await expect(generate).toBeVisible({ timeout: 30_000 })
  await generate.click()
  await page
    .getByRole('dialog', { name: /^Generate \d+ shots\?$/ })
    .getByRole('button', { name: /^Generate \d+ shots · / })
    .click()
  await expect.poll(() => fal.downloads, { timeout: 30_000 }).toEqual(['req-1', 'req-2'])
  await expect(page.getByText(/^\d+ shots\s· 2 done$/).first()).toBeVisible()
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(assist.getByText(/^(About \d+ min|Less than a minute) left$/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('director-images-eta.png') })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Generation stopped. 2 shots made so far are kept.')).toBeVisible()
  expect(fal.cancels.sort()).toEqual(['req-3', 'req-4'])
})

test('while AI clips generate, each one underway shows its place in fal.ai’s line or its progress, with the spend so far', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  // The first request stays in progress and the second waits in fal.ai's line until released.
  const fal = await mockFalVideo(page, { held: 1, queued: 2 })
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  const count = await draftVideoClips(page)
  const underway = page.getByRole('list', { name: 'Clips underway' }).getByRole('listitem')
  await expect(underway).toHaveText(
    [/^\S.* · clip \d+ Generating · \d+%$/, /^\S.* · clip \d+ In line · 2 ahead$/],
    {
      timeout: 30_000,
    },
  )
  await expect(page.getByText(/^Spent \$0\.00 of an estimated \$\d+\.\d\d$/)).toBeVisible()
  // The rows leave all of Cancel in view in a 720 px window, without scrolling the panel.
  const cancel = (await page.getByRole('button', { name: 'Cancel' }).boundingBox())!
  const panel = (await page.locator('[data-guide="right"]').boundingBox())!
  expect(cancel.y + cancel.height).toBeLessThanOrEqual(panel.y + panel.height)
  await page.screenshot({ path: testInfo.outputPath('director-video-shots.png') })

  fal.release()
  // As clips are made, finished rows leave the list and the spend grows.
  await expect(page.getByText(/^Spent about \$\d+\.\d\d of an estimated \$\d+\.\d\d$/)).toBeVisible({
    timeout: 30_000,
  })
  await expect(underway.filter({ hasText: 'In line' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('director-video-spent.png') })
  await expect(placed(page)).toBeVisible({ timeout: 60_000 })
  expect(fal.submits).toHaveLength(count)
})

test('failed clips share one row that opens to show why, and Cancel stays in view', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  // The first five requests fail and the sixth is made (and billed); the seventh stays in progress and the eighth
  // waits in line until released.
  const fal = await mockFalVideo(page, { failing: [1, 2, 3, 4, 5], held: 7, queued: 8 })
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  const count = await draftVideoClips(page)
  const underway = page.getByRole('list', { name: 'Clips underway' }).getByRole('listitem')
  await expect(underway).toHaveText([/ Generating · \d+%$/, / In line · 2 ahead$/], { timeout: 30_000 })
  // The card counts what is finished, as the top bar counts the run, with the spend so far under it.
  await expect(page.getByText(new RegExp(`^${count} clips\\s· 1 done\\s· 5 failed$`))).toBeVisible()
  await expect(page.getByText(/^Spent about \$\d+\.\d\d of an estimated \$\d+\.\d\d$/)).toBeVisible()
  const failed = page.getByRole('button', { name: /^5 failed\s· retry when the run ends$/ })
  const cancel = page.getByRole('button', { name: 'Cancel' })
  const cancelInView = async () => {
    const button = (await cancel.boundingBox())!
    const panel = (await page.locator('[data-guide="right"]').boundingBox())!
    expect(button.y + button.height).toBeLessThanOrEqual(panel.y + panel.height)
  }
  await cancelInView()
  await page.screenshot({ path: testInfo.outputPath('director-video-failed-rows.png') })
  // The five share one reason: it shows once, with the clips it stopped.
  await failed.click()
  const reasons = page.getByRole('listitem').filter({ hasText: 'fal.ai said' })
  await expect(reasons).toHaveText(
    /^fal\.ai said: Internal server error(\S.* · clip \d+, ){4}\S.* · clip \d+$/,
  )
  // The reasons start where the row's words do, after its icon, as they do under Retry.
  const words = (await failed.locator('[class*="failText"]').boundingBox())!
  expect(Math.abs((await reasons.boundingBox())!.x - words.x)).toBeLessThan(1)
  await cancelInView()
  await page.screenshot({ path: testInfo.outputPath('director-video-failed-reasons.png') })
  // In the narrowest inspector the lines wrap more, and Cancel stays pinned in view.
  const splitter = (await page.getByRole('separator', { name: 'Resize inspector' }).boundingBox())!
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2)
  await page.mouse.down()
  await page.mouse.move(splitter.x + 200, splitter.y + splitter.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await page.locator('[data-guide="right"]').boundingBox())?.width).toBe(272)
  await cancelInView()
  await page.screenshot({ path: testInfo.outputPath('director-video-failed-rows-narrow.png') })
  await cancel.click()
  await expect(page.getByText(/^Generation stopped\./)).toBeVisible()
  fal.release()
})

test('cancelling AI video clips stops the one underway at fal.ai, keeps the clips already made, and leaves focus on Generate', async ({
  page,
}) => {
  const fal = await mockFalVideo(page, { held: 3 })
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  const count = await draftVideoClips(page)
  await expect(page.getByText(new RegExp(`^${count} clips\\s· ${count - 1} done$`))).toBeVisible({
    timeout: 60_000,
  })
  await page.getByRole('button', { name: 'Cancel' }).focus()
  await page.keyboard.press('Enter')

  await expect(page.getByText(`Generation stopped. ${count - 1} clips made so far are kept.`)).toBeVisible()
  const again = page.getByRole('button', { name: /^Generate 1 clip · about \$\d+\.\d\d$/ })
  await expect(again).toBeFocused()
  await expect(again).toBeInViewport()
  // The plan's summary counts what is left to generate, as the button does.
  await expect(page.getByText(/, 1 to generate[,.]/)).toBeVisible()
  await expect(page.getByText(new RegExp(`, ${count} to generate[,.]`))).toHaveCount(0)
  // A screen reader hears what the Cancel kept as focus lands on Generate.
  await expect(again).toHaveAccessibleDescription(
    `Generation stopped. ${count - 1} clips made so far are kept.`,
  )
  expect(fal.cancels).toEqual(['req-3'])
  expect(fal.submits).toHaveLength(count)
  expect((await draftState(page)).director).toBe(0)
})

test('a draft made without fal.ai offers to draft again with AI shots once fal.ai is connected', async ({
  page,
}, testInfo) => {
  // fal.ai checks a key for free: a good key gets "not found" for a request that doesn't exist.
  await page.context().route('https://queue.fal.run/**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({
          status: 404,
          headers: CORS,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Request not found' }),
        }),
  )
  await openDirector(page, undefined, 'ai')
  await page.getByRole('button', { name: 'Draft video' }).click()
  const connectFirst = page.getByText(
    'This draft uses your media or visuals. To add AI shots, connect fal.ai in Settings.',
  )
  await expect(connectFirst).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Draft again with AI shots' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'AI and cloud' })
    .click()
  await settings.getByLabel('fal.ai key').fill('key-id:key-secret')
  await settings.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(settings.getByText('Connected', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  // The draft stays as it was; its note now gives the step that's left.
  await expect(connectFirst).toHaveCount(0)
  await expect(
    page.getByText(
      'This draft uses your media or visuals. With fal.ai connected, the director can add AI shots.',
    ),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('director-ai-scenes-connected.png') })
  // From the keyboard, focus lands on the new plan's price rather than dropping to the page.
  await page.getByRole('button', { name: 'Draft again with AI shots' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /^Generate \d+ shots · about \$\d+\.\d\d$/ })).toBeFocused({
    timeout: 30_000,
  })
})

test('a Cancel while a clip downloads says it is stopping, and keeps the clip fal.ai already made', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  // The third clip's download stalls until released; the fourth stays in progress at fal.ai.
  const fal = await mockFalVideo(page, { heldDownload: 3, held: 4 })
  await openDirector(page, { falKey: 'key-id:key-secret', alwaysConfirmPaid: true })
  const count = await draftVideoClips(page)
  await expect.poll(() => fal.downloads, { timeout: 60_000 }).toContain('req-3')
  // The fourth clip starts only after the first two are made.
  await expect.poll(() => fal.submits.length, { timeout: 30_000 }).toBe(4)
  const hint = page.getByText(/^Cancelling stops the request/)
  await expect(hint).toBeVisible()
  const cancel = page.getByRole('button', { name: 'Cancel' })
  await cancel.focus()
  await page.keyboard.press('Enter')

  // The whole panel agrees it is stopping: the subtitle, the card's line, and a disabled Cancel that keeps focus.
  await expect(page.getByText('Keeping 1 clip that is downloading')).toBeVisible()
  await expect(
    page.getByRole('tabpanel', { name: 'Assist' }).getByText('Stopping…', { exact: true }),
  ).toHaveCount(2)
  await expect(cancel).toHaveAttribute('aria-disabled', 'true')
  await expect(cancel).toHaveCSS('cursor', 'default')
  await expect(cancel).toBeFocused()
  await expect(hint).toHaveCount(0)
  // At 1280 the card's top line stays on one line, clear of the spinner that took the percent's place.
  const top = page
    .getByRole('progressbar', { name: 'Generating clips' })
    .locator('xpath=preceding-sibling::div[1]')
  const message = top.locator('span').first()
  const spinner = top.locator('span').last()
  await expect(top).toHaveText('Stopping…')
  const m = (await message.boundingBox())!
  const s = (await spinner.boundingBox())!
  expect(m.x + m.width + 4).toBeLessThanOrEqual(s.x)
  const fontSize = await message.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  expect(m.height).toBeLessThan(2 * fontSize)
  await page.screenshot({ path: testInfo.outputPath('director-video-stopping.png') })
  fal.release()
  const note = page.getByText('Generation stopped. 3 clips made so far are kept.')
  const again = page.getByRole('button', {
    name: new RegExp(`^Generate ${count - 3} clips · about \\$\\d+\\.\\d\\d$`),
  })
  await expect(again).toBeFocused()
  await expect(again).toHaveAccessibleDescription('Generation stopped. 3 clips made so far are kept.')
  // The note sits in the footer just above Generate, and the panel is scrolled to its end: both show in full, with the
  // focus ring clear of the fade that says more is below.
  const panel = (await again.evaluate((button) => {
    let s = button.parentElement
    while (s && getComputedStyle(s).overflowY !== 'auto') s = s.parentElement
    if (!s) return null
    const top = s.getBoundingClientRect().top + s.clientTop
    return {
      atEnd: s.scrollTop + s.clientHeight >= s.scrollHeight - 1,
      fade: getComputedStyle(s, '::after').opacity,
      top,
      bottom: top + s.clientHeight,
    }
  }))!
  expect(panel).toMatchObject({ atEnd: true, fade: '0' })
  const n = (await note.boundingBox())!
  const b = (await again.boundingBox())!
  expect(n.y).toBeGreaterThanOrEqual(panel.top)
  expect(n.y + n.height).toBeLessThanOrEqual(b.y)
  expect(b.y + b.height + 4).toBeLessThanOrEqual(panel.bottom)
  expect(fal.cancels).toEqual(['req-4'])
  expect(fal.submits).toHaveLength(4)
})

test('a tagged song names the project, and the title card shows its title and artist', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  // The file's tags say "Neon Skyline" by "The Night Shift"; its name says neither.
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'tagged.mp3'))
  await expect(page.getByRole('button', { name: 'Project: Neon Skyline' })).toBeVisible()
  await expect(page.getByText(/0:08 · 1[12]\d BPM · \d+ sections?/)).toBeVisible({ timeout: 30_000 })

  await page.evaluate(() => {
    window.location.hash = '#/editor?tab=assist&assist=director'
  })
  await page.getByRole('button', { name: 'Draft video' }).click()
  await expect(page.getByRole('button', { name: 'Undo draft' })).toBeVisible({ timeout: 30_000 })
  const titles = await page.evaluate(() => {
    const clips = Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
      type: string
      text?: string
      meta?: { director?: { role?: string } }
    }[]
    return clips.filter((c) => c.type === 'text' && c.meta?.director?.role === 'title').map((c) => c.text)
  })
  expect(titles).toEqual(['Neon Skyline', 'The Night Shift'])
})

/** A mono 16-bit WAV of `seconds` of kicks every 0.5 s (120 BPM) over a low chord, long enough for several Beat This! windows. */
function kickWav(seconds: number): Buffer {
  const rate = 22_050
  const n = Math.round(seconds * rate)
  const wav = Buffer.alloc(44 + n * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + n * 2, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const k = t % 0.5
    const kick = 0.6 * Math.sin(2 * Math.PI * (45 + 120 * Math.exp(-25 * k)) * t) * Math.exp(-7 * k)
    const pad = 0.1 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t))
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, kick + pad)) * 32_000), 44 + i * 2)
  }
  return wav
}

test('a draft says how long is left while it finds the song’s bars', async ({ page }, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /^AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('a rainy city at dawn')
  // 95 s: Beat This! runs it in four windows, and the first one done says how long the rest take.
  await page
    .getByLabel('Song file')
    .setInputFiles({ name: 'long-song.wav', mimeType: 'audio/wav', buffer: kickWav(95) })
  await page.getByRole('button', { name: 'Draft my video' }).click()
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(assist.getByText('Less than a minute left')).toBeVisible({ timeout: 60_000 })
  await expect(assist.getByText('Drafting your video')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('director-draft-eta.png') })
  await expect(page.getByRole('button', { name: 'Undo draft' })).toBeVisible({ timeout: 60_000 })
  await expect(assist.getByText('Less than a minute left')).toHaveCount(0)
})
test('a draft from the setup screen waits for the song analysis still running', async ({ page }) => {
  // Holds the analysis worker's script back, so the song is still being analyzed when Draft my video is pressed.
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.context().route(/analysis\.worker-[^/]*\.js$/, async (route) => {
    await held
    await route.continue()
  })
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /^AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('a rainy city at dawn')
  await page.getByLabel('Song file').setInputFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await page.getByRole('button', { name: 'Draft my video' }).click()
  await expect(
    page.getByRole('tabpanel', { name: 'Assist' }).getByText('Finding beats and sections…'),
  ).toBeVisible({
    timeout: 15_000,
  })
  release()
  await expect(page.getByRole('button', { name: 'Undo draft' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Song analysis isn’t finished', { exact: false })).toHaveCount(0)
})

test('a lyric chip takes clicks where the director’s emphasized word sits over it, and Delete takes the line out with the word', async ({
  page,
}, testInfo) => {
  await openDirector(page, undefined, 'lyric')
  await page.getByRole('button', { name: 'Draft video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  // The first emphasized word, on the draft's text track over its line's chip.
  const word = await page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    const clips = Object.values(p.clips) as {
      id: string
      type: string
      start: number
      trackId: string
      lyricLineId?: string
      meta?: { director?: { textRole?: string; lyricLineId?: string } }
    }[]
    const words = clips
      .filter((c) => c.meta?.director?.textRole === 'emphasis')
      .sort((a, b) => a.start - b.start)
    const w = words.find((w) =>
      clips.some((c) => c.trackId === w.trackId && c.lyricLineId === w.meta?.director?.lyricLineId),
    )
    return w ? { id: w.id, lineId: w.meta!.director!.lyricLineId!, start: w.start } : null
  })
  if (!word) throw new Error('The lyric draft has an emphasized word over its line')
  await page.evaluate((t) => window.mvStudio.app.ui.set({ playhead: t }), word.start)
  const clip = page.locator(`[data-clip-id="${word.id}"]`)
  const chip = page
    .getByRole('button', { name: /^Lyric: / })
    .and(page.locator(`[data-lyric-line="${word.lineId}"]`))
    .and(page.locator(':not([class*="rowHidden"] *)'))
  await expect(clip).toBeVisible()
  const c = (await clip.boundingBox())!
  const l = (await chip.boundingBox())!
  // The word keeps the lower half of the row, over the chip; the chip's upper half above it takes the click.
  expect(c.y).toBeGreaterThan(l.y + l.height / 3)
  await page.screenshot({ path: testInfo.outputPath('chip-under-word.png') })
  await page.mouse.click(c.x + c.width / 2, l.y + 4)
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  // The selected chip stays under the word: the word still takes clicks.
  await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2)
  await expect(clip).toHaveAttribute('aria-pressed', 'true')

  await page.mouse.click(c.x + c.width / 2, l.y + 4)
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Delete')
  await expect(chip).toHaveCount(0)
  await expect(clip).toHaveCount(0)
  expect((await draftState(page)).undo).toBe('Delete lyric line')
  const lines = () =>
    page.evaluate(() =>
      (window.mvStudio.app.project.editor.getProject().lyrics?.lines ?? []).map((l: { id: string }) => l.id),
    )
  expect(await lines()).not.toContain(word.lineId)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(clip).toBeVisible()
  expect(await lines()).toContain(word.lineId)
})
