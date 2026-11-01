import { describe, expect, it } from 'vitest'
import { blankClipWarning } from '../../../src/app/state/blankClips.ts'
import { createTrack, createVideoClip } from '../../../src/model/factory.ts'
import type { Clip, Project } from '../../../src/model/types.ts'
import { CLIPS, makeProject } from '../vision/autocut/fixtures.ts'

describe('the warning before export about clips that show nothing', () => {
  const blank = new Set(['city', 'crowd'])
  const base = makeProject({ clips: CLIPS.map((c) => ({ ...c, blank: blank.has(c.id) })) })
  const visible = createTrack('visual')
  const hidden = { ...createTrack('visual', 'Hidden'), hidden: true }
  const on = (
    track: { id: string },
    assetId: string,
    start: number,
    extra: { enabled?: boolean } = {},
  ): Clip => ({
    ...createVideoClip({ trackId: track.id, assetId, start, duration: 2 }),
    ...extra,
  })
  const withClips = (clips: Clip[]): Project => ({
    ...base,
    tracks: [visible, hidden, ...base.tracks],
    clips: Object.fromEntries(clips.map((c) => [c.id, c])),
  })

  it('names a clip that shows nothing and when it plays, in order', () => {
    const project = withClips([
      on(visible, 'city', 138.7),
      on(visible, 'ocean', 4),
      on(visible, 'city', 15.3),
    ])
    expect(blankClipWarning(project)).toBe(
      '“city.mp4” shows nothing: every frame is black or see-through. It plays at 0:15 and 2:18.',
    )
  })

  it('lists every clip that shows nothing, skipping hidden tracks and disabled clips', () => {
    const project = withClips([
      on(visible, 'city', 15),
      on(visible, 'crowd', 30),
      on(visible, 'crowd', 62),
      on(hidden, 'city', 70),
      on(visible, 'city', 80, { enabled: false }),
    ])
    expect(blankClipWarning(project)).toBe(
      '2 clips show nothing, as every frame is black or see-through: “city.mp4” at 0:15; “crowd.mp4” at 0:30 and 1:02.',
    )
    expect(blankClipWarning(withClips([on(visible, 'ocean', 0), on(hidden, 'city', 3)]))).toBeUndefined()
  })

  it('counts the play times of a clip placed more than three times, from the first', () => {
    const often = [64, 16, 32, 48].map((t) => on(visible, 'city', t))
    expect(blankClipWarning(withClips(often))).toBe(
      '“city.mp4” shows nothing: every frame is black or see-through. It plays 4 times, first at 0:16.',
    )
    expect(blankClipWarning(withClips([...often, on(visible, 'crowd', 30)]))).toBe(
      '2 clips show nothing, as every frame is black or see-through: “city.mp4” plays 4 times, first at 0:16; “crowd.mp4” at 0:30.',
    )
  })
})
