/**
 * Keeps the files of the build that is live now in the build about to be deployed, so tabs still running the live
 * build can load the workers and screens they have not loaded yet. Each build lists its files in version.json
 * (vite.config.ts). Only the live build's files are added, not older ones, and at most CAP_BYTES of them: a tab two
 * deploys behind is told to reload (src/app/state/update.ts).
 *
 *   node scripts/keep-previous-assets.ts https://theoi.github.io/mv-studio/ dist
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CAP_BYTES = 150_000_000

export interface KeptAssets {
  kept: string[]
  skipped: string[]
  bytes: number
}

/** A path from a version.json that stays inside assets/. */
function isAssetPath(file: unknown): file is string {
  return typeof file === 'string' && /^assets\/[\w.-]+$/.test(file) && !file.includes('..')
}

export async function keepPreviousAssets(
  site: string,
  outDir: string,
  options: { fetch?: typeof fetch; capBytes?: number; log?: (line: string) => void } = {},
): Promise<KeptAssets> {
  const get = options.fetch ?? fetch
  const cap = options.capBytes ?? CAP_BYTES
  const log = options.log ?? console.log
  const result: KeptAssets = { kept: [], skipped: [], bytes: 0 }
  const base = site.endsWith('/') ? site : `${site}/`
  let live: unknown
  try {
    const response = await get(`${base}version.json`, { cache: 'no-store' })
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
  for (const file of Array.isArray(assets) ? assets.filter(isAssetPath) : []) {
    const target = path.join(outDir, file)
    if (existsSync(target)) continue
    const response = await get(`${base}${file}`).catch(() => null)
    if (!response?.ok) {
      result.skipped.push(file)
      continue
    }
    const body = new Uint8Array(await response.arrayBuffer())
    if (result.bytes + body.byteLength > cap) {
      result.skipped.push(file)
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
    result.kept.push(file)
    result.bytes += body.byteLength
  }
  log(
    `Kept ${result.kept.length} files of the live build (${(result.bytes / 1e6).toFixed(1)} MB)` +
      (result.skipped.length ? `; skipped ${result.skipped.length}: ${result.skipped.join(', ')}` : ''),
  )
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [site, outDir] = process.argv.slice(2)
  if (!site || !outDir) {
    console.error('Usage: node scripts/keep-previous-assets.ts <live site URL> <build dir>')
    process.exit(1)
  }
  await keepPreviousAssets(site, outDir)
}
