/**
 * Keeps the files of the build that is live now in the build about to be deployed, so tabs still running the live
 * build can load the workers and screens they have not loaded yet. Each build lists its files in version.json
 * (vite.config.ts). Only the live build's files are added, not older ones, and at most CAP_BYTES of them: a tab two
 * deploys behind is told to reload (src/app/state/update.ts).
 *
 * Keeping files must never stop a deploy: a file that fails, stalls or would pass the cap is skipped, the copy stops
 * at a deadline, and the command always exits 0 with whatever it kept.
 *
 *   node scripts/keep-previous-assets.ts https://theoi.github.io/mv-studio/ dist
 */
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CAP_BYTES = 150_000_000
/** Longest wait for one request, headers and body. */
const REQUEST_MS = 15_000
/** Longest the whole copy may take; the files kept by then are deployed. */
const DEADLINE_MS = 120_000

export interface KeptAssets {
  kept: string[]
  skipped: string[]
  bytes: number
}

export interface KeepOptions {
  fetch?: typeof fetch
  capBytes?: number
  requestMs?: number
  deadlineMs?: number
  log?: (line: string) => void
}

/** A path from a version.json that stays inside assets/. */
function isAssetPath(file: unknown): file is string {
  return typeof file === 'string' && /^assets\/[\w.-]+$/.test(file) && !file.includes('..')
}

export async function keepPreviousAssets(
  site: string,
  outDir: string,
  options: KeepOptions = {},
): Promise<KeptAssets> {
  const get = options.fetch ?? fetch
  const cap = options.capBytes ?? CAP_BYTES
  const log = options.log ?? console.log
  const deadline = AbortSignal.timeout(options.deadlineMs ?? DEADLINE_MS)
  const signal = () => AbortSignal.any([deadline, AbortSignal.timeout(options.requestMs ?? REQUEST_MS)])
  const result: KeptAssets = { kept: [], skipped: [], bytes: 0 }
  const base = site.endsWith('/') ? site : `${site}/`
  let live: unknown
  try {
    const response = await get(`${base}version.json`, { cache: 'no-store', signal: signal() })
    if (!response.ok) {
      log(`No version.json on the live site (${response.status}); nothing to keep.`)
      return result
    }
    live = await response.json()
  } catch (error) {
    log(`Could not read the live site's version.json (${String(error)}); nothing to keep.`)
    return result
  }
  const assets = (live as { assets?: unknown } | null)?.assets
  const files = Array.isArray(assets) ? assets.filter(isAssetPath) : []
  for (const [i, file] of files.entries()) {
    if (deadline.aborted) {
      result.skipped.push(...files.slice(i).filter((f) => !existsSync(path.join(outDir, f))))
      log(`Out of time after ${result.kept.length} files.`)
      break
    }
    const target = path.join(outDir, file)
    if (existsSync(target)) continue
    // Written under another name first, so a copy cut off midway leaves no truncated file under the real one.
    const partial = `${target}.partial`
    try {
      const response = await get(`${base}${file}`, { signal: signal() })
      const length = Number(response.headers.get('content-length'))
      if (!response.ok || result.bytes + (length || 0) > cap) {
        await response.body?.cancel()
        result.skipped.push(file)
        continue
      }
      const body = new Uint8Array(await response.arrayBuffer())
      if (result.bytes + body.byteLength > cap) {
        result.skipped.push(file)
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(partial, body)
      await rename(partial, target)
      result.kept.push(file)
      result.bytes += body.byteLength
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      log(`Skipped ${file}: ${String(error)}`)
      result.skipped.push(file)
    }
  }
  log(
    `Kept ${result.kept.length} files of the live build (${(result.bytes / 1e6).toFixed(1)} MB)` +
      (result.skipped.length ? `; skipped ${result.skipped.length}: ${result.skipped.join(', ')}` : ''),
  )
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [site, outDir] = process.argv.slice(2)
  if (!site || !outDir) {
    console.error('Usage: node scripts/keep-previous-assets.ts <live site URL> <build dir>')
  } else {
    try {
      await keepPreviousAssets(site, outDir)
    } catch (error) {
      console.error(`Kept no files of the live build: ${String(error)}`)
    }
  }
}
