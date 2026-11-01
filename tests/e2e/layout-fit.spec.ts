import type { Locator, Page } from '@playwright/test'
import { expect, openApp, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * Layout checks at the smallest supported window, where panels are narrowest, unless a test says otherwise. The
 * persistent-context fixture ignores test.use({ viewport }), so each test sets the size itself.
 */
const small = (page: Page, size = { width: 1280, height: 720 }) => page.setViewportSize(size)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
}

async function openEditor(page: Page, hash = '#/editor?t=73.6', size?: { width: number; height: number }) {
  await small(page, size)
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
}

test('the library’s song card shows its whole summary, and its waveform only where it fits whole', async ({
  page,
}) => {
  await openEditor(page)
  await waitForPreview(page)
  const row = page.locator('[class*="songRow"]')
  await expect(row.getByText(/BPM · \d+ sections/)).toBeVisible()
  for (const width of [1280, 1440, 1600, 1920]) {
    await small(page, { width, height: 720 })
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    // Unrounded widths: scrollWidth and clientWidth round, and missed a summary cut by a tenth of a pixel.
    const fit = await row.evaluate((el) => {
      const meta = el.querySelector('[class*="songMeta"]')!
      const wave = el.querySelector('[class*="songWave"]')!.getBoundingClientRect()
      const text = document.createRange()
      text.selectNodeContents(meta)
      return {
        text: text.getBoundingClientRect().width,
        box: meta.getBoundingClientRect().width,
        textRight: text.getBoundingClientRect().right,
        wave: { left: wave.left, width: wave.width },
      }
    })
    expect(fit.text, `summary at ${width}`).toBeLessThanOrEqual(fit.box)
    if (fit.wave.width > 0) {
      expect(fit.wave.width, `waveform at ${width}`).toBe(64)
      expect(fit.textRight, `summary beside the waveform at ${width}`).toBeLessThanOrEqual(fit.wave.left)
    }
  }
  // The widest library has room for both, so the waveform is not simply gone.
  expect(await row.locator('[class*="songWave"]').evaluate((el) => el.getBoundingClientRect().width)).toBe(64)
})

test('a menu button keeps its open highlight while its menu is open, though it has a tooltip', async ({
  page,
}) => {
  await openEditor(page)
  await waitForPreview(page)
  const background = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
  for (const name of ['View options', 'Help']) {
    // includeHidden: an open menu hides the rest of the page from assistive technology, its trigger included.
    const trigger = page.getByRole('button', { name, exact: true, includeHidden: true })
    const closed = await background(trigger)
    // From the keyboard, so the pointer's hover can't supply the highlight.
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(trigger, name).not.toHaveCSS('background-color', closed)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
  }
})

test('the timeline tool control shows which tool is on, though each choice has a tooltip', async ({
  page,
}) => {
  await openEditor(page)
  await waitForPreview(page)
  const group = page.getByRole('radiogroup', { name: 'Timeline tool' })
  const select = group.getByRole('radio', { name: 'Select' })
  const split = group.getByRole('radio', { name: /^Split/ })
  const background = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
  await expect(select).toHaveAttribute('aria-checked', 'true')
  const on = await background(select)
  const off = await background(split)
  expect(on).not.toBe(off)
  await split.click()
  await expect(split).toHaveAttribute('aria-checked', 'true')
  await expect(split).toHaveCSS('background-color', on)
  await expect(select).toHaveCSS('background-color', off)
})

test('Settings rows grow with their descriptions instead of spilling over the next row', async ({ page }) => {
  await openEditor(page, '#/editor?dialog=settings&page=local')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByText('CPU threads for AI')).toBeVisible()
  const rows = await dialog.evaluate((el) =>
    [...el.querySelectorAll('[class*="rowText"]')].map((text) => ({
      text: text.textContent?.slice(0, 40),
      spill: text.getBoundingClientRect().height - text.parentElement!.getBoundingClientRect().height,
    })),
  )
  expect(rows.length).toBeGreaterThan(3)
  expect(rows.filter((r) => r.spill > 0)).toEqual([])
})

test('a long toast keeps its Dismiss button full size', async ({ page }) => {
  await openEditor(page)
  await waitForPreview(page)
  await page.evaluate(() => {
    const ui = window.mvStudio.app.ui
    ui.toast(
      'Imported 14 files: 9 clips or images, 3 LUTs, 2 songs. “a-very-long-file-name-from-the-camera-roll-final-v3.mov” could not be read because this browser does not support its codec.',
      { label: 'Show', run: () => {} },
    )
    for (const t of ui.get().toasts) ui.holdToast(t.id)
  })
  // Layout size: the toast's entrance animation scales its box for a moment.
  const size = await page
    .getByRole('button', { name: 'Dismiss' })
    .evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight])
  expect(size).toEqual([24, 24])
})

