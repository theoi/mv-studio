import { beforeAll, describe, expect, it, vi } from 'vitest'
import { playTilePreview } from '../../../src/app/state/tilePreview.ts'

interface FakeController {
  dispose: ReturnType<typeof vi.fn>
}
const controllers: FakeController[] = []

vi.mock('../../../src/engine/preview.ts', () => ({
  PreviewController: vi.fn(function PreviewController() {
    const controller = {
      setViewport: vi.fn(),
      seek: vi.fn(),
      setProject: vi.fn(),
      dispose: vi.fn(),
      rendered: () => Promise.reject(new Error('The render worker stopped')),
    }
    controllers.push(controller)
    return controller
  }),
}))

interface FakeNode {
  dataset: Record<string, string>
  parentElement: unknown
  remove(): void
}

const node = (): FakeNode => {
  const el: FakeNode = {
    dataset: {},
    parentElement: null,
    remove: () => {
      el.parentElement = null
    },
  }
  return el
}

beforeAll(() => {
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('document', { createElement: node })
})

describe('tile previews', () => {
  it('drops a preview whose render worker died, so the next hover starts a fresh one', async () => {
    const shown: FakeNode[] = []
    const host = {
      appendChild: (child: FakeNode) => {
        child.parentElement = host
        shown.push(child)
      },
    } as unknown as HTMLElement
    playTilePreview({ kind: 'look', id: 'warm' }, host)
    expect(controllers).toHaveLength(1)
    await vi.waitFor(() => expect(controllers[0]!.dispose).toHaveBeenCalledOnce())
    // The tile shows its still thumbnail again.
    expect(shown[0]!.parentElement).toBeNull()
    playTilePreview({ kind: 'look', id: 'warm' }, host)
    expect(controllers).toHaveLength(2)
  })
})
