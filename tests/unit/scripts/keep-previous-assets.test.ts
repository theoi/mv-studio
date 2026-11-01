import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keepPreviousAssets } from '../../../scripts/keep-previous-assets.ts'

const SITE = 'https://theoi.github.io/mv-studio/'
let dist: string

beforeEach(async () => {
  dist = await mkdtemp(path.join(tmpdir(), 'keep-assets-'))
  await mkdir(path.join(dist, 'assets'))
  await writeFile(path.join(dist, 'assets', 'shared-abc.js'), 'new build')
})

afterEach(() => rm(dist, { recursive: true, force: true }))

/** The live site: its version.json, and its files by path. Counts the requests per path. */
function liveSite(version: unknown, files: Record<string, string>, status = 200) {
  const requests: string[] = []
  const fetch = (async (url: string | URL | Request) => {
    const file = String(url).slice(SITE.length)
    requests.push(file)
    if (file === 'version.json') return new Response(JSON.stringify(version), { status })
    return file in files ? new Response(files[file]) : new Response('Not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

const quiet = { log: () => undefined }

describe("keeping the live build's files in the next deploy", () => {
  it('copies the files the live build lists that the new build lacks, and leaves the new build’s own', async () => {
    const site = liveSite(
      {
        build: 'live',
        assets: ['assets/index-old.js', 'assets/render.worker-old.js', 'assets/shared-abc.js'],
      },
      {
        'assets/index-old.js': 'old index',
        'assets/render.worker-old.js': 'old worker',
        'assets/shared-abc.js': 'old copy',
      },
    )
    const result = await keepPreviousAssets(SITE, dist, { fetch: site.fetch, ...quiet })
    expect(result.kept).toEqual(['assets/index-old.js', 'assets/render.worker-old.js'])
    expect(await readFile(path.join(dist, 'assets', 'render.worker-old.js'), 'utf8')).toBe('old worker')
    expect(await readFile(path.join(dist, 'assets', 'shared-abc.js'), 'utf8')).toBe('new build')
    expect(site.requests).not.toContain('assets/shared-abc.js')
    expect(result.bytes).toBe('old index'.length + 'old worker'.length)
  })

  it('keeps nothing outside assets/ whatever version.json lists', async () => {
    const site = liveSite(
      {
        assets: [
          'index.html',
          '../outside.js',
          'assets/../index.html',
          'assets/sub/x.js',
          42,
          'assets/ok.js',
        ],
      },
      { 'index.html': 'old page', 'assets/ok.js': 'ok' },
    )
    const result = await keepPreviousAssets(SITE, dist, { fetch: site.fetch, ...quiet })
    expect(result.kept).toEqual(['assets/ok.js'])
    expect(site.requests).toEqual(['version.json', 'assets/ok.js'])
    expect((await readdir(dist)).sort()).toEqual(['assets'])
  })

  it('stops adding files at the size cap, and skips files the live site no longer serves', async () => {
    const site = liveSite(
      { assets: ['assets/a.js', 'assets/gone.js', 'assets/big.js', 'assets/c.js'] },
      { 'assets/a.js': '1234', 'assets/big.js': '123456789', 'assets/c.js': '12' },
    )
    const result = await keepPreviousAssets(SITE, dist, { fetch: site.fetch, capBytes: 8, ...quiet })
    expect(result.kept).toEqual(['assets/a.js', 'assets/c.js'])
    expect(result.skipped).toEqual(['assets/gone.js', 'assets/big.js'])
    expect(result.bytes).toBe(6)
  })

  it('keeps nothing when the live site has no version.json yet or can’t be reached', async () => {
    const missing = liveSite('Not found', { 'assets/a.js': 'a' }, 404)
    expect(await keepPreviousAssets(SITE, dist, { fetch: missing.fetch, ...quiet })).toEqual({
      kept: [],
      skipped: [],
      bytes: 0,
    })
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch
    expect((await keepPreviousAssets(SITE, dist, { fetch: offline, ...quiet })).kept).toEqual([])
    expect(await readdir(path.join(dist, 'assets'))).toEqual(['shared-abc.js'])
  })
})

describe('a live site that misbehaves', () => {
  it('skips a file whose download breaks off, keeps the others, and leaves no partial file', async () => {
    const site = liveSite(
      { assets: ['assets/a.js', 'assets/broken.js', 'assets/c.js'] },
      { 'assets/a.js': 'a', 'assets/c.js': 'c' },
    )
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('broken.js'))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('7 bytes'))
            },
            pull(controller) {
              controller.error(new TypeError('terminated'))
            },
          }),
        )
      return site.fetch(url, init)
    }) as typeof globalThis.fetch
    const result = await keepPreviousAssets(SITE, dist, { fetch, ...quiet })
    expect(result.kept).toEqual(['assets/a.js', 'assets/c.js'])
    expect(result.skipped).toEqual(['assets/broken.js'])
    expect((await readdir(path.join(dist, 'assets'))).sort()).toEqual(['a.js', 'c.js', 'shared-abc.js'])
  })

  it('gives up on a request that stalls, and stops at the deadline with what it kept', async () => {
    const site = liveSite(
      { assets: ['assets/a.js', 'assets/stalls.js', 'assets/c.js', 'assets/d.js'] },
      { 'assets/a.js': 'a', 'assets/c.js': 'c', 'assets/d.js': 'd' },
    )
    const stalling = (stalls: (file: string) => boolean) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        if (!stalls(String(url))) return site.fetch(url, init)
        // Answers only to its abort signal.
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        )
      }) as typeof globalThis.fetch
    const slow = await keepPreviousAssets(SITE, dist, {
      fetch: stalling((url) => url.endsWith('stalls.js')),
      requestMs: 50,
      ...quiet,
    })
    expect(slow.kept).toEqual(['assets/a.js', 'assets/c.js', 'assets/d.js'])
    expect(slow.skipped).toEqual(['assets/stalls.js'])

    await rm(path.join(dist, 'assets', 'c.js'))
    await rm(path.join(dist, 'assets', 'd.js'))
    const late = await keepPreviousAssets(SITE, dist, {
      fetch: stalling((url) => url.endsWith('stalls.js')),
      requestMs: 10_000,
      deadlineMs: 100,
      ...quiet,
    })
    expect(late.kept).toEqual([])
    expect(late.skipped).toEqual(['assets/stalls.js', 'assets/c.js', 'assets/d.js'])
  })

  it('does not read a file whose announced size would pass the cap', async () => {
    let read = false
    const fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('version.json'))
        return new Response(JSON.stringify({ assets: ['assets/big.js'] }))
      return new Response(
        // A high-water mark of 0: pulled only when something reads it.
        new ReadableStream(
          {
            pull(controller) {
              read = true
              controller.close()
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-length': '1000' } },
      )
    }) as typeof globalThis.fetch
    const result = await keepPreviousAssets(SITE, dist, { fetch, capBytes: 999, ...quiet })
    expect(result.skipped).toEqual(['assets/big.js'])
    expect(read).toBe(false)
  })
})

describe('the command', () => {
  it('exits 0 whatever happens, so a deploy never fails on it', async () => {
    const run = (args: string[]) =>
      new Promise<number | null>((resolve) =>
        execFile(process.execPath, ['scripts/keep-previous-assets.ts', ...args], (error) =>
          resolve(error ? (error.code as number) : 0),
        ),
      )
    // Nothing listens there.
    expect(await run(['http://127.0.0.1:9/', dist])).toBe(0)
    expect(await run([])).toBe(0)
  })
})
