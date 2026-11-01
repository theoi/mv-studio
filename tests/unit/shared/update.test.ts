import { afterEach, describe, expect, it, vi } from 'vitest'
import { deployedBuild, isLoadFailure, newerBuildDeployed } from '../../../src/shared/update.ts'

declare const __BUILD_ID__: string

afterEach(() => vi.unstubAllGlobals())

function serve(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('the deployed build', () => {
  it("is read from version.json next to index.html, past the browser's cache", async () => {
    const fetchMock = serve({ build: 'abc' })
    expect(await deployedBuild()).toBe('abc')
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' })
  })

  it("is newer when its id is another than this build's", async () => {
    serve({ build: 'a build deployed later' })
    expect(await newerBuildDeployed()).toBe(true)
    serve({ build: __BUILD_ID__ })
    expect(await newerBuildDeployed()).toBe(false)
  })

  it('is unknown, so never newer, without a readable version.json (offline, a dev server)', async () => {
    serve('Not found', 404)
    expect(await newerBuildDeployed()).toBe(false)
    serve({ assets: [] })
    expect(await newerBuildDeployed()).toBe(false)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await newerBuildDeployed()).toBe(false)
  })
})

describe('code that failed to load', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://theoi.github.io/mv-studio/assets/Editor-abc.js',
    'Importing a module script failed.',
    'error loading dynamically imported module: https://theoi.github.io/mv-studio/assets/Editor-abc.js',
    'Unable to preload CSS for /mv-studio/assets/Editor-abc.css',
  ])('is recognized: %s', (message) => {
    expect(isLoadFailure(message)).toBe(true)
  })

  it.each(['Failed to fetch', 'The task stopped unexpectedly. Try again.', 'Model download failed (404)'])(
    'is not confused with other failures: %s',
    (message) => {
      expect(isLoadFailure(message)).toBe(false)
    },
  )
})
