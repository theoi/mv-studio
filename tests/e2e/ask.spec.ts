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

type Answer = { tool: string; args: Record<string, unknown> } | 'hang'

/** Answers each chat request with the next tool call in `answers`; returns the request bodies seen. */
async function model(page: Page, answers: Answer[]) {
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
  await expect(page.getByText(/^Text "Neon Skyline"/)).toBeVisible()
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
