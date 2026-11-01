import { beforeEach, expect, it, vi } from 'vitest'
import type * as SharedModels from '../../../src/shared/models.ts'
import type { ModelDescriptor } from '../../../src/shared/models.ts'
import { formatBytes } from '../../../src/app/format.ts'
import { VISION_MODELS } from '../../../src/vision/runtime/models.ts'

const h = vi.hoisted(() => ({ cached: new Set<string>() }))

vi.mock('../../../src/shared/models.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModels>()),
  modelCache: { has: async (url: string) => h.cached.has(url) },
}))

const { personDownloadBytes } = await import('../../../src/app/state/behind.ts')

beforeEach(() => h.cached.clear())

it('says a first cutout downloads about 9 MB: the MediaPipe runtime as it arrives, compressed, and the models', async () => {
  expect(formatBytes(await personDownloadBytes())).toBe('9 MB')
})

it('leaves out the runtime and the models already cached, as after the people check', async () => {
  const file = (m: ModelDescriptor) => m.files.model!
  h.cached.add(file(VISION_MODELS.personDetector).url)
  h.cached.add(file(VISION_MODELS.selfieLandscape).url)
  expect(await personDownloadBytes()).toBe(
    file(VISION_MODELS.selfie).bytes! + file(VISION_MODELS.faceShortRange).bytes!,
  )
  expect(formatBytes(await personDownloadBytes())).toBe('under 1 MB')
})
