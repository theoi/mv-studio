import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDemoProject, TRACK_IDS } from '../../../src/app/mock/demoProject.ts'
import { copySelection } from '../../../src/app/state/clipboard.ts'
import { editor } from '../../../src/app/state/project.ts'
import { get, selectClips, selectedClipIds, set } from '../../../src/app/state/ui.ts'
import {
  laneItemsAt,
  pasteHereTime,
  type LaneSpot,
} from '../../../src/app/screens/editor/timeline/laneMenu.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

beforeEach(() => {
  editor.load(buildDemoProject())
  set({ snap: true, beatSnap: true, pxPerSec: 12, playhead: 0, selection: { type: 'none' } })
})

const overlay = (time: number): LaneSpot => ({ trackId: TRACK_IDS.overlay, time })

describe('Paste here in the lane menu', () => {
  it('snaps the right-clicked time like a dropped clip, within 8 px, when snapping is on', () => {
    const p = editor.getProject()
    // The demo song has a beat every 0.5 s; nothing else is near 31 s on the Overlay track.
    expect(pasteHereTime(p, overlay(31.37))).toBe(31.5)
    set({ pxPerSec: 100 })
    expect(pasteHereTime(p, overlay(31.37))).toBe(31.37)
    set({ pxPerSec: 12, beatSnap: false })
    // The Title on the Overlay track ends at 9 s.
    expect(pasteHereTime(p, overlay(9.3))).toBe(9)
    expect(pasteHereTime(p, overlay(31.37))).toBe(31.37)
    set({ snap: false, beatSnap: true })
    expect(pasteHereTime(p, overlay(31.37))).toBe(31.37)
  })

  it('shows the snapped time and where the copies land, and pastes there', () => {
    const singer = Object.values(editor.getProject().clips).find(
      (c) => c.trackId === TRACK_IDS.video && c.start === 66,
    )!
    selectClips([singer.id])
    copySelection()
    const p = editor.getProject()
    const line = (at: LaneSpot) =>
      laneItemsAt(p, at)
        .find((i) => i.label === 'Paste here')
        ?.description?.(p, at)
    expect(line(overlay(31.37))).toBe('At 0:31.5')
    // Spectrum bars start at 64 s and the Video track is full there, so the copy needs a new track.
    expect(line(overlay(63.2))).toBe('At 1:03.0 · on a new track')

    laneItemsAt(p, overlay(31.37))
      .find((i) => i.label === 'Paste here')
      ?.run(overlay(31.37))
    const [id] = selectedClipIds(get().selection)
    expect(editor.getProject().clips[id!]).toMatchObject({ trackId: TRACK_IDS.overlay, start: 31.5 })
  })
})
