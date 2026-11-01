/**
 * Whether a newer build of the studio has been deployed than the one this tab runs. A deploy replaces the build's
 * files, whose names carry content hashes, so a tab left open can no longer load a worker or a screen it has not loaded
 * yet: it can only reload. Each build writes version.json next to index.html (vite.config.ts).
 */

const VERSION_URL = `${import.meta.env.BASE_URL}version.json`

export interface DeployedBuild {
  build: string
  /** When it was built, in ms since 1970. */
  time: number
}

/**
 * The deployed build, or null when it can't be read (offline, or a dev server, which has no version.json).
 */
export async function deployedBuild(): Promise<DeployedBuild | null> {
  try {
    const response = await fetch(VERSION_URL, { cache: 'no-store' })
    if (!response.ok) return null
    const version = (await response.json()) as Partial<Record<keyof DeployedBuild, unknown>> | null
    const { build, time } = version ?? {}
    return typeof build === 'string' && typeof time === 'number' ? { build, time } : null
  } catch {
    return null
  }
}

/**
 * Whether the deployed build is newer than this tab's. Not just another one: a cache that still serves the previous
 * version.json to a tab already on the new build must not tell it to reload.
 */
export async function newerBuildDeployed(): Promise<boolean> {
  const deployed = await deployedBuild()
  return deployed !== null && deployed.build !== __BUILD_ID__ && deployed.time > __BUILD_TIME__
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
