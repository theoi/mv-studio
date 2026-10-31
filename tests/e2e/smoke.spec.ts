import { expect, openApp, test } from './fixtures.ts'

test('loads cross-origin isolated from the static sub-path via the service worker', async ({
  page,
  baseURL,
}) => {
  await openApp(page)
  await expect(page.getByRole('heading', { name: 'MV Studio' })).toBeVisible()
  await expect(page.getByTestId('cap-isolated')).toHaveText('true')
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function')
  expect(Number(await page.getByTestId('cap-threads').textContent())).toBeGreaterThanOrEqual(1)

  await page.reload()
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)

  // COEP credentialless (not require-corp) lets no-cors images load from hosts that send no CORP header. Locally,
  // localhost and 127.0.0.1 are different origins served by the same header-less preview server.
  const url = new URL(baseURL ?? page.url())
  test.skip(url.hostname !== '127.0.0.1', 'cross-origin image check needs the local preview server')
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
