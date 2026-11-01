import { beforeEach, describe, expect, it } from 'vitest'
import { createProject, type Project } from '../../../src/model/index.ts'
import { scrubTime, stepPlayhead } from '../../../src/app/state/playback.ts'
import { editor } from '../../../src/app/state/project.ts'
import { get, set } from '../../../src/app/state/ui.ts'

/** A 20 s song at 30 fps (and the default 120 BPM): its last frame is at 19.99 s, where End goes. */
function song(): Project {
  const p = createProject({ name: 'song', fps: 30 })
  p.duration = 20
  p.songAssetId = 'song'
  return p
}

beforeEach(() => editor.load(song()))

describe('moving the playhead forward stops on the last frame', () => {
  it('a frame or a beat forward from the last frame stays there', () => {
    set({ playhead: 19.99 })
    stepPlayhead(1, false)
    expect(get().playhead).toBeCloseTo(19.99, 9)
    stepPlayhead(1, true)
    expect(get().playhead).toBeCloseTo(19.99, 9)
    stepPlayhead(-1, false)
    expect(get().playhead).toBeCloseTo(19.99 - 1 / 30, 9)
  })

  it('a scrub past the end lands on the last frame, and an empty project’s ruler goes to its own end', () => {
    expect(scrubTime(editor.getProject(), 25, 90)).toBeCloseTo(19.99, 9)
    expect(scrubTime(editor.getProject(), 12, 90)).toBe(12)
    expect(scrubTime(editor.getProject(), -3, 90)).toBe(0)
    expect(scrubTime(createProject({ name: 'empty' }), 50, 90)).toBe(50)
    expect(scrubTime(createProject({ name: 'empty' }), 120, 90)).toBe(90)
  })
})
