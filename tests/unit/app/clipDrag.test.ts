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
  closeUp,
  dropShift,
  gapFit,
  insertPlan,
  rearrangePlan,
  refusalLabel,
  refusalToast,
  refuseTrack,
  swapPlan,
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

describe('gapFit', () => {
  // A 7.3 s gap from 13.1 to 20.4 between two clips, and a clip dragged from 40 s.
  const gap: [number, number][] = [
    [5, 13.1],
    [20.4, 30],
  ]

  it('drops a clip that fits the gap under the pointer exactly at its edges, wherever in the gap it was let go', () => {
    const clip = at(40, 47.3, gap)
    // Let go 0.4 s late: it overlaps the next clip, but the pointer is over the gap.
    const fit = gapFit(clip, 16, 13.5 - 40, -40, 100)
    expect(fit?.shift).toBeCloseTo(13.1 - 40, 9)
    expect(fit?.duration).toBeUndefined()
    // Float rounding of the edges still fits.
    expect(gapFit(at(40, 47.3004, gap), 16, -27, -40, 100)?.duration).toBeUndefined()
  })

  it('keeps a shorter clip where it was let go, moved just inside the gap', () => {
    const clip = at(40, 42, gap)
    expect(gapFit(clip, 15, 15 - 40, -40, 100)).toEqual({ shift: 15 - 40 })
    expect(gapFit(clip, 19, 19.5 - 40, -40, 100)?.shift).toBeCloseTo(18.4 - 40, 9)
  })

  it('trims a clip a few frames longer than the gap to fill it, and refuses one longer than that', () => {
    const fit = gapFit(at(40, 47.36, gap), 16, -27, -40, 100)
    expect(fit?.shift).toBeCloseTo(13.1 - 40, 9)
    expect(fit?.duration).toBeCloseTo(7.3, 9)
    expect(gapFit(at(40, 47.5, gap), 16, -27, -40, 100)).toBeNull()
  })

  it('has nothing to fill when the pointer is over a clip, and stays within the timeline', () => {
    expect(gapFit(at(40, 42, gap), 25, -15, -40, 100)).toBeNull()
    // The gap from the timeline's start to the first clip: let go before the start, it lands at 0.
    expect(gapFit(at(40, 42, gap), 2, -41, -40, 100)).toEqual({ shift: -40 })
  })
})

