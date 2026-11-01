import { chromium, type Page, type Route } from '@playwright/test'
import { expect, openApp, test } from './fixtures.ts'

/*
 * Settings › AI and cloud with the real cloud clients. No keys or local model servers exist on CI, so the provider
 * endpoints are answered at the network level, as fal.ai, OpenAI and Ollama answer (CORS headers included).
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
}

type Reply = { status: number; body?: unknown } | 'refused'

/** Answers requests to `url`, recording each one. */
async function serve(page: Page, url: string, reply: Reply): Promise<string[]> {
  const seen: string[] = []
  await page.context().route(url, (route: Route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    seen.push(`${request.method()} ${request.url()}`)
    if (reply === 'refused') return route.abort('connectionrefused')
    return route.fulfill({
      status: reply.status,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify(reply.body ?? {}),
    })
  })
  return seen
}

async function openAiSettings(page: Page, path?: string) {
  await openApp(page, path)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?dialog=settings&page=ai'
  })
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'AI and cloud' })).toBeVisible()
  return dialog
}

const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('mv-studio.cloud.v1') ?? '{}'))

const card = (page: Page, title: string) =>
  page.getByRole('dialog', { name: 'Settings' }).locator('section').filter({ hasText: title })

test('connects a model on this computer, saves it, and keeps it after a reload', async ({
  page,
}, testInfo) => {
  await serve(page, 'http://localhost:11434/v1/models', {
    status: 200,
    body: { data: [{ id: 'llama3.2:3b' }, { id: 'qwen2.5:3b' }, { id: 'qwen2.5:7b' }] },
  })
  const dialog = await openAiSettings(page)
  const llm = card(page, 'Language model')
  await expect(llm.getByText('Not connected')).toBeVisible()
  await llm.getByRole('radio', { name: 'Ollama' }).click()
  await expect(llm.getByRole('textbox', { name: 'Endpoint URL' })).toHaveValue('http://localhost:11434/v1')
  await expect(llm.getByText('OLLAMA_ORIGINS=')).toBeVisible()
  await expect(llm.getByText('OLLAMA_CONTEXT_LENGTH=16384')).toBeVisible()

  await llm.getByRole('button', { name: 'Test connection' }).click()
  await expect(llm.getByText('3 models found')).toBeVisible()
  await expect(llm.getByText('Connected', { exact: true })).toBeVisible()
  // The recommended local model is preselected and saved.
  await expect(llm.getByRole('combobox', { name: 'Model' })).toHaveText('qwen2.5:7b')
  await expect(llm.getByText('Recommended: qwen2.5:7b.')).toBeVisible()
  // Once it works, the setup hint for local runners goes away, except the context length: Ollama connects with its
  // default context but cuts Ask's requests short.
  await expect(llm.getByText('OLLAMA_ORIGINS=')).toBeHidden()
  await expect(llm.getByText('OLLAMA_CONTEXT_LENGTH=16384')).toBeVisible()
  await expect(
    llm.getByText(
      /Set Ollama’s context length to 16k, in the Ollama app under Settings › Context length or with/,
    ),
  ).toBeVisible()
  await llm.screenshot({ path: testInfo.outputPath('settings-ollama-connected.png') })
  expect((await saved(page)).llm).toMatchObject({
    preset: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
  })

  // A small model is saved too, with a hint that it may misplace edits.
  await llm.getByRole('combobox', { name: 'Model' }).click()
  await page.getByRole('option', { name: 'qwen2.5:3b' }).click()
  await expect(llm.getByText('This is a small model (3B).', { exact: false })).toBeVisible()
  expect((await saved(page)).llm.model).toBe('qwen2.5:3b')

  await llm.getByRole('combobox', { name: 'Answer time limit' }).click()
  await expect(page.getByRole('option', { name: 'Default · 5 min' })).toBeVisible()
  await page.getByRole('option', { name: '2 min' }).click()
  expect((await saved(page)).llm.timeoutSeconds).toBe(120)
  await llm.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await dialog.screenshot({ path: testInfo.outputPath('settings-ai-connected.png') })
  await page.setViewportSize({ width: 1280, height: 720 })
  await dialog.screenshot({ path: testInfo.outputPath('settings-ai-connected-1280.png') })
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.reload()
  await expect(llm.getByText('Connected', { exact: true })).toBeVisible()
  await expect(llm.getByRole('combobox', { name: 'Model' })).toHaveText('qwen2.5:3b')
  await expect(llm.getByRole('combobox', { name: 'Answer time limit' })).toHaveText('2 min')

  // Looking at another provider's untested fields doesn't claim they are connected.
  await llm.getByRole('radio', { name: 'OpenAI' }).click()
  await expect(llm.getByText('Ollama connected')).toBeVisible()
  await llm.getByRole('radio', { name: 'Ollama' }).click()
  await expect(llm.getByText('Connected', { exact: true })).toBeVisible()

  await llm.getByRole('button', { name: 'Remove this connection' }).click()
  await expect(llm.getByText('Not connected')).toBeVisible()
  expect((await saved(page)).llm).toBeNull()
})