test('a failed director draft keeps both footer buttons inside the narrow panel', async ({ page }) => {
  await page
    .context()
    .route(/https:\/\/(queue\.)?fal\.run\/.*/, (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers: CORS })
        : route.fulfill({ status: 500, headers: CORS, body: '{}' }),
    )
  await small(page)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem(
      'mv-studio.cloud.v1',
      JSON.stringify({ falKey: 'key-id:key-secret', alwaysConfirmPaid: true }),
    )
  })
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => (window.location.hash = '#/editor?kind=ai&tab=assist&assist=director'))
  await page.getByRole('radio', { name: 'Mix' }).click()
  await page.getByRole('button', { name: 'Draft video' }).click()
  await page.getByRole('button', { name: /^Generate \d+ shots? · about \$\d+\.\d\d$/ }).click()
  const dialog = page.getByRole('dialog', { name: /^Generate \d+ shots?\?$/ })
  await dialog.getByRole('button', { name: /^Generate \d+ shots? · about/ }).click()
  const retry = page.getByRole('button', { name: /^Retry · about \$\d+\.\d\d$/ })
  await expect(retry).toBeVisible({ timeout: 30_000 })
  const panel = (await page.getByRole('tabpanel', { name: 'Assist' }).boundingBox())!
  for (const button of [page.getByRole('button', { name: 'Back to the plan' }), retry]) {
    const box = (await button.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(panel.x)
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width)
  }
})

test('an empty project’s drop hint reaches the right edge of a wide timeline', async ({ page }) => {
  await openEditor(page, '#/editor?project=empty&kind=blank', { width: 1920, height: 1080 })
  await expect(page.getByText('Drop your song here')).toBeVisible()
  const gap = await page.evaluate(() => {
    const scroller = document.querySelector('[data-timeline-scroller]')!
    const hint = document.querySelector('[class*="dropHint"]')!
    return scroller.getBoundingClientRect().right - hint.getBoundingClientRect().right
  })
  expect(gap).toBeLessThanOrEqual(24)
})

test('a long context menu or submenu fills the window’s height before it scrolls', async ({ page }) => {
  // Every menu fits the smallest supported window, so shorter ones force the scroll: 300 px for the longest menu,
  // a pad's 12-item Visuals submenu, and 140 px for the pad's 4-item menu.
  await small(page, { width: 1280, height: 300 })
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/vj?t=60'
  })
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  const fillsWindow = async (menu: Locator) => {
    // Layout sizes: the menu's entrance animation scales its box for a moment.
    const fit = await menu.evaluate((el: HTMLElement) => ({
      scrolls: el.scrollHeight > el.clientHeight,
      height: el.offsetHeight,
      bottom: el.parentElement!.getBoundingClientRect().top + el.offsetHeight,
      window: innerHeight,
    }))
    // Taller than the window, so it takes the window's height less 8 px margins and scrolls the rest.
    expect(fit.scrolls).toBe(true)
    expect(fit.height).toBeGreaterThanOrEqual(fit.window - 2 * 8 - 1)
    expect(fit.bottom).toBeLessThanOrEqual(fit.window - 8)
  }
  const pad = page.getByRole('button', { name: 'Rain on glass', exact: true })
  const menu = page.getByRole('menu')

  await pad.click({ button: 'right' })
  await page.mouse.move(5, 5)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Visuals' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  const visuals = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Orb' }) })
  await expect(visuals.getByRole('menuitem')).toHaveCount(12)
  await fillsWindow(visuals)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await small(page, { width: 1280, height: 140 })
  await pad.click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveCount(4)
  await fillsWindow(menu)
})

type Box = { x: number; y: number; width: number; height: number }
const within = (inner: Box, outer: Box) =>
  inner.y >= outer.y - 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5

/**
 * Assist › Director at its price step (Mix, with a fal.ai key whose calls fail), in a window of `size`, with the right
 * panel `right` px wide (its default when not given).
 */
