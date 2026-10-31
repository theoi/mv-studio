import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTextClip, type Project, type VisualClip } from '../../../src/model/index.ts'
import {
  canDrag,
  knobOf,
  moved,
  resizeCursor,
  rotated,
  scaled,
  startDrag,
  transformCommands,
  turn,
  type Point,
} from '../../../src/app/screens/editor/handles.ts'
import { loopRange } from '../../../src/app/state/previewControls.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'

const start = { x: 0.5, y: 0.5, scaleX: 1, scaleY: 1, rotation: 0 }
const frame = { width: 800, height: 450 }
const canvas = { width: 1920, height: 1080 }

describe('handle drags', () => {
  it('moves by the pointer distance on the frame, in whole project pixels', () => {
    const v = moved(start, [100, 100], [140, 110.3], frame, canvas, false)
    expect((v.x! - 0.5) * 1920).toBeCloseTo(96, 6)
    expect((v.y! - 0.5) * 1080).toBeCloseTo(25, 6)
    // Shift keeps the move on the axis the pointer went furthest along.
    const locked = moved(start, [100, 100], [140, 110], frame, canvas, true)
    expect(locked.y).toBe(0.5)
    expect((locked.x! - 0.5) * 1920).toBeCloseTo(96, 6)
  })

  it('scales both axes by the change in distance from the anchor, down to 1%', () => {
    const pivot: Point = [400, 225]
    expect(scaled(start, [600, 225], [700, 225], pivot)).toEqual({ scaleX: 1.5, scaleY: 1.5 })
    expect(scaled({ ...start, scaleX: 2 }, [600, 225], [500, 225], pivot)).toEqual({ scaleX: 1, scaleY: 0.5 })
    expect(scaled(start, [600, 225], pivot, pivot)).toEqual({ scaleX: 0.01, scaleY: 0.01 })
    // A press on the anchor itself has no distance to scale by.
    expect(scaled(start, pivot, [700, 225], pivot)).toEqual({})
  })

  it('turns the short way round past ±180°, and Shift snaps to 15°', () => {
    expect(turn(170, -170)).toBe(20)
    expect(turn(-170, 170)).toBe(-20)
    expect(rotated(0, 22, true)).toBe(15)
    expect(rotated(10, 0.04, false)).toBe(10)
    expect(rotated(-5, -400, false)).toBe(-405)
  })

  it('puts the rotate knob beyond the top edge, whichever way the clip is turned', () => {
    const upright: Point[] = [
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ]
    expect(knobOf(upright)).toEqual({ topMid: [50, 0], knob: [50, -22] })
    const upsideDown = [upright[2]!, upright[3]!, upright[0]!, upright[1]!]
    expect(knobOf(upsideDown).knob).toEqual([50, 72])
  })

  it('points the resize cursor from the anchor to the corner', () => {
    expect(resizeCursor([10, 10], [0, 0])).toBe('nwse-resize')
    expect(resizeCursor([10, -10], [0, 0])).toBe('nesw-resize')
    expect(resizeCursor([10, 0.5], [0, 0])).toBe('ew-resize')
    expect(resizeCursor([0.5, -10], [0, 0])).toBe('ns-resize')
  })
})

describe('what a drag writes', () => {
  const clip = (): VisualClip => createTextClip({ trackId: 't', text: 'Hi', start: 0, duration: 4 })

  it('sets the value of a property without keyframes, like the Inspector field', () => {
    const c = clip()
    expect(transformCommands(c, { x: 0.6, rotation: 12 }, 1)).toEqual([
      { type: 'clip.set', clipId: c.id, path: ['transform', 'x', 'value'], value: 0.6 },
      { type: 'clip.set', clipId: c.id, path: ['transform', 'rotation', 'value'], value: 12 },
    ])
  })

  it('sets the keyframe at the playhead on a keyframed property, keeping its easing', () => {
    const c = clip()
    c.transform.x.keyframes = [
      { time: 0, value: 0.2, easing: 'linear' },
      { time: 2, value: 0.8, easing: 'hold' },
    ]
    expect(transformCommands(c, { x: 0.5 }, 2)).toEqual([
      {
        type: 'keyframe.set',
        clipId: c.id,
        path: ['transform', 'x'],
        keyframe: { time: 2, value: 0.5, easing: 'hold' },
      },
    ])
    expect(transformCommands(c, { x: 0.5 }, 1)[0]).toMatchObject({
      type: 'keyframe.set',
      keyframe: { time: 1, value: 0.5, easing: 'ease-in-out' },
    })
  })
})