test('says how to let this site reach LM Studio when it does not answer, and saves nothing', async ({
  page,
}, testInfo) => {
  const seen = await serve(page, 'http://localhost:1234/v1/models', 'refused')
  const dialog = await openAiSettings(page)
  const llm = card(page, 'Language model')
  await llm.getByRole('radio', { name: 'LM Studio' }).click()
  await llm.getByRole('button', { name: 'Test connection' }).click()
  const alert = llm.getByRole('alert')
  await expect(alert).toContainText('Couldn’t connect to LM Studio on this computer'.replace('’', "'"))
  await expect(alert).toContainText('turn on "Enable CORS"')
  expect(seen).toEqual(['GET http://localhost:1234/v1/models'])
  expect((await saved(page)).llm ?? null).toBeNull()
  await expect(llm.getByText('Not connected')).toBeVisible()
  await alert.scrollIntoViewIfNeeded()
  await dialog.screenshot({ path: testInfo.outputPath('settings-ai-lmstudio-unreachable.png') })
})

test('lists the ways to allow this site in Ollama under the step they belong to', async ({
  page,
}, testInfo) => {
  await serve(page, 'http://localhost:11434/v1/models', 'refused')
  const dialog = await openAiSettings(page)
  const llm = card(page, 'Language model')
  await llm.getByRole('radio', { name: 'Ollama' }).click()
  await llm.getByRole('button', { name: 'Test connection' }).click()
  const alert = llm.getByRole('alert')
  await expect(alert).toContainText("Couldn't connect to Ollama on this computer")
  const allow = alert.locator('li', { hasText: /^Allow this site: set OLLAMA_ORIGINS/ })
  await expect(allow.locator('li')).toHaveText([/^macOS: /, /^Windows: /, /^Linux: /])
  await alert.scrollIntoViewIfNeeded()
  await dialog.screenshot({ path: testInfo.outputPath('settings-ai-ollama-unreachable.png') })
})

test('asks for an OpenAI key and reports a rejected one', async ({ page }) => {
  const seen = await serve(page, 'https://api.openai.com/v1/models', {
    status: 401,
    body: { error: { message: 'Incorrect API key provided: sk-test.', code: 'invalid_api_key' } },
  })
  await openAiSettings(page)
  const llm = card(page, 'Language model')
  await llm.getByRole('radio', { name: 'OpenAI' }).click()
  await expect(llm.getByRole('textbox', { name: 'Endpoint URL' })).toHaveValue('https://api.openai.com/v1')
  await expect(llm.getByText('Recommended: gpt-4.1-mini.')).toBeVisible()
  await llm.getByRole('button', { name: 'Test connection' }).click()
  await expect(llm.getByRole('alert')).toContainText('Add your OpenAI key')
  expect(seen).toEqual([])

  await llm.getByLabel('LLM API key').fill('sk-test')
  await llm.getByRole('button', { name: 'Test connection' }).click()
  await expect(llm.getByRole('alert')).toContainText('OpenAI rejected the key')
  expect(seen).toEqual(['GET https://api.openai.com/v1/models'])
  expect((await saved(page)).llm ?? null).toBeNull()
})

test('checks a fal.ai key for free before saving it, and removes it', async ({ page }, testInfo) => {
  let accept = false
  const seen: string[] = []
  await page.context().route('https://queue.fal.run/**', (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    seen.push(`${request.method()} ${new URL(request.url()).pathname}`)
    // fal.ai checks the key first: a good key gets "not found" for a request id that doesn't exist.
    return route.fulfill({
      status: accept ? 404 : 401,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ detail: accept ? 'Request not found' : 'Invalid key' }),
    })
  })
  const dialog = await openAiSettings(page)
  const fal = card(page, 'fal.ai')
  const key = fal.getByLabel('fal.ai key')

  await key.fill('not-a-key')
  await fal.getByRole('button', { name: 'Connect' }).click()
  await expect(fal.getByRole('alert')).toContainText('That doesn’t look like a fal.ai key'.replace('’', "'"))
  expect(seen).toEqual([])

  await key.fill('key-id:wrong-secret')
  await fal.getByRole('button', { name: 'Connect' }).click()
  await expect(fal.getByRole('alert')).toContainText('fal.ai rejected the key')
  expect((await saved(page)).falKey ?? '').toBe('')

  accept = true
  await key.fill('key-id:key-secret')
  await fal.getByRole('button', { name: 'Connect' }).click()
  await expect(fal.getByText('Connected', { exact: true })).toBeVisible()
  await expect(fal.getByLabel('fal.ai key')).toHaveValue('•••• cret')
  expect((await saved(page)).falKey).toBe('key-id:key-secret')
  // Only free status checks reached fal.ai: nothing was submitted.
  expect(seen.length).toBe(2)
  for (const s of seen) expect(s).toMatch(/^GET \/fal-ai\/flux\/requests\/[^/]+\/status$/)
  await dialog.screenshot({ path: testInfo.outputPath('settings-ai-fal-connected.png') })

  await fal.getByRole('button', { name: 'Remove' }).click()
  await expect(fal.getByText('Not connected')).toBeVisible()
  expect((await saved(page)).falKey).toBe('')
})

