import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  activeTilePreview,
  playTilePreview,
  previewHandlers,
  type PreviewItem,
} from '../../../src/app/state/tilePreview.ts'

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

describe('which tile previews', () => {
  afterEach(() => vi.useRealTimers())

  const focusEvent = { currentTarget: { matches: () => true } } as never
  const pointerAt = (clientX: number) => ({ clientX, clientY: 200 }) as never

  it('keeps the focused tile’s preview while the list scrolls under a resting pointer', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const focused: PreviewItem = { kind: 'plugin', id: 'whip-pan' }
    const left: PreviewItem = { kind: 'plugin', id: 'fade' }
    const under: PreviewItem = { kind: 'plugin', id: 'glitch-cut' }
    previewHandlers(left).onPointerMove(pointerAt(100))
    vi.advanceTimersByTime(500)
    expect(activeTilePreview()).toBe('plugin:fade')
    previewHandlers(focused).onFocus(focusEvent)
    // Scrolling moves tiles under the resting pointer: it leaves one and gets a move on another, at the same spot.
    previewHandlers(left).onPointerLeave()
    previewHandlers(under).onPointerMove(pointerAt(100))
    vi.advanceTimersByTime(500)
    expect(activeTilePreview()).toBe('plugin:whip-pan')

    // A real move hands the preview to the tile under the pointer.
    previewHandlers(under).onPointerMove(pointerAt(103))
    vi.advanceTimersByTime(500)
    expect(activeTilePreview()).toBe('plugin:glitch-cut')
    previewHandlers(under).onPointerLeave()
    expect(activeTilePreview()).toBeNull()
  })
})