async function openDirectorPrice(page: Page, size: { width: number; height: number }, right?: number) {
  await page
    .context()
    .route(/https:\/\/(queue\.)?fal\.run\/.*/, (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers: CORS })
        : route.fulfill({ status: 500, headers: CORS, body: '{}' }),
    )
  await small(page, size)
  await openHarness(page)
  await page.evaluate((r) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem(
      'mv-studio.cloud.v1',
      JSON.stringify({ falKey: 'key-id:key-secret', alwaysConfirmPaid: true }),
    )
    localStorage.setItem('mv-studio.panel-sizes', JSON.stringify(r ? { right: r } : {}))
  }, right)
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => (window.location.hash = '#/editor?kind=ai&tab=assist&assist=director'))
  await page.getByRole('radio', { name: 'Mix' }).click()
  await page.getByRole('button', { name: 'Draft video' }).click()
  const generate = page.getByRole('button', { name: /^Generate \d+ shots? · about \$\d+\.\d\d$/ })
  await expect(generate).toBeAttached({ timeout: 30_000 })
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  return { panel, generate, scroller: panel.locator('[class*="viewScroll"]') }
}

/** Puts a block of `height` px above the footer's button, as a note there would. */
const tallerFooter = (panel: Locator, height: number) =>
  panel.locator('[data-tool-footer]').evaluate((footer, h) => {
    const note = document.createElement('div')
    note.style.height = `${h}px`
    footer.prepend(note)
  }, height)

for (const right of [undefined, 272])
  test(`at 1280×720 the Director’s price buttons stay in view under the scrolling plan${right ? ` in a ${right} px panel` : ''}`, async ({
    page,
  }) => {
    const { panel, generate, scroller } = await openDirectorPrice(page, { width: 1280, height: 720 }, right)
    const view = (await scroller.boundingBox())!
    expect(within((await generate.boundingBox())!, view)).toBe(true)
    const apply = panel.getByRole('button', { name: 'Apply without AI shots' })
    expect(within((await apply.boundingBox())!, view)).toBe(true)
    const footer = (await panel.locator('[data-tool-footer]').boundingBox())!
    expect(footer.height).toBeLessThan(view.height / 3)
    expect(within((await panel.getByText('Intro', { exact: true }).first().boundingBox())!, view)).toBe(true)

    // Who charges the price shows under the plan instead of in the footer, and the buttons stay pinned below it.
    await expect(panel.locator('[data-tool-footer]').getByText(/Charged by fal\.ai/)).toBeHidden()
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    const charged = panel
      .locator('[class*="viewBody"]')
      .getByText(/Charged by fal\.ai to your\skey\s· prices checked /)
    await expect(charged).toBeVisible()
    expect(within((await charged.boundingBox())!, view)).toBe(true)
    expect(within((await generate.boundingBox())!, view)).toBe(true)
  })

test('at 1280×720 a footer too tall to pin ends the scroll, with a fade until Tab or scrolling reaches its button', async ({
  page,
}) => {
  const { panel, generate, scroller } = await openDirectorPrice(page, { width: 1280, height: 720 })
  await tallerFooter(panel, 80)
  await expect(scroller).toHaveAttribute('data-footer-scrolls', '')
  const view = (await scroller.boundingBox())!
  const fade = () => scroller.evaluate((el) => Number(getComputedStyle(el, '::after').opacity))
  expect(await fade()).toBe(1)
  expect(within((await generate.boundingBox())!, view)).toBe(false)

  // Tab from the header reaches the primary button and scrolls it into view.
  await panel.getByRole('button', { name: 'All tools' }).focus()
  for (let i = 0; i < 40 && !(await generate.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab')
  await expect(generate).toBeFocused()
  expect(within((await generate.boundingBox())!, view)).toBe(true)

  // At the end of the scroll there is nothing more below, so no fade.
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect.poll(fade).toBe(0)
})

test('at 1280×720 Auto-cut and Director keep their main action pinned in view under the scrolling settings', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67&tab=assist&assist=autocut')
  await waitForPreview(page)
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const scroller = panel.locator('[class*="viewScroll"]')
  for (const [view, action] of [
    ['autocut', 'Cut to the beat'],
    ['director', 'Draft video'],
  ] as const) {
    await page.evaluate((v) => window.mvStudio.app.ui.set({ rightTab: 'assist', assistView: v }), view)
    const button = panel.getByRole('button', { name: action })
    await expect(button).toBeVisible()
    const box = (await scroller.boundingBox())!
    expect(within((await button.boundingBox())!, box), view).toBe(true)
    // The settings scroll under it, and the body keeps most of the panel.
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight), view).toBe(true)
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight / 2))
    expect(within((await button.boundingBox())!, box), view).toBe(true)
    const footer = (await panel.locator('[data-tool-footer]').boundingBox())!
    expect(footer.height, view).toBeLessThan(box.height / 3)
  }
})