test('says what this month’s generations cost, as "Under $0.01" when that small', async ({ page }) => {
  await openAiSettings(page)
  const spending = card(page, 'Spending')
  for (const [usd, line] of [
    [0.003, 'Under $0.01 so far this month'],
    [0.51, 'About $0.51 so far this month'],
  ] as const) {
    await page.evaluate((spent) => {
      const entry = { at: new Date().toISOString(), usd: spent, label: 'Director: test' }
      localStorage.setItem('mv-studio.cloud.spend.v1', JSON.stringify([entry]))
    }, usd)
    await page.reload()
    await expect(spending.getByText(line, { exact: true })).toBeVisible()
  }
})

test('a fal.ai key check that gets no answer stops with Try again, and the typed key stays when Settings closes', async ({
  page,
}, testInfo) => {
  let answer = false
  const unanswered: Route[] = []
  await page.context().route('https://queue.fal.run/**', (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (!answer) {
      unanswered.push(route)
      return
    }
    return route.fulfill({
      status: 404,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Request not found' }),
    })
  })
  const dialog = await openAiSettings(page, './?e2e=1')
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => window.mvStudio.app.cloud.setFalKeyCheckTimeoutForTests(1500))
  const fal = card(page, 'fal.ai')
  const key = fal.getByLabel('fal.ai key')
  await key.fill('key-id:key-secret')
  await fal.getByRole('button', { name: 'Connect' }).click()
  await expect(fal.getByRole('button', { name: 'Checking…' })).toBeDisabled()
  await expect(fal.getByRole('alert')).toContainText("fal.ai didn't answer")
  await expect(fal.getByRole('alert')).toContainText(
    "No answer after 2 s, so MV Studio stopped waiting. The key isn't saved yet.",
  )
  await expect(fal.getByRole('button', { name: 'Try again' })).toBeEnabled()
  await expect(key).toHaveValue('key-id:key-secret')
  expect(unanswered).toHaveLength(1)
  expect((await saved(page)).falKey ?? '').toBe('')
  await dialog.screenshot({ path: testInfo.outputPath('settings-ai-fal-no-answer.png') })

  // Closing Settings keeps the typed key and what its check said.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.evaluate(() => (window.location.hash = '#/editor?dialog=settings&page=ai'))
  await expect(key).toHaveValue('key-id:key-secret')
  await expect(fal.getByText('Not connected')).toBeVisible()
  await expect(fal.getByRole('alert')).toContainText("fal.ai didn't answer")

  answer = true
  await fal.getByRole('button', { name: 'Try again' }).click()
  await expect(fal.getByText('Connected', { exact: true })).toBeVisible()
  expect((await saved(page)).falKey).toBe('key-id:key-secret')
  await expect(fal.getByRole('alert')).toHaveCount(0)
  await Promise.all(unanswered.map((r) => r.abort().catch(() => {})))
})

test('Chrome doesn’t offer to save a fal.ai or LLM key as a password', async ({ baseURL }, testInfo) => {
  // The password manager runs in full Chromium, not the headless shell the other tests use. Its internals page logs
  // each form Chrome would offer to save while it is open.
  const context = await chromium.launchPersistentContext(testInfo.outputPath('profile-pm'), {
    channel: 'chromium',
    headless: true,
    baseURL,
    viewport: { width: 1440, height: 900 },
  })
  try {
    await context.route('https://queue.fal.run/**', (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers: CORS })
        : route.fulfill({
            status: 404,
            headers: CORS,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'Request not found' }),
          }),
    )
    const internals = context.pages()[0] ?? (await context.newPage())
    await internals.goto('chrome://password-manager-internals')
    const page = await context.newPage()
    await openAiSettings(page)
    const fal = card(page, 'fal.ai')
    await card(page, 'Language model').getByLabel('LLM API key').pressSequentially('sk-not-a-password')
    await fal.getByLabel('fal.ai key').pressSequentially('key-id:key-secret')
    await fal.getByRole('button', { name: 'Connect', exact: true }).click()
    // The key field goes away as the key is saved, which Chrome reads as a sign-in that worked.
    await expect(fal.getByText('Connected', { exact: true })).toBeVisible()
    const log = internals.locator('body')
    await expect(log).toContainText('The new state of the UI')
    await page.waitForTimeout(1000)
    await expect(log).not.toContainText('PENDING_PASSWORD_STATE')
    await expect(log).not.toContainText('ProvisionallySaveForm')
  } finally {
    await context.close()
  }
})

test('saves the spending settings', async ({ page }) => {
  await openAiSettings(page)
  const spending = card(page, 'Spending')
  await expect(spending.getByText('Otherwise only batches over $1.00 ask first.')).toBeVisible()
  await spending.getByRole('switch', { name: 'Ask before every paid generation' }).click()
  expect((await saved(page)).alwaysConfirmPaid).toBe(true)
  await spending.getByRole('combobox', { name: 'Spending reminder' }).click()
  await page.getByRole('option', { name: '$5', exact: true }).click()
  expect((await saved(page)).monthlyReminderUsd).toBe(5)
})
