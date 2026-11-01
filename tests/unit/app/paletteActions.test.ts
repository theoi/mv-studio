import { describe, expect, it } from 'vitest'
import {
  actions,
  actionsById,
  actionScore,
  paletteResults,
} from '../../../src/app/screens/palette/actions.tsx'
import { SHORTCUTS } from '../../../src/app/state/keymap.ts'
import { ASK_SCORE, isSentence } from '../../../src/app/state/paletteScore.ts'
import { SHORTCUTS_NOT_IN_PALETTE, UI_ACTIONS } from '../../../src/app/state/uiActions.ts'

const covered = UI_ACTIONS.flatMap((a) =>
  typeof a.palette === 'string' ? [{ ...a, palette: a.palette }] : [],
)
const skipped = UI_ACTIONS.flatMap((a) =>
  typeof a.palette === 'string' ? [] : [{ ...a, reason: a.palette.skipped }],
)
const searches = covered.flatMap((a) =>
  a.search.map((query) => [query, a.palette, `${a.area} › ${a.name}`] as const),
)

describe('command palette coverage', () => {
  it('gives every action its own id', () => {
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length)
  })

  it.each(covered.map((a) => [`${a.area} › ${a.name}`, a.palette] as const))(
    '%s has the palette action %s',
    (_, id) => {
      expect(actionsById.has(id)).toBe(true)
    },
  )

  it.each(skipped.map((a) => [`${a.area} › ${a.name}`, a] as const))(
    '%s is left out with a reason, and has no search',
    (_, a) => {
      expect(a.reason.length).toBeGreaterThan(20)
      expect(a.search).toEqual([])
    },
  )

  it.each(covered.map((a) => [`${a.area} › ${a.name}`, a] as const))('%s has a search', (_, a) => {
    expect(a.search.length).toBeGreaterThan(0)
  })

  it.each(searches)('“%s” lists %s in the top three (%s)', (query, id) => {
    expect(
      paletteResults(query)
        .slice(0, 3)
        .map((a) => a.id),
    ).toContain(id)
  })

  it.each(SHORTCUTS.map((s) => [s.id] as const))(
    'the %s shortcut is a palette action’s, or the palette says why not',
    (id) => {
      const inPalette = actions.some((a) => a.shortcut === id)
      expect(inPalette ? undefined : SHORTCUTS_NOT_IN_PALETTE[id]).toEqual(
        inPalette ? undefined : expect.any(String),
      )
      expect(inPalette && id in SHORTCUTS_NOT_IN_PALETTE).toBe(false)
    },
  )

  it('shows the empty note for a search that names nothing', () => {
    expect(paletteResults('zebra crossing')).toEqual([])
  })

  it('lists nothing for a search of one or two words that half names an action, as there is no Ask Assist row above it', () => {
    for (const search of ['dark mode', 'chroma key', 'srt file', 'slow motion', 'bigger font'])
      expect(paletteResults(search), search).toEqual([])
  })

  it('finds no action through another sense of a word', () => {
    expect(paletteResults('speed up')).toEqual([])
    expect(paletteResults('info')[0]?.id).toBe('about')
    expect(paletteResults('info').map((a) => a.id)).not.toContain('exportVertical')
    const music = paletteResults('music').map((a) => a.id)
    expect(music[0]).toBe('react')
    expect(music).not.toContain('beatSnap')
    expect(music).not.toContain('showGrid')
  })

  it('lists an action other words name below Ask Assist for a sentence, and not for a shorter search', () => {
    expect(paletteResults('enlarge').map((a) => a.id)).not.toContain('zoomIn')
    expect(paletteResults('enlarge the timeline').map((a) => a.id)).toContain('zoomIn')
    expect(actionScore(actionsById.get('zoomIn')!, 'enlarge the timeline')).toBeLessThan(ASK_SCORE)
  })

  it('keeps an action below Ask Assist when the search names something else for it to act on', () => {
    expect(paletteResults('make a copy of this project')[0]?.id).toBe('duplicateProject')
    expect(actionScore(actionsById.get('copy')!, 'make a copy of this project')).toBeLessThan(ASK_SCORE)
    expect(actionScore(actionsById.get('selectAll')!, 'select all clips in this section')).toBeLessThan(
      ASK_SCORE,
    )
  })

  it('finds the action whose shortcut the search types, and nothing by its letters', () => {
    expect(paletteResults('ctrl+v').map((a) => a.id)).toEqual(['paste'])
    expect(paletteResults('cmd+shift+z').map((a) => a.id)).toEqual(['redo'])
    expect(paletteResults('ctrl+q')).toEqual([])
  })

  it('reads an alias of several words as an action’s name only with all of them: “clip” isn’t Delete', () => {
    for (const search of ['clip', 'the clip', 'this clip', 'what is a clip'])
      expect(paletteResults(search)[0]?.id, search).not.toBe('delete')
    expect(paletteResults('remove the clip')[0]?.id).toBe('delete')
  })

  it('lists every action below Ask Assist for a question', () => {
    for (const search of ['how do i cut', 'where are my files', 'is it on', 'how export']) {
      expect(isSentence(search), search).toBe(true)
      const top = paletteResults(search)[0]
      expect(top ? actionScore(top, search) : 0, search).toBeLessThan(ASK_SCORE)
    }
  })

  it('keeps a toggle below Ask Assist when a sentence asks for the opposite of what it does', () => {
    // The sample shows the beat grid, so the action is Hide the beat grid.
    const grid = actionsById.get('showGrid')!
    expect(actionScore(grid, 'show me the beats')).toBeLessThan(ASK_SCORE)
    expect(actionScore(grid, 'hide the beat grid')).toBeGreaterThan(ASK_SCORE)
    // Snapping is on, so its actions are Turn off snapping and Stop snapping to beats.
    for (const id of ['snap', 'beatSnap'])
      expect(actionScore(actionsById.get(id)!, 'turn on snapping'), id).toBeLessThan(ASK_SCORE)
    expect(actionScore(actionsById.get('snap')!, 'turn off snapping')).toBeGreaterThan(ASK_SCORE)
  })

  it('ranks an action’s own name word above a name word another word stands for', () => {
    // "portrait" is a keyword of Switch to vertical 9:16, and another word for its "vertical".
    expect(paletteResults('portrait')[0]?.id).toBe('aspect4x5')
    expect(paletteResults('start playback')[0]?.id).toBe('play')
  })

  it('lists no action above Ask Assist for a question made of small words', () => {
    expect(paletteResults('how do i')).toEqual([])
  })

  it('ranks Delete first for removing a clip, and finds it for getting rid of one', () => {
    expect(paletteResults('remove this clip')[0]?.id).toBe('delete')
    const rid = paletteResults('get rid of the clip').map((a) => a.id)
    expect(rid).toContain('delete')
    expect(rid).not.toContain('showGrid')
  })

  it('leaves actions that match only some words out of a group whose best match ranks above Ask Assist', () => {
    // Add media, Add a visualizer… and Add a transition… match "add" alone.
    expect(
      paletteResults('add an effect')
        .filter((a) => a.group === 'Library')
        .map((a) => a.id),
    ).toEqual(['effect'])
  })
})
