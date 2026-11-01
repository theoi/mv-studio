import { beforeAll, expect, it, vi } from 'vitest'
import { createProject } from '../../../src/model/index.ts'
import { editor } from '../../../src/app/state/project.ts'
import { shuttle, shuttleSpeed } from '../../../src/app/state/shuttle.ts'
import { get, set } from '../../../src/app/state/ui.ts'

const frames: FrameRequestCallback[] = []

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

it('a shuttle forward stops on the last frame, where End goes', () => {
  const p = createProject({ name: 'song', fps: 30 })
  p.duration = 20
  p.songAssetId = 'song'
  editor.load(p)
  set({ screen: 'editor', playhead: 19.9, playing: true })
  // L while playing shuttles forward at 2×.
  shuttle(1)
  expect(shuttleSpeed()).toBe(2)
  // A frame a second later moves 0.1 s of song at most: 0.2 s of shuttle, past the end.
  frames.shift()?.(performance.now() + 1000)
  expect(get().playhead).toBeCloseTo(19.99, 9)
  expect(shuttleSpeed()).toBe(0)
  expect(frames).toHaveLength(0)
})
