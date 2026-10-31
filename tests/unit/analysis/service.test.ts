import { afterEach, describe, expect, it } from 'vitest'
import { SongAnalysisService } from '../../../src/analysis/client.ts'
import { JobRunner } from '../../../src/shared/jobs.ts'
import { closeFakeWorkers, FakeWorker } from '../shared/fakeWorker.ts'

afterEach(() => closeFakeWorkers())

describe('SongAnalysisService', () => {
  it('replaces an analysis worker that crashed, so the next analysis runs', async () => {
    const workers: FakeWorker[] = []
    const service = new SongAnalysisService({
      runner: new JobRunner(),
      createWorker: () => {
        const first = workers.length === 0
        const worker = new FakeWorker({
          analyzeFast: (args: { assetId: string }) =>
            first ? new Promise<never>(() => undefined) : { assetId: args.assetId },
        })
        workers.push(worker)
        return worker.asWorker()
      },
    })
    const audio = () => ({ sampleRate: 44_100, channels: [new Float32Array(16)] })
    const crashed = service.analyze('song', audio())
    await expect.poll(() => workers.length).toBe(1)
    workers[0]?.crash('Uncaught RangeError: Array buffer allocation failed')
    await expect(crashed.promise).rejects.toMatchObject({ code: 'out-of-memory' })
    await expect(service.analyze('song', audio()).promise).resolves.toEqual({ assetId: 'song' })
    expect(workers).toHaveLength(2)
    service.dispose()
  })
})
