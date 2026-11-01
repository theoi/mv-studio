import { describe, expect, it } from 'vitest'
import {
  actions,
  actionsById,
  actionScore,
  paletteResults,
} from '../../../src/app/screens/palette/actions.tsx'
import { PAGES } from '../../../src/app/screens/palette/pages.tsx'
import { SHORTCUTS } from '../../../src/app/state/keymap.ts'
import { editor, sectionLabels } from '../../../src/app/state/project.ts'
import { get, select, set } from '../../../src/app/state/ui.ts'
import { settingsForAspect } from '../../../src/model/index.ts'
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

  it('finds the vertical export before the switch of the whole project for TikTok', () => {
    expect(
      paletteResults('tiktok')
        .slice(0, 2)
        .map((a) => a.id),
    ).toEqual(['exportVertical', 'aspect9x16'])
    expect(paletteResults('make a vertical version for tiktok')[0]?.id).toBe('exportVertical')
    expect(paletteResults('youtube shorts')[0]?.id).toBe('exportVertical')
  })

  it('reads an aspect ratio as one word: “9:16” is the vertical switch, not 16:9', () => {
    for (const [search, id, other] of [
      ['9:16', 'aspect9x16', 'aspect16x9'],
      ['9/16', 'aspect9x16', 'aspect16x9'],
      ['16:9', 'aspect16x9', 'aspect9x16'],
    ] as const) {
      const ids = paletteResults(search).map((a) => a.id)
      expect(ids[0], search).toBe(id)
      expect(ids, search).not.toContain(other)
    }
  })

  it('says what an aspect switch changes the project to, and keeps the vertical export’s note for other frames', () => {
    expect(actionsById.get('aspect4x5')?.detail?.()).toBe('Changes the project to 4:5')
    const exportVertical = actionsById.get('exportVertical')
    expect(exportVertical?.detail?.()).toBe('Keeps the project 16:9')
    editor.dispatch({ type: 'project.updateSettings', settings: settingsForAspect('9:16', 30) })
    try {
      expect(exportVertical?.detail?.()).toBeUndefined()
    } finally {
      editor.undo()
    }
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
  it('finds Go to a section… first for a section the search names, and opens its page on that name', () => {
    const goTo = actionsById.get('goToSection')!
    for (const [search, page] of [
      ['go to the chorus', 'chorus'],
      ['jump to verse 2', 'verse 2'],
      ['go to the Pre-chorus?', 'Pre-chorus'],
    ] as const) {
      expect(paletteResults(search)[0]?.id, search).toBe('goToSection')
      expect(goTo.pageSearch?.(search), search).toBe(page)
    }
  })

  it('lists the song’s sections by name and start, numbering a repeated name, and goes to the one picked', () => {
    const items = () => PAGES.sections.groups({ id: 'sections' }).flatMap((g) => g.items)
    expect(items().map((i) => `${i.label} ${i.detail}`)).toEqual([
      'Intro 0:00',
      'Verse 1 0:16',
      'Pre-chorus 0:48',
      'Chorus 1 1:04',
      'Verse 2 1:36',
      'Chorus 2 2:08',
      'Bridge 2:40',
      'Chorus 3 3:04',
      'Outro 3:16',
    ])
    const before = get()
    try {
      select({ type: 'clip', id: Object.keys(editor.getProject().clips)[0]! })
      const pick = (label: string) =>
        items()
          .find((i) => i.label === label)
          ?.run?.()
      pick('Chorus 2')
      expect(get().playhead).toBe(128)
      expect(get().selection.type).toBe('clip')
      expect(items().find((i) => i.current)?.label).toBe('Chorus 2')

      select({ type: 'section', id: 's-intro' })
      pick('Verse 2')
      expect(get().playhead).toBe(96)
      expect(get().selection).toEqual({ type: 'section', id: 's-v2' })
    } finally {
      set({ playhead: before.playhead, selection: before.selection })
    }
  })
  it('leaves another action first for a section the user named after its words: an outro named “End” is not Go to the end', () => {
    const assetId = editor.getProject().songAssetId!
    editor.dispatch({
      type: 'analysis.updateSection',
      assetId,
      sectionId: 's-outro',
      patch: { label: 'End' },
    })
    try {
      expect(paletteResults('end')[0]?.id).toBe('end')
      expect(paletteResults('go to end')[0]?.id).toBe('end')
      expect(paletteResults('go to the chorus')[0]?.id).toBe('goToSection')
      const page = PAGES.sections.groups({ id: 'sections' }).flatMap((g) => g.items)
      expect(page.map((i) => i.label)).toContain('End')
    } finally {
      editor.undo()
    }
  })

  it('numbers a repeated section name past the numbers other sections already have', () => {
    const assetId = editor.getProject().songAssetId!
    editor.dispatch(
      ['s-v1', 's-bridge'].map((sectionId) => ({
        type: 'analysis.updateSection' as const,
        assetId,
        sectionId,
        patch: { label: 'Verse' },
      })),
    )
    try {
      expect(sectionLabels(editor.getProject()).filter((l) => l.startsWith('Verse'))).toEqual([
        'Verse 1',
        'Verse 2',
        'Verse 3',
      ])
    } finally {
      editor.undo()
    }
  })

  it('finds a section named while the search stays the same', () => {
    expect(paletteResults('finale')).toEqual([])
    const assetId = editor.getProject().songAssetId!
    editor.dispatch({
      type: 'analysis.updateSection',
      assetId,
      sectionId: 's-outro',
      patch: { label: 'Finale' },
    })
    try {
      expect(paletteResults('finale')[0]?.id).toBe('goToSection')
    } finally {
      editor.undo()
    }
  })
})
