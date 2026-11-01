import { describe, expect, it } from 'vitest'
import { actions, actionsById, paletteResults } from '../../../src/app/screens/palette/actions.tsx'
import { SHORTCUTS } from '../../../src/app/state/keymap.ts'
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
})
