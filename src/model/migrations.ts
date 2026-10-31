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
const MIGRATIONS: Record<number, Migration> = {}

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
    if (!(key in data)) throw new ProjectLoadError(`Project is missing "${key}"`)
  }
  if (!Array.isArray(data.tracks) || !Array.isArray(data.markers))
    throw new ProjectLoadError('Malformed project')
  return data as unknown as Project
}
