import { expect, openApp, test } from './fixtures.ts'

test('loads cross-origin isolated from the static sub-path via the service worker', async ({ page }) => {
  await openApp(page)
  await expect(page.getByRole('heading', { name: 'What are you making?' })).toBeVisible()
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'This device' }).click()
  await expect(page.getByTestId('cap-isolated')).toHaveAttribute('data-value', 'true')
  expect(Number(await page.getByTestId('cap-threads').getAttribute('data-value'))).toBeGreaterThanOrEqual(1)

  await page.reload()
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)
})

test('isolation uses COEP credentialless, so no-cors images without CORP still load', async ({
  page,
  baseURL,
}) => {
  // Locally, localhost and 127.0.0.1 are different origins served by the same header-less preview server.
  const url = new URL(baseURL ?? 'http://127.0.0.1:4173/mv-studio/')
  test.skip(url.hostname !== '127.0.0.1', 'needs the local preview server as a second origin')
  await openApp(page)
  url.hostname = 'localhost'
  const imageUrl = new URL('favicon.svg', url).href
  const loaded = await page.evaluate(
    (src) =>
      new Promise<boolean>((resolve) => {
        const img = new Image()
        img.onload = () => resolve(true)
        img.onerror = () => resolve(false)
        img.src = src
      }),
    imageUrl,
  )
  expect(loaded).toBe(true)
})
