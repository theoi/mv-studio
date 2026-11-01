import { describe, expect, it } from 'vitest'
import { rowStates } from '../../../src/app/screens/export/outputs.ts'
import type { ExportRow } from '../../../src/app/state/exports.ts'
import type { JobSnapshot } from '../../../src/shared/jobs.ts'

const rows = (seconds: (number | undefined)[]): ExportRow[] =>
  seconds.map((s, i) => ({ id: `r${i}`, title: `File ${i}`, aspect: '16:9', frames: 300, seconds: s }))

const running = (fraction: number, etaSeconds?: number): JobSnapshot => ({
  id: 'job',
  kind: 'export.outputs',
  title: 'Exporting 2 videos',
  status: 'running',
  progress: { fraction, etaSeconds },
})

describe('the rows of a running export', () => {
  it('give the file rendering what is left once the files after it have their estimates', () => {
    // 400 s left: the second file is estimated at 120 s, so the first has 280 s.
    const states = rowStates(running(0.25, 400), rows([600, 120]), {})
    expect(states.map((s) => s.status)).toEqual(['50% · about 5 min left', 'Waiting'])
  })

  it('show only the percentage while a file after the one rendering has no estimate', () => {
    expect(rowStates(running(0.25, 400), rows([600, undefined]), {})[0]?.status).toBe('50%')
    expect(rowStates(running(0.75, 40), rows([600, undefined]), {})[1]?.status).toBe(
      '50% · less than a minute left',
    )
  })
})