describe('swapPlan', () => {
  // Clips at 0..2, 2..4, 4..8 and 10..12 on the track.
  const track = [
    { id: 'a', start: 0, end: 2 },
    { id: 'b', start: 2, end: 4 },
    { id: 'c', start: 4, end: 8 },
    { id: 'd', start: 10, end: 12 },
  ]
  const without = (id: string) => track.filter((o) => o.id !== id)

  it('swaps a clip with its same-length neighbor, each taking the other’s place', () => {
    expect(swapPlan({ start: 0, end: 2 }, 3, without('a'), true)).toEqual({
      id: 'b',
      clip: { start: 2, end: 4 },
      other: { start: 0, end: 2 },
    })
  })

  it('swaps clips of the same length that are not neighbors, or on another track, leaving the clips between', () => {
    expect(swapPlan({ start: 0, end: 2 }, 11, without('a'), true)).toEqual({
      id: 'd',
      clip: { start: 10, end: 12 },
      other: { start: 0, end: 2 },
    })
    expect(swapPlan({ start: 50, end: 52 }, 11, track, false)).toMatchObject({
      id: 'd',
      other: { start: 50, end: 52 },
    })
  })

  it('counts lengths a few frames apart as the same: each takes the other’s length too, so the cuts stay', () => {
    expect(swapPlan({ start: 20, end: 22.04 }, 11, track, false)).toEqual({
      id: 'd',
      clip: { start: 10, end: 12 },
      other: { start: 20, end: 22.04 },
    })
  })

  it('swaps neighbors of different lengths in the space they share, keeping the gap between them', () => {
    // b (2 s) onto c (4 s) after it: c starts where b did and b ends where c did.
    expect(swapPlan({ start: 2, end: 4 }, 6, without('b'), true)).toEqual({
      id: 'c',
      clip: { start: 6, end: 8 },
      other: { start: 2, end: 6 },
    })
    // d (2 s) back onto c (4 s) before it, across the gap from 8 to 10.
    expect(swapPlan({ start: 10, end: 12 }, 5, without('d'), true)).toEqual({
      id: 'c',
      clip: { start: 4, end: 6 },
      other: { start: 8, end: 12 },
    })
  })

  it('refuses a clip of another length that is not a neighbor, or on another track; nothing to swap over a gap', () => {
    expect(swapPlan({ start: 0, end: 2 }, 5, without('a'), true)).toBe('length')
    expect(swapPlan({ start: 50, end: 54.5 }, 11, track, false)).toBe('length')
    expect(swapPlan({ start: 0, end: 2 }, 9, without('a'), true)).toBeNull()
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
    expect(refusalToast(p, { reason: 'room', length: true })).toBe(
      'No room there. A clip swaps places only with its neighbor or a clip of the same length.',
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

describe('rearrangePlan', () => {
  const on = (id: string, start: number, end: number) => ({ id, start, end })
  // A track of four 2 s clips, a..d, and another track holding x at 0..3 and y at 5..6.
  const track = [on('a', 0, 2), on('b', 2, 4), on('c', 4, 6), on('d', 6, 8)]
  const other = [on('x', 0, 3), on('y', 5, 6)]
  const staying =
    (...leaving: string[]) =>
    (trackId: string) =>
      trackId === 't' ? track.filter((o) => !leaving.includes(o.id)) : other

  it('moves a clip later along its track with no gap behind it: the clips it passes move left, the track keeps its length', () => {
    // a dropped where c ends on the closed-up track (b 0..2, c 2..4, d 4..6).
    expect(rearrangePlan([{ start: 0, end: 2, from: 't', to: 't' }], staying('a'), 4, 0)).toEqual({
      shift: 4,
      at: 4,
      moves: [
        { id: 'b', start: 0 },
        { id: 'c', start: 2 },
      ],
    })
  })

  it('moves a clip earlier along its track: the clips it passes move right, the ones after where it was stay', () => {
    expect(rearrangePlan([{ start: 6, end: 8, from: 't', to: 't' }], staying('d'), -4, -6)).toEqual({
      shift: -4,
      at: 2,
      moves: [
        { id: 'b', start: 4 },
        { id: 'c', start: 6 },
      ],
    })
  })

  it('closes up the track a clip leaves and pushes the later clips on the track it goes to', () => {
    expect(rearrangePlan([{ start: 0, end: 2, from: 't', to: 'u' }], staying('a'), 3, 0)).toEqual({
      shift: 3,
      at: 3,
      moves: [
        { id: 'b', start: 0 },
        { id: 'c', start: 2 },
        { id: 'd', start: 4 },
        { id: 'y', start: 7 },
      ],
    })
  })

  it('leaves everything as it was when the clip is dropped where it was', () => {
    expect(rearrangePlan([{ start: 2, end: 4, from: 't', to: 't' }], staying('b'), 0, -2)?.moves).toEqual([])
  })
})

describe('closeUp', () => {
  it('moves each staying clip left by the leaving clips that ended before it, keeping gaps that were there', () => {
    const staying = [
      { id: 'a', start: 0, end: 2 },
      { id: 'c', start: 5, end: 6 },
      { id: 'e', start: 9, end: 10 },
    ]
    expect(
      closeUp(staying, [
        { start: 2, end: 4 },
        { start: 6, end: 8 },
      ]).map((o) => [o.id, o.start]),
    ).toEqual([
      ['a', 0],
      ['c', 3],
      ['e', 5],
    ])
  })
})
