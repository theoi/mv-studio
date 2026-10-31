import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JOB_KINDS, openJob } from '../../../src/app/state/jobs.ts'
import { get, set } from '../../../src/app/state/ui.ts'

const SRC = path.resolve('src')

/**
 * Job kinds started anywhere in src (outside the test harness): `kind: 'a.b'` in a `jobs.run` call or a
 * `*_JOB = 'a.b'` constant. A template kind (`cloud.generate.${task}`) gives its base.
 */
function kindsInSource(): string[] {
  const patterns = [
    /kind:\s*'([a-z]+\.[a-z.-]+)'/,
    /_JOB\s*=\s*'([a-z]+\.[a-z.-]+)'/,
    /kind:\s*`([a-z]+\.[a-z.-]+)\.\$\{/,
  ]
  const found = new Set<string>()
  for (const file of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file) || file.startsWith(`testing${path.sep}`)) continue
    for (const line of readFileSync(path.join(SRC, file), 'utf8').split('\n')) {
      if (/^\s*(\*|\/\/)/.test(line)) continue
      for (const pattern of patterns) {
        const kind = pattern.exec(line)?.[1]
        if (kind) found.add(kind)
      }
    }
  }
  return [...found].sort()
}

describe('job kinds', () => {
  const started = kindsInSource()

  it('finds the jobs the services start', () => {
    expect(started).toEqual(expect.arrayContaining(['analysis.song', 'director.plan', 'vision.index']))
  })

  // JOB_TARGETS is typed over JOB_KINDS, so a kind listed there always says what it opens.
  it.each(started)('%s is listed in JOB_KINDS', (kind) => {
    expect(Object.values(JOB_KINDS)).toContain(kind)
  })
})

describe('opening a running job', () => {
  beforeEach(() => set({ dialog: null, libraryOpen: false, rightTab: 'inspector', assistView: 'home' }))

  it('opens the Assist view that follows it', () => {
    openJob(JOB_KINDS.realign)
    expect(get()).toMatchObject({ rightTab: 'assist', assistView: 'lyrics' })
    openJob(JOB_KINDS.downbeats)
    expect(get()).toMatchObject({ rightTab: 'assist', assistView: 'analysis' })
  })

  it('follows the base kind of a kind with a detail suffix', () => {
    openJob('cloud.generate.image')
    expect(get()).toMatchObject({ rightTab: 'assist', assistView: 'generate' })
  })

  it('opens the Assist home for a kind it does not know, not a dialog', () => {
    openJob('vision.something-new')
    expect(get()).toMatchObject({ rightTab: 'assist', assistView: 'home', dialog: null })
  })

  it('opens the export dialog for an export and the media library for imports and footage analysis', () => {
    openJob(JOB_KINDS.export)
    expect(get()).toMatchObject({ dialog: 'export', exportPhase: 'exporting', rightTab: 'inspector' })
    set({ dialog: null, libraryTab: 'effects' })
    openJob(JOB_KINDS.import)
    expect(get()).toMatchObject({ libraryOpen: true, libraryTab: 'media', dialog: null })
    set({ libraryOpen: false, libraryTab: 'effects' })
    openJob(JOB_KINDS.footage)
    expect(get()).toMatchObject({ libraryOpen: true, libraryTab: 'media' })
  })

  it('opens nothing for a project file being opened or saved', () => {
    openJob(JOB_KINDS.projectExport)
    openJob(JOB_KINDS.projectImport)
    expect(get()).toMatchObject({ dialog: null, libraryOpen: false, rightTab: 'inspector' })
  })
})
