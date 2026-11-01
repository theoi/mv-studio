/**
 * Whether a newer build of the studio has been deployed than the one this tab runs. A deploy replaces the build's
 * files, whose names carry content hashes, so a tab left open can no longer load a worker or a screen it has not loaded
 * yet: it can only reload. Each build writes version.json next to index.html (vite.config.ts).
 */

/** This build's id, set at build time (vite.config.ts). */
declare const __BUILD_ID__: string

const VERSION_URL = `${import.meta.env.BASE_URL}version.json`

/** The id of the deployed build, or null when it can't be read (offline, or a dev server, which has no version.json). */
export async function deployedBuild(): Promise<string | null> {
  try {
    const response = await fetch(VERSION_URL, { cache: 'no-store' })
    if (!response.ok) return null
    const version: unknown = await response.json()
    const build = (version as { build?: unknown } | null)?.build
    return typeof build === 'string' ? build : null
  } catch {
    return null
  }
}

/** Whether the deployed build is another one than this tab's. */
export async function newerBuildDeployed(): Promise<boolean> {
  const build = await deployedBuild()
  return build !== null && build !== __BUILD_ID__
}

/**
 * Whether an error says code failed to load, in the words of Chrome ("Failed to fetch dynamically imported module"),
 * Safari ("Importing a module script failed"), Firefox ("error loading dynamically imported module") or Vite's preload
 * helper ("Unable to preload CSS").
 */
export function isLoadFailure(message: string): boolean {
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|unable to preload css/i.test(
    message,
  )
}
