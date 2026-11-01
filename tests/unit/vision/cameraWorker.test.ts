import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createImageClip, createProject } from '../../../src/model/factory.ts'
import type { Asset } from '../../../src/model/types.ts'
import type { PredictionRequest } from '../../../src/vision/cameraPrediction.ts'
import { addCameraMoves, safeCameraAmounts } from '../../../src/vision/cameraMove.ts'
import type * as Prepare from '../../../src/vision/depth/prepare.ts'
import type * as Bend from '../../../src/vision/render/bend.ts'
import type * as Smear from '../../../src/vision/render/smear.ts'
import type * as Canvas from '../../../src/vision/runtime/canvas.ts'
import { VISION_MODELS } from '../../../src/vision/runtime/models.ts'
import { closeFakeWorkers, FakeWorker } from '../shared/fakeWorker.ts'

// The prediction's preparation and measures throw on this thread: on the page's thread they would hold it for 50 to
// 300 ms a still.
vi.mock('../../../src/vision/render/bend.ts', async (importOriginal) => {
  const onPage = () => {
    throw new Error('measured on the page’s thread')
  }
  return { ...(await importOriginal<typeof Bend>()), straightLines: onPage, bendAt: onPage, bendOf: onPage }
})
vi.mock('../../../src/vision/render/smear.ts', async (importOriginal) => {
  const onPage = () => {
    throw new Error('measured on the page’s thread')
  }
  return {
    ...(await importOriginal<typeof Smear>()),
    localContrast: onPage,
    smearOf: onPage,
    safeAmounts: onPage,
    safeBend: onPage,
  }
})
vi.mock('../../../src/vision/depth/prepare.ts', async (importOriginal) => {
  const onPage = () => {
    throw new Error('prepared on the page’s thread')
  }
  return {
    ...(await importOriginal<typeof Prepare>()),
    prepareDepthForParallax: onPage,
    suggestFocus: onPage,
  }
})
vi.mock('../../../src/vision/runtime/canvas.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Canvas>()),
  toRgba: (_: unknown, size: { width: number; height: number }) => ({
    ...size,
    data: new Uint8ClampedArray(size.width * size.height * 4).fill(128),
  }),
}))

const requests: PredictionRequest[] = []
const prediction = {
  focus: 0.4,
  safe: { smear: 0.35, bend: 0.2 },
  alwaysBends: false,
  cleanAlternatives: ['pan-right'],
}

beforeAll(() => {
  vi.stubGlobal(
    'Worker',
    class extends FakeWorker {
      constructor() {
        super({
          ready: () => true,
          predict: (request: PredictionRequest) => {
            requests.push(request)
            const { source } = request
            return 'estimate' in source ? { ...prediction, prepared: source.estimate } : prediction
          },
        })
      }
    },
  )
  vi.stubGlobal('createImageBitmap', async () => ({ width: 960, height: 540, close: () => undefined }))
  vi.stubGlobal('ImageData', class {})
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { putImageData: () => undefined, drawImage: () => undefined }
      }
      async convertToBlob() {
        return new Blob(['depth'], { type: 'image/png' })
      }
    },
  )
})

afterAll(() => {
  vi.unstubAllGlobals()
  closeFakeWorkers()
})

function asset(id: string, origin: Asset['origin']): Asset {
  return {
    id,
    kind: 'image',
    name: `${id}.png`,
    mimeType: 'image/png',
    byteSize: 10,
    storageKey: id,
    origin,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('the camera-move prediction', () => {
  it('runs in the camera worker, for a fresh depth estimate, a stored depth image and a later strength check', async () => {
    const project = createProject({ name: 'stills' })
    project.assets.still = asset('still', { type: 'import' })
    const track = project.tracks.find((t) => t.kind === 'visual')!
    const clip = createImageClip({ trackId: track.id, assetId: 'still', start: 0, duration: 5 })
    project.clips[clip.id] = clip
    const editor = new ProjectEditor(project)
    const depth = {
      get: async (req: { sourceSize: { width: number; height: number } }) => ({
        version: 1 as const,
        width: 16,
        height: 9,
        data: new Uint8Array(16 * 9).map((_, i) => (i % 16) * 16),
        sourceSize: req.sourceSize,
        model: VISION_MODELS.depthAnythingSmall.id,
        quality: 'full' as const,
      }),
      peek: async () => null,
    }
    const stored: Blob[] = []
    const media = {
      getFile: async (a: Asset) => new Blob([a.id], { type: 'image/png' }),
      storeBlob: async (blob: Blob, info: { origin: Asset['origin'] }) => {
        stored.push(blob)
        return asset('depth', info.origin)
      },
    }
    const alternatives = ['dolly-in', 'orbit-right', 'pan-right'] as const

    const added = await addCameraMoves({ editor, media, depth }, [clip.id], {
      preset: 'dolly-in',
      alternatives,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      preset: 'dolly-in',
      alternatives: { presets: alternatives, floor: 0.25 },
    })
    expect(requests[0]!.source).toMatchObject({
      estimate: { width: 16, height: 9 },
      gray: { width: 16, height: 9 },
    })
    // The depth the worker prepared is the one stored.
    expect(stored).toHaveLength(1)
    expect(added.moves[0]).toMatchObject({
      intensity: 0.25,
      safe: prediction.safe,
      safeIntensity: 0.2,
      bendRisk: true,
      alwaysBends: false,
      cleanAlternatives: ['pan-right'],
    })
    const effect = editor.getProject().clips[clip.id]!
    expect('effects' in effect && effect.effects[0]!.params.focus!.value).toBe(0.4)

    await addCameraMoves({ editor, media, depth }, [clip.id], { preset: 'pan-right' })
    expect(requests[1]).toMatchObject({ preset: 'pan-right', source: { key: 'depth' } })
    expect(requests[1]).not.toHaveProperty('alternatives')

    expect(await safeCameraAmounts(media, editor.getProject(), clip.id, 'orbit-right')).toEqual(
      prediction.safe,
    )
    expect(requests[2]).toMatchObject({ preset: 'orbit-right', focus: 0.4, source: { key: 'depth' } })
    const source = requests[2]!.source
    expect('key' in source && (await source.depthImage.text())).toBe('depth')
    expect('key' in source && (await source.still.text())).toBe('still')
  })
})
