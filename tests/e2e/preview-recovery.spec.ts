import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * The editor's preview and the stills renderer come back after their render worker dies. Killing a worker from
 * outside (Worker.terminate()) fires no event, like the browser stopping a worker that ran out of memory.
 */

/** Records the workers the page starts with this name, so the test can kill them. */
async function recordWorkers(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => {
    const RealWorker = window.Worker
    const started: Worker[] = []
    window.mvStudio.startedWorkers = started
    window.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name === name) started.push(this)
      }
    }
  }, name)
}

/** Kills the newest preview worker, then makes an edit so the preview tries to draw. */
async function killPreview(page: Page, edit: string): Promise<number> {
  return page.evaluate((edit) => {
    const started: Worker[] = window.mvStudio.startedWorkers
    started[started.length - 1]?.terminate()
    window.mvStudio.app.project.editor.dispatch({ type: 'project.rename', name: edit })
    return started.length
  }, edit)
}

const workerCount = (page: Page) =>
  page.evaluate(() => (window.mvStudio.startedWorkers as Worker[] | undefined)?.length ?? 0)

test('the editor preview restarts on a new canvas when its render worker dies, and asks for a reload when it keeps dying', async ({
  page,
}) => {
  await openHarness(page)
  await recordWorkers(page, 'preview')
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=lyric&t=73'
  })
  const canvas = page.getByRole('img', { name: 'Video preview' })
  await expect(canvas).toHaveAttribute('aria-busy', 'false')
  expect(await workerCount(page)).toBe(1)
  const first = await canvas.elementHandle()

  // First death: a new worker and a new canvas, quietly.
  await killPreview(page, 'After one restart')
  await expect.poll(() => workerCount(page)).toBe(2)
  await expect(canvas).toHaveAttribute('aria-busy', 'false')
  expect(await first?.evaluate((el) => el.isConnected)).toBe(false)
  const restarted = page.getByText('The preview restarted', { exact: false })
  await expect(restarted).toBeHidden()

  // It draws on the new canvas: a seek renders without another restart.
  await page.evaluate(() =>
    window.mvStudio.app.project.editor.dispatch({ type: 'project.rename', name: 'Drawn' }),
  )
  await page.waitForTimeout(300)
  expect(await workerCount(page)).toBe(2)

  // Again soon after: restarts, and says so.
  await killPreview(page, 'After two restarts')
  await expect.poll(() => workerCount(page)).toBe(3)
  await expect(restarted).toBeVisible()
  // The next death comes once this preview is drawing: a worker that dies before its first frame is a separate case.
  await expect(canvas).toHaveAttribute('aria-busy', 'false')

  await killPreview(page, 'After three restarts')
  await expect.poll(() => workerCount(page)).toBe(4)
  await expect(canvas).toHaveAttribute('aria-busy', 'false')

  // A fourth death within two minutes: no more restarts; the stage asks for a reload.
  await killPreview(page, 'Stopped')
  await expect(page.getByRole('alert').filter({ hasText: 'The preview keeps stopping' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(await workerCount(page)).toBe(4)
})

test('a still renders on a new preview when the stills worker died', async ({ page }) => {
  await openHarness(page)
  await recordWorkers(page, 'preview')
  const r = await page.evaluate(async () => {
    const { model, app } = window.mvStudio
    const started: Worker[] = window.mvStudio.startedWorkers
    const p = model.createProject({ name: 'still' })
    const clip = model.createSolidClip({ trackId: p.tracks[0].id, color: '#ff0000', start: 0, duration: 4 })
    p.clips[clip.id] = clip
    const before = await app.stills.renderStill(p, 1, 64, 36)
    const workers = started.length
    started[0]?.terminate()
    const after = await app.stills.renderStill({ ...p, name: 'still 2' }, 2, 64, 36).then(
      (blob: Blob) => blob.size,
      (e: { code?: string; message?: string }) => `rejected: ${e.code ?? e.message}`,
    )
    return { before: before.size, workers, after, total: started.length }
  })
  expect(r.before).toBeGreaterThan(0)
  expect(r.workers).toBe(1)
  expect(r.after).toBeGreaterThan(0)
  expect(r.total).toBe(2)
})
