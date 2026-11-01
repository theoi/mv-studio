import type { Page, Route } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

/*
 * The Ask box in Assist with the real AskSession on the sample project. The language model is answered at the
 * network level, as Ollama answers; no model server is needed.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

const OLLAMA = { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' }
const CHAT = 'http://localhost:11434/v1/chat/completions'

/** `promptTokens` is the usage Ollama reports: the tokens it read, fewer than sent when it cut the prompt. */
type Answer = { tool: string; args: Record<string, unknown>; promptTokens?: number } | 'hang'

/** Answers each chat request with the next tool call in `answers`; returns the request bodies seen. */
async function model(page: Page, answers: Answer[]) {
  // Ollama's own API (the context check before a long request) answers as an Ollama without it, so an Ollama running
  // on this computer stays out of the test.
  await page
    .context()
    .route('http://localhost:11434/api/**', (route) => route.fulfill({ status: 404, headers: CORS }))
  const bodies: string[] = []
  await page.context().route(CHAT, (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    bodies.push(route.request().postData() ?? '')
    const answer = answers.shift()
    if (!answer || answer === 'hang') return new Promise<void>(() => {})
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({
        id: `chatcmpl-${bodies.length}`,
        object: 'chat.completion',
        model: OLLAMA.model,
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${bodies.length}`,
                  type: 'function',
                  function: { name: answer.tool, arguments: JSON.stringify(answer.args) },
                },
              ],
            },
          },
        ],
        ...(answer.promptTokens
          ? {
              usage: {
                prompt_tokens: answer.promptTokens,
                completion_tokens: 40,
                total_tokens: answer.promptTokens + 40,
              },
            }
          : {}),
      }),
    })
  })
  return bodies
}

async function openAsk(page: Page, llm: Record<string, unknown> | null = OLLAMA) {
  await openHarness(page)
  await page.evaluate((settings) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    if (settings) localStorage.setItem('mv-studio.cloud.v1', JSON.stringify({ llm: settings }))
  }, llm)
  if (llm) {
    await page.reload()
    await page.waitForFunction(() => window.mvStudio?.ready === true)
  }
  await page.evaluate(() => {
    window.location.hash = '#/editor?kind=ai&tab=assist'
  })
  await expect(page.getByRole('textbox', { name: 'Ask Assist for a change' })).toBeVisible()
  // Screenshots of the panel are reviewed with the preview beside it.
  await expect(page.getByText('Preparing the preview')).toBeHidden()
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: /^(Ask Assist for a change|Answer Assist’s question)$/ })
  await box.fill(text)
  await box.press('Enter')
}

const projectState = (page: Page) =>
  page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const clips = Object.values(project.clips) as {
      type: string
      text?: string
      opacity?: { value: number }
    }[]
    return {
      clips: clips.length,
      titles: clips.filter((c) => c.type === 'text' && c.text === 'Neon Skyline').length,
      markers: (project.markers ?? []).map((m: { label?: string }) => m.label),
      dimmed: clips.filter((c) => c.type === 'video' && c.opacity?.value === 0.5).length,
      undo: editor.undoLabel() as string | undefined,
    }
  })

const addTitle = {
  tool: 'edit_project',
  args: {
    summary: 'Added a title at the start',
    operations: [{ op: 'add_text', text: 'Neon Skyline', start: 0, end: 4 }],
  },
}

test('applies a small edit right away, says what changed, and undoes it', async ({ page }, testInfo) => {
  const bodies = await model(page, [addTitle])
  await openAsk(page)
  await expect(page.getByText('Ollama · qwen2.5:7b')).toBeVisible()
  const before = await projectState(page)

  await send(page, 'add a title at the start')
  const result = page.getByText('Added a title at the start', { exact: true }).first()
  await expect(result).toBeVisible()
  await expect(page.getByText(/^Text “Neon Skyline” at 0:00\.0: added$/)).toBeVisible()
  expect(await projectState(page)).toMatchObject({
    clips: before.clips + 1,
    titles: 1,
    undo: 'Ask: Added a title at the start',
  })
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toContain('Request: add a title at the start')
  await page.screenshot({ path: testInfo.outputPath('ask-applied.png') })

  await page.getByRole('button', { name: 'Show changes' }).click()
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Show changes' })).toBeHidden()
  expect(await projectState(page)).toMatchObject({ clips: before.clips, titles: 0 })
})

test('asks a clarifying question and continues with the answer', async ({ page }, testInfo) => {
  const bodies = await model(page, [
    {
      tool: 'ask_clarification',
      args: { question: 'Where should the marker go?', choices: ['At the playhead', 'At the first chorus'] },
    },
    {
      tool: 'edit_project',
      args: {
        summary: 'Added a marker at the playhead',
        operations: [{ op: 'add_marker', time: 12, label: 'Drop' }],
      },
    },
  ])
  await openAsk(page)
  await send(page, 'add a marker called Drop')
  await expect(page.getByText('Where should the marker go?', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Answer Assist’s question' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('ask-question.png') })

  await page.getByRole('button', { name: 'At the playhead' }).click()
  await expect(page.getByText('Added a marker at the playhead', { exact: true }).first()).toBeVisible()
  expect((await projectState(page)).markers).toContain('Drop')
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toContain('The user answered: At the playhead')
})

test('holds a large edit for review: Discard keeps the project, Apply changes it', async ({
  page,
}, testInfo) => {
  const dim = {
    tool: 'edit_project',
    args: {
      summary: 'Dimmed the footage',
      operations: [{ op: 'set', clips: { type: 'video' }, property: 'opacity', value: 0.5 }],
    },
  }
  await model(page, [dim, dim])
  await openAsk(page)
  await send(page, 'dim all the footage')
  await expect(page.getByText(/Ready to apply · Changes \d+ clips\.$/)).toBeVisible()
  await expect(page.getByText('This changes a lot at once, so it waits for you to apply it.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask Assist for a change' })).toHaveAttribute(
    'placeholder',
    'Apply or discard the change above, or ask for something else',
  )
  expect((await projectState(page)).dimmed).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('ask-review.png') })

  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('button', { name: 'Apply' })).toBeHidden()
  expect((await projectState(page)).dimmed).toBe(0)

  await send(page, 'dim all the footage')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('button', { name: 'Show changes' })).toBeVisible()
  const after = await projectState(page)
  expect(after.dimmed).toBeGreaterThanOrEqual(8)
  expect(after.undo).toBe('Ask: Dimmed the footage')
})

test('edits from a small model on this computer wait for review', async ({ page }) => {
  await model(page, [addTitle])
  await openAsk(page, { ...OLLAMA, model: 'qwen2.5:1.5b' })
  await send(page, 'add a title at the start')
  await expect(
    page.getByText('Small models sometimes misplace edits, so their changes wait for you to check them.'),
  ).toBeVisible()
  expect((await projectState(page)).titles).toBe(0)
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(async () => (await projectState(page)).titles).toBe(1)
})

test('without a model, says so and opens Settings', async ({ page }) => {
  await openAsk(page, null)
  await expect(page.getByText('No AI model yet')).toBeVisible()
  await send(page, 'make the chorus more intense')
  await expect(page.getByText('Ask needs an AI model', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Add one in Settings › AI and cloud\./)).toBeVisible()
  // Screen readers hear what is missing and where to add it, not a failure.
  // The Ask box's own live region: the timeline has another.
  const status = page.getByRole('tabpanel', { name: 'Assist' }).locator('.sr-only[aria-live="polite"]')
  await expect(status).toHaveText(/^Ask needs an AI model\. Add one in Settings › AI and cloud\./)
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
})

test('a slow model shows the time so far, and Cancel stops the request', async ({ page }, testInfo) => {
  await model(page, ['hang'])
  await openAsk(page)
  const before = await projectState(page)
  await send(page, 'make the chorus more intense')
  await expect(page.getByText('Thinking…')).toBeVisible()
  // The request is flagged slow after 8 s; the time counts from when it was sent.
  await expect(page.getByText(/^Still working… 0:(0[89]|[1-5]\d)$/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Models on this computer can take a minute or more.')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('ask-slow.png') })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('“make the chorus more intense”')).toBeHidden()
  expect((await projectState(page)).clips).toBe(before.clips)
})

test('the request to the model goes straight to the network, not through the isolation service worker', async ({
  page,
}) => {
  await model(page, [addTitle])
  const viaWorker: string[] = []
  page.context().on('request', (request) => {
    if (request.serviceWorker()) viaWorker.push(request.url())
  })
  await openAsk(page)
  expect(await page.evaluate(() => window.crossOriginIsolated && !!navigator.serviceWorker.controller)).toBe(
    true,
  )

  const answered = page.waitForResponse((r) => r.url() === CHAT && r.request().method() === 'POST')
  await send(page, 'add a title at the start')
  // Chrome gives a service worker about 5 minutes to answer one request, and a local model can take longer.
  expect((await answered).fromServiceWorker()).toBe(false)
  await expect(page.getByText('Added a title at the start', { exact: true }).first()).toBeVisible()
  expect(viaWorker.filter((url) => url.startsWith('http://localhost:11434'))).toEqual([])

  // The site's own files still come through the worker, which keeps the page isolated.
  const own = page.waitForResponse((r) => r.url().endsWith('/favicon.svg'))
  await page.evaluate(() => fetch('./favicon.svg', { cache: 'no-store' }))
  expect((await own).fromServiceWorker()).toBe(true)
})

test('a model server that is not running says it could not connect', async ({ page }) => {
  await page.context().route(CHAT, (route) => route.abort('connectionrefused'))
  await openAsk(page)
  await send(page, 'make the chorus more intense')
  await expect(page.getByText('Couldn’t connect to Ollama on this computer', { exact: true })).toBeVisible()
  await expect(page.getByText(/^No answer from http:\/\/localhost:11434\/v1\./)).toBeVisible()
})

test('a model that never answers stops at the answer time limit and says it took too long', async ({
  page,
}) => {
  await model(page, ['hang'])
  await openAsk(page, { ...OLLAMA, timeoutSeconds: 20 })
  await send(page, 'make the chorus more intense')
  await expect(page.getByText('The model took too long to answer', { exact: true })).toBeVisible({
    timeout: 40_000,
  })
  await expect(page.getByText('No answer after 20 s, so MV Studio stopped waiting.')).toBeVisible()
})

test('a request Ollama cut short stops at the first answer and says how to raise the context length', async ({
  page,
}, testInfo) => {
  const bodies = await model(page, [
    { ...addTitle, promptTokens: 2050 },
    { ...addTitle, promptTokens: 11_000 },
  ])
  await openAsk(page)
  const before = await projectState(page)
  await send(page, 'add a title at the start')
  await expect(page.getByText('Ollama read only part of the request', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      /^Its context length is too small \(it read 2,050 of about [\d,]+ tokens\)\. Nothing was changed, since an answer to part of the request would be wrong\.$/,
    ),
  ).toBeVisible()
  // The ways to raise it are alternatives under that step, not steps of their own.
  const raise = page.locator('li', { hasText: /^Raise Ollama’s context length to 16k, then try again:/ })
  await expect(raise.locator('li')).toHaveText([
    'Ollama app (macOS, Windows): Settings › Context length › 16k.',
    /^Linux: run sudo systemctl edit ollama/,
    'From a terminal: OLLAMA_CONTEXT_LENGTH=16384 ollama serve',
  ])
  await expect(
    page.getByText('A larger context uses more memory: about 0.7 GB more for qwen2.5:7b.'),
  ).toBeVisible()
  expect(bodies).toHaveLength(1)
  expect((await projectState(page)).clips).toBe(before.clips)
  // Long commands wrap inside the panel instead of running past its edge.
  const linux = raise.locator('li', { hasText: 'sudo systemctl edit ollama' })
  expect(await linux.evaluate((li) => li.scrollWidth - li.clientWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath('ask-prompt-cut.png') })

  // Once the context holds the request, the count matches and the edit applies.
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Added a title at the start', { exact: true }).first()).toBeVisible()
  expect(await projectState(page)).toMatchObject({ clips: before.clips + 1, titles: 1 })
  expect(bodies).toHaveLength(2)
})

test('a sentence typed in the command palette goes to the Ask box', async ({ page }) => {
  const bodies = await model(page, [addTitle])
  await openHarness(page)
  await page.evaluate((settings) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.cloud.v1', JSON.stringify({ llm: settings }))
  }, OLLAMA)
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => {
    window.location.hash = '#/editor?kind=ai&tab=inspector'
  })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  const palette = page.getByRole('dialog')
  await palette.getByRole('combobox').fill('add a title at the start')
  await palette.getByRole('option', { name: /^Ask Assist: “add a title at the start”/ }).click()
  await expect(palette).toBeHidden()
  await expect(page.getByText('“add a title at the start”')).toBeVisible()
  await expect(page.getByText('Added a title at the start', { exact: true }).first()).toBeVisible()
  expect(await projectState(page)).toMatchObject({ titles: 1, undo: 'Ask: Added a title at the start' })
  expect(bodies[0]).toContain('Request: add a title at the start')
})
