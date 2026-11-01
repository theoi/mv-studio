/** Loading and migrating saved projects. Every schema bump adds a step here. */
import { PROJECT_SCHEMA_VERSION, type Project } from './types.ts'

export class ProjectLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectLoadError'
  }
}

type Migration = (project: Record<string, unknown>) => Record<string, unknown>

/** MIGRATIONS[n] upgrades schema version n to n + 1. */
const MIGRATIONS: Record<number, Migration> = {
  // Version 2 stores downbeats only once bars are found. Version 1 also stored the fast analysis's guesses, which are
  // mostly a beat or two off. Downbeats a refinement set (tempo confidence 0.95, which the fast analysis never gives)
  // or the user set (confidence 1) stay; the rest are dropped, and the app finds those songs' bars again.
  1: (project) => {
    const audio = (project.analysis as { audio?: Record<string, Record<string, unknown>> } | undefined)?.audio
    if (!audio) return project
    for (const [id, analysis] of Object.entries(audio)) {
      const confidence = (analysis.tempo as { confidence?: number } | undefined)?.confidence
      if (!('downbeats' in analysis) || confidence === 1 || confidence === 0.95) continue
      const { downbeats: _guessed, ...rest } = analysis
      audio[id] = rest
    }
    return project
  },
}

/** Validates the basic shape and upgrades older schema versions. Throws ProjectLoadError for unusable data. */
export function parseProject(input: unknown): Project {
  if (typeof input !== 'object' || input === null) throw new ProjectLoadError('Not a project file')
  let data = input as Record<string, unknown>
  let version = data.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new ProjectLoadError('Missing or invalid schema version')
  if (version > PROJECT_SCHEMA_VERSION)
    throw new ProjectLoadError(
      'This project was saved by a newer version of MV Studio. Reload the page to update.',
    )
  while (version < PROJECT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version]
    if (!migrate) throw new ProjectLoadError(`No migration from schema version ${version}`)
    data = migrate(data)
    version += 1
    data.schemaVersion = version
  }
  for (const key of ['id', 'name', 'settings', 'assets', 'tracks', 'clips', 'markers', 'analysis'] as const) {
    if (!(key in data)) throw new ProjectLoadError(`Project is missing “${key}”`)
  }
  if (!Array.isArray(data.tracks) || !Array.isArray(data.markers))
    throw new ProjectLoadError('Malformed project')
  return data as unknown as Project
}
