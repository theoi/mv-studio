import type { Page, Route } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

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
  await expect(page.getByText('The built-in planner writes the plan.', { exact: false })).toBeVisible()
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

test('drafts from the setup screen with the idea typed there', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /AI music video/ }).click()
  await page.getByRole('textbox', { name: 'Describe your video' }).fill('a rainy city at dawn')
  await page.getByRole('button', { name: 'Use a sample song' }).click()
  await page.getByRole('button', { name: 'Draft my video' }).click()
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
  const first = await draftState(page)
  expect(first.undo).toBe('Director: a rainy city at dawn')

  await page.getByRole('button', { name: 'Show them' }).click()
  await expect(page.getByText('Your own tracks are kept below the draft, hidden.')).toBeHidden()
  expect((await draftState(page)).hiddenTracks).toBe(0)

  // The built-in planner only takes the mood from Refine, so it offers another version instead.
  await expect(
    page.getByText('The built-in planner takes the look and mood from your words.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Try another version' }).click()
  await expect.poll(async () => (await draftState(page)).ids.join()).not.toBe(first.ids.join())
  await expect(placed(page)).toBeVisible({ timeout: 30_000 })
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
  await expect(dialog.getByText(/^Costs about \$\d+\.\d\d, charged by fal\.ai to your key\.$/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('director-confirm.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'Apply without AI shots' }).click()
  await expect(placed(page)).toBeVisible()
  expect((await draftState(page)).director).toBeGreaterThan(10)
  expect(fal).toEqual([])
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
