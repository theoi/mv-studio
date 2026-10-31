import { describe, expect, it } from 'vitest'
import {
  createProject,
  createTextClip,
  createTrack,
  createVideoClip,
  type Project,
} from '../../../src/model/index.ts'
import { dropShift, refusalToast, refuseTrack, type MovingSpan } from '../../../src/app/state/clipDrag.ts'

const at = (start: number, end: number, others: [number, number][] = []): MovingSpan => ({
  start,
  end,
  others: others.map(([s, e]) => ({ start: s, end: e })),
})

describe('dropShift', () => {
  // A 2 s clip at 10 s, with neighbors on 5..8 and 14..20 on the track it drops on.
  const clip = at(10, 12, [
    [5, 8],
    [14, 20],
  ])

  it('takes the snapped shift when it fits, else the pointer’s', () => {
    expect(dropShift([clip], 1.5, 1.4, 0.1, -10, 100)).toEqual({ shift: 1.5, edge: null })
    // Snapped onto the neighbor, while the pointer's own place is free.
    expect(dropShift([clip], 3, 1.9, 0.1, -10, 100)).toEqual({ shift: 1.9, edge: null })
  })

  it('butts up against a neighbor it overlaps by less than the tolerance', () => {
    expect(dropShift([clip], 2.08, 2.08, 0.1, -10, 100)).toEqual({ shift: 2, edge: 14 })
    expect(dropShift([clip], -2.05, -2.05, 0.1, -10, 100)).toEqual({ shift: -2, edge: 8 })
  })

  it('has no room when the nearest free place is farther than the tolerance', () => {
    expect(dropShift([clip], 2.5, 2.5, 0.1, -10, 100)).toBeNull()
    // Past the neighbor, onto free space beyond it.
    expect(dropShift([clip], 10, 10, 0.1, -10, 100)).toEqual({ shift: 10, edge: null })
  })

  it('moves a group only where every clip fits, butting up the one that would overlap', () => {
    const other = at(30, 31, [[31.5, 40]])
    expect(dropShift([clip, other], 0.55, 0.55, 0.1, -10, 100)).toEqual({ shift: 0.5, edge: 31.5 })
    expect(dropShift([clip, other], 1, 1, 0.1, -10, 100)).toBeNull()
  })

  it('stays within the timeline', () => {
    expect(dropShift([at(1, 2)], -3, -3, 0.1, -1, 100)).toEqual({ shift: -1, edge: null })
  })
})

describe('refuseTrack', () => {
  function scene(): Project {
    const p = createProject({ name: 'drag' })
    const lyrics = createTrack('visual', 'Lyrics')
    const locked = { ...createTrack('visual', 'Overlay'), locked: true }
    p.tracks = [lyrics, locked, ...p.tracks]
    return p
  }

  it('refuses a locked track, the other kind of track and the Lyrics track, naming them in the toast', () => {
    const p = scene()
    const [lyrics, locked, video, audio] = p.tracks as [
      Project['tracks'][0],
      Project['tracks'][0],
      Project['tracks'][0],
      Project['tracks'][0],
    ]
    const clip = createVideoClip({ trackId: video.id, assetId: 'a', start: 0, duration: 2 })
    const title = createTextClip({ trackId: video.id, text: 'Hi', start: 0, duration: 2 })

    expect(refuseTrack(p, clip, video)).toBeNull()
    expect(refuseTrack(p, clip, locked)).toEqual({ reason: 'locked', track: locked })
    expect(refusalToast(p, refuseTrack(p, clip, locked)!)).toBe(
      'That track is locked. Unlock it to drop clips there.',
    )
    expect(refusalToast(p, refuseTrack(p, clip, lyrics)!)).toBe("Video clips can't go on the Lyrics track.")
    expect(refusalToast(p, refuseTrack(p, title, lyrics)!)).toBe("Text clips can't go on the Lyrics track.")
    expect(refusalToast(p, refuseTrack(p, clip, audio)!)).toBe(
      `Video clips can't go on the ${audio.name} track.`,
    )
    expect(refusalToast(p, { reason: 'room' })).toBe(
      'No room there. Drop it on an empty stretch or another track.',
    )
  })
})