describe('dragging a clip of the sample project', () => {
  let frames: FrameRequestCallback[] = []
  const flush = () => {
    const due = frames
    frames = []
    for (const f of due) f(0)
  }
  beforeEach(() => {
    loadDemoProject()
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const project = (): Project => editor.getProject()

  it('gives handles only to clips with Inspector › Transform on unlocked tracks', () => {
    const p = project()
    expect(canDrag(p, p.clips['o-title'])).toBe(true)
    expect(canDrag(p, p.clips['o-spec1'])).toBe(false)
    const title = p.clips['o-title']!
    const locked = {
      ...p,
      tracks: p.tracks.map((t) => (t.id === title.trackId ? { ...t, locked: true } : t)),
    }
    expect(canDrag(locked, title)).toBe(false)
  })

  it('shows each frame at once, writes the project every 100 ms and on release, as one undo step', () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const shown: (Project | null)[] = []
    const before = project().clips['o-title'] as VisualClip
    const x = (p: Project) => (p.clips['o-title'] as VisualClip).transform.x.value
    const drag = startDrag('move', before, 2, [100, 100], frame, (p) => shown.push(p))
    drag.update([110, 100], false)
    drag.update([120, 100], false)
    expect(frames).toHaveLength(1)
    flush()
    // The preview has the move; the project does not yet.
    expect(shown).toHaveLength(1)
    expect(x(shown[0]!)).toBeGreaterThan(before.transform.x.value)
    expect(x(project())).toBe(before.transform.x.value)
    now += 100
    drag.update([140, 100], false)
    flush()
    // A frame that writes shows the written project itself, so the preview draws once.
    expect(shown[1]).toBe(project())
    expect(x(project())).toBeGreaterThan(x(shown[0]!))
    drag.update([180, 140], false)
    drag.end()
    expect(shown.at(-1)).toBeNull()
    const after = project().clips['o-title'] as VisualClip
    expect((after.transform.x.value - 0.5) * project().settings.width).toBeCloseTo(
      (80 / frame.width) * project().settings.width,
      0,
    )
    expect(after.transform.y.value).toBeGreaterThan(before.transform.y.value)
    expect(editor.undoLabel()).toBe('Move clip')
    editor.undo()
    const undone = project().clips['o-title'] as VisualClip
    expect(undone.transform.x.value).toBe(before.transform.x.value)
    expect(undone.transform.y.value).toBe(before.transform.y.value)
  })

  it('changes nothing for a click', () => {
    const before = project()
    const shown: (Project | null)[] = []
    const drag = startDrag('move', before.clips['o-title'] as VisualClip, 2, [100, 100], frame, (p) =>
      shown.push(p),
    )
    drag.update([101, 100], false)
    drag.end()
    expect(project()).toBe(before)
    expect(shown).toEqual([])
  })
})
describe('loop range', () => {
  beforeEach(() => loadDemoProject())

  it('is the section under the playhead, or the whole video without sections', () => {
    expect(loopRange(editor.getProject(), 70)).toEqual({ start: 64, end: 96, label: 'Chorus' })
    const p = editor.getProject()
    const bare = { ...p, analysis: { ...p.analysis, audio: {} } }
    const whole = loopRange(bare, 70)
    expect(whole.start).toBe(0)
    expect(whole.label).toBeUndefined()
    expect(whole.end).toBeGreaterThan(200)
  })
})