test('at 900 px tall the Director’s price footer stays pinned under the scrolling plan, however tall it gets', async ({
  page,
}) => {
  const { panel, generate, scroller } = await openDirectorPrice(page, { width: 1280, height: 900 }, 272)
  const pinned = () =>
    scroller.evaluate((el) => {
      const footer = el.querySelector('[class*="viewFooter"]')!.getBoundingClientRect()
      return {
        overflows: el.scrollHeight > el.clientHeight,
        gap: Math.round(el.getBoundingClientRect().bottom - footer.bottom),
      }
    })
  expect(await pinned()).toEqual({ overflows: true, gap: 0 })
  expect(within((await generate.boundingBox())!, (await scroller.boundingBox())!)).toBe(true)
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight / 2))
  expect(await pinned()).toEqual({ overflows: true, gap: 0 })
  // A note above the button doesn't unpin it at this height (a third of the plan's area would).
  await tallerFooter(panel, 80)
  await expect(scroller).not.toHaveAttribute('data-footer-scrolls')
  expect(await pinned()).toEqual({ overflows: true, gap: 0 })
  expect(within((await generate.boundingBox())!, (await scroller.boundingBox())!)).toBe(true)
})

test('a section’s color swatches fit one line in the narrow inspector', async ({ page }) => {
  await openEditor(page)
  await waitForPreview(page)
  await page.evaluate(() =>
    window.mvStudio.app.ui.set({ selection: { type: 'section', id: 's-c1' }, rightTab: 'inspector' }),
  )
  const swatches = page.getByRole('radiogroup', { name: 'Section color' }).getByRole('radio')
  await expect(swatches).toHaveCount(7)
  const tops = await swatches.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().top)),
  )
  expect(new Set(tops).size).toBe(1)
})

test('Assist home shows a running song analysis once, in the song card', async ({ page }) => {
  await openEditor(page, '#/editor?tab=assist&t=73.6')
  await waitForPreview(page)
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(panel.getByText('Song analyzed')).toBeVisible()
  await page.evaluate(() => {
    window.mvStudio.shared.jobs.run({
      kind: 'analysis.song',
      title: 'Analyzing the song',
      run: (ctx: { progress: (p: { fraction: number }) => void }) => {
        ctx.progress({ fraction: 0.4 })
        return new Promise<void>(() => {})
      },
    })
  })
  await expect(panel.getByText('40%', { exact: true })).toBeVisible()
  await expect(panel.getByText('Running', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('Analyzing the song', { exact: true })).toHaveCount(0)
})

test('Ask’s Apply keeps its primary colors and Discard stays grey, though text actions in Assist take the accent', async ({
  page,
}) => {
  // The language model answered at the network level, as Ollama answers, with an edit large enough to wait for review.
  const dim = {
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
              function: {
                name: 'edit_project',
                arguments: JSON.stringify({
                  summary: 'Dimmed the footage',
                  operations: [{ op: 'set', clips: { type: 'video' }, property: 'opacity', value: 0.5 }],
                }),
              },
            },
          ],
        },
      },
    ],
  }
  await page.context().route('http://localhost:11434/v1/chat/completions', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({
          status: 200,
          headers: CORS,
          contentType: 'application/json',
          body: JSON.stringify(dim),
        }),
  )
  await small(page)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem(
      'mv-studio.cloud.v1',
      JSON.stringify({
        llm: { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' },
      }),
    )
  })
  await page.reload()
  await page.waitForFunction(() => window.mvStudio?.ready === true)
  await page.evaluate(() => (window.location.hash = '#/editor?kind=ai&tab=assist'))
  const box = page.getByRole('textbox', { name: 'Ask Assist for a change' })
  await box.fill('dim all the footage')
  await box.press('Enter')
  const apply = page.getByRole('button', { name: 'Apply', exact: true })
  const discard = page.getByRole('button', { name: 'Discard', exact: true })
  await expect(apply).toBeVisible()

  /** WCAG contrast of a button's label against its own (opaque) background. */
  const contrast = (button: Locator) =>
    button.evaluate((el) => {
      const rgb = (css: string) =>
        css
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
      const lum = (c: number[]) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const style = getComputedStyle(el)
      const [a, b] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((x, y) => y - x)
      return (a! + 0.05) / (b! + 0.05)
    })
  expect(await contrast(apply)).toBeGreaterThanOrEqual(4.5)
  await apply.hover()
  await expect.poll(() => contrast(apply)).toBeGreaterThanOrEqual(4.5)

  // Discard dismisses the edit: grey, like the panel's other ghost buttons, not the accent of a forward action.
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent-text)'
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect(discard).not.toHaveCSS('color', accent)

  // At 1280 the three buttons don't fit one line: Discard wraps instead of running into the panel's padding.
  const row = (await apply.locator('xpath=..').boundingBox())!
  for (const button of [apply, page.getByRole('button', { name: 'Show where' }), discard]) {
    const box = (await button.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width + 0.5)
  }
})
