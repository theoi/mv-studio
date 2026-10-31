import { describe, expect, it } from 'vitest'
import {
  createAudioClip,
  createProject,
  createSolidClip,
  createTextClip,
  createTrack,
  createVideoClip,
  type Clip,
  type Project,
  type Track,
} from '../../../src/model/index.ts'
import {
  blockedAt,
  dropShift,
  insertPlan,
  refusalLabel,
  refusalToast,
  refuseTrack,
  type MovingSpan,
} from '../../../src/app/state/clipDrag.ts'

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

describe('insertPlan', () => {
  const on = (id: string, start: number, end: number) => ({ id, start, end })
  // A 2 s clip at 20 s, onto a track holding 0..4, 6..8 and 8..12.
  const clip = { start: 20, end: 22, others: [on('a', 0, 4), on('b', 6, 8), on('c', 8, 12)] }

  it('puts the clip in at the drop point and pushes the later clips on the track right by its length', () => {
    expect(insertPlan([clip], -14, -20)).toEqual({
      shift: -14,
      at: 6,
      pushes: [
        { id: 'b', start: 8 },
        { id: 'c', start: 10 },
      ],
    })
  })

  it('goes in before or after a clip it is dropped inside, whichever edge is nearer, without splitting it', () => {
    expect(insertPlan([clip], 8.5 - 20, -20)).toEqual({ shift: -12, at: 8, pushes: [{ id: 'c', start: 10 }] })
    expect(insertPlan([clip], 11 - 20, -20)).toEqual({ shift: -8, at: 12, pushes: [] })
  })

  it('pushes by a group’s whole span on each of its tracks, and has no room when a clip on another track straddles the point', () => {
    const top = { start: 20, end: 22, others: [on('x', 5, 7), on('y', 9, 10)] }
    const bottom = { start: 23, end: 24, others: [on('z', 4, 6), on('w', 12, 13)] }
    expect(insertPlan([top, bottom], -12, -20)).toEqual({
      shift: -12,
      at: 8,
      pushes: [
        { id: 'y', start: 13 },
        { id: 'w', start: 16 },
      ],
    })
    // Inside x on the grabbed clip's track, the drop goes in at 5, where z on the other track still straddles it.
    expect(insertPlan([top, bottom], 5.5 - 20, -20)).toBeNull()
  })

  it('stays within the timeline', () => {
    expect(insertPlan([{ start: 3, end: 5, others: [on('a', 0, 2)] }], -10, -3)).toEqual({
      shift: -3,
      at: 0,
      pushes: [{ id: 'a', start: 2 }],
    })
  })
})

describe('blockedAt', () => {
  it('names the clip of a group that has no room', () => {
    const free = at(0, 2, [[10, 12]])
    const blocked = at(5, 6, [[6.5, 8]])
    expect(blockedAt([free, blocked], 1)).toBe(1)
    expect(blockedAt([blocked, free], 1)).toBe(0)
    expect(blockedAt([free, blocked], 3)).toBe(-1)
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

  it('labels a kind refusal with what the track takes', () => {
    const p = scene()
    const [lyrics, , video, audio] = p.tracks as Track[]
    const clip = createVideoClip({ trackId: video!.id, assetId: 'a', start: 0, duration: 2 })
    const song = createAudioClip({ trackId: audio!.id, assetId: 's', start: 0, duration: 2 })
    expect(refusalLabel(refuseTrack(p, clip, lyrics!)!)).toBe('Lyric lines only')
    expect(refusalLabel(refuseTrack(p, clip, audio!)!)).toBe('Audio only')
    expect(refusalLabel(refuseTrack(p, song, video!)!)).toBe('Visual clips only')
    expect(refusalLabel({ reason: 'room' })).toBe('No room')
  })

  describe('look lanes', () => {
    function lanes() {
      const p = createProject({ name: 'looks' })
      const [look, overlay, empty] = ['Look', 'Overlay', 'Empty'].map((n) =>
        createTrack('visual', n),
      ) as Track[]
      const video = p.tracks.find((t) => t.kind === 'visual')!
      p.tracks = [look!, overlay!, empty!, ...p.tracks]
      const { color: _color, ...rest } = createSolidClip({
        trackId: look!.id,
        color: '#000',
        start: 0,
        duration: 30,
      })
      const neon: Clip = { ...rest, type: 'adjustment', meta: { role: 'look' } }
      const bars = createSolidClip({ trackId: overlay!.id, color: '#fff', start: 40, duration: 5 })
      const shot = createVideoClip({ trackId: video.id, assetId: 'a', start: 0, duration: 4 })
      for (const c of [neon, bars, shot]) p.clips[c.id] = c
      return { p, look: look!, overlay: overlay!, empty: empty!, neon, shot }
    }

    it('keeps other clips off a look lane, even on an empty stretch of it', () => {
      const { p, look, shot } = lanes()
      const refusal = refuseTrack(p, shot, look)!
      expect(refusalLabel(refusal)).toBe('Looks only')
      expect(refusalToast(p, refusal)).toBe("Video clips can't go on the Look track.")
    })

    it('keeps looks off every track but a look lane, even an empty one', () => {
      const { p, overlay, empty, neon } = lanes()
      const audio = p.tracks.find((t) => t.kind === 'audio')!
      for (const track of [overlay, empty, audio]) {
        const refusal = refuseTrack(p, neon, track)!
        expect(refusalLabel(refusal)).toBe('No looks here')
        expect(refusalToast(p, refusal)).toBe(`Look clips can't go on the ${track.name} track.`)
      }
    })

    it('takes a look on another look lane, and any clip on a look lane whose looks move away with it', () => {
      const { p, look, empty, neon, shot } = lanes()
      const { color: _color, ...rest } = createSolidClip({
        trackId: empty.id,
        color: '#000',
        start: 0,
        duration: 5,
      })
      const tint: Clip = { ...rest, type: 'adjustment', meta: { role: 'look' } }
      p.clips[tint.id] = tint
      expect(refuseTrack(p, neon, empty)).toBeNull()
      expect(refuseTrack(p, shot, look, new Set([neon.id, shot.id]))).toBeNull()
    })
  })
})
