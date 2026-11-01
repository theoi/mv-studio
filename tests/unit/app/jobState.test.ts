import { expect, it } from 'vitest'
import type { JobProgress, JobSnapshot } from '../../../src/shared/jobs.ts'
import { jobLine, pct } from '../../../src/app/screens/editor/assist/jobState.ts'

const job = (progress: JobProgress): JobSnapshot => ({
  id: 'j1',
  kind: 'analysis.stems',
  title: 'Separating stems',
  status: 'running',
  progress,
})

it('puts how far a model download is in the job’s line, and keeps the job’s own percentage for its bar', () => {
  const downloading = job({
    stage: 'download',
    fraction: 0.13,
    message: 'Downloading the stem separator (181 MB, once)',
    bytesLoaded: 161_000_000,
    bytesTotal: 181_000_000,
  })
  expect(jobLine(downloading)).toBe('Downloading the stem separator (181 MB, once)… 89%')
  expect(pct(downloading)).toBe(13)
  expect(jobLine(job({ stage: 'separate', fraction: 0.5, message: 'Separating stems' }))).toBe(
    'Separating stems',
  )
  // A download line without its bytes has nothing to add.
  expect(jobLine(job({ stage: 'download', fraction: 0.2, message: 'Downloading the model' }))).toBe(
    'Downloading the model',
  )
})
