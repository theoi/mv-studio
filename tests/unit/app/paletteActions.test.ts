import { describe, expect, it, vi } from 'vitest'
import {
  actions,
  actionsById,
  actionScore,
  destructiveNow,
  labelOf,
  offersAsk,
  paletteResults,
  type Action,
} from '../../../src/app/screens/palette/actions.tsx'
import { PAGES } from '../../../src/app/screens/palette/pages.tsx'
import { SHORTCUTS } from '../../../src/app/state/keymap.ts'
import {
  editor,
  sectionKind,
  sectionLabels,
  sectionsOf,
  type SectionKind,
} from '../../../src/app/state/project.ts'
import { dismissToast, get, select, set, type Selection } from '../../../src/app/state/ui.ts'
import { settingsForAspect } from '../../../src/model/index.ts'
import { ASK_SCORE, isSentence } from '../../../src/app/state/paletteScore.ts'
import { SHORTCUTS_NOT_IN_PALETTE, UI_ACTIONS } from '../../../src/app/state/uiActions.ts'
import { stillClips } from '../../../src/app/state/camera.ts'
import { NO_GRAPHICS_REASON } from '../../../src/app/state/graphics.ts'
import { CAMERA_EFFECT_ID } from '../../../src/vision/render/cameraEffect.ts'
import type * as Capabilities from '../../../src/shared/capabilities.ts'

// As in a browser that draws with WebGL 2, which Node can't; the test without it turns it off.
const gpu = vi.hoisted(() => ({ webgl2: true }))
vi.mock('../../../src/shared/capabilities.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Capabilities>()),
  webgl2Available: () => gpu.webgl2,
}))

const covered = UI_ACTIONS.flatMap((a) =>
  typeof a.palette === 'string' ? [{ ...a, palette: a.palette }] : [],
)
const skipped = UI_ACTIONS.flatMap((a) =>
  typeof a.palette === 'string' ? [] : [{ ...a, reason: a.palette.skipped }],
)
const firstVideo = () => Object.values(editor.getProject().clips).find((c) => c.type === 'video')!

/** Runs `check` with a video clip selected, as the palette is mostly opened, then puts the selection back. */
function withVideoSelected(check: () => void) {
  const before = get().selection
  select({ type: 'clip', id: firstVideo().id })
  try {
    check()
  } finally {
    set({ selection: before })
  }
}

/**
 * Each of `entries`, which delete, is listed for its whole names, and for no search that stops partway through a word
 * of one of them, unless the whole words before already name it.
 */
function expectWholeNamesOnly(entries: Action[]) {
  expect(entries.length).toBeGreaterThan(0)
  const listed = new Map<string, string[]>()
  const ids = (search: string) => {
    if (!listed.has(search))
      listed.set(
        search,
        paletteResults(search).map((a) => a.id),
      )
    return listed.get(search)!
  }
  for (const a of entries) {
    const aliases = typeof a.aliases === 'function' ? a.aliases() : (a.aliases ?? [])
    for (const name of [labelOf(a), ...aliases]) {
      const text = name.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '')
      expect(ids(text), name).toContain(a.id)
      for (let end = 1; end < text.length; end++) {
        if (text[end] === ' ' || text[end - 1] === ' ') continue
        const start = text.lastIndexOf(' ', end) + 1
        const word = text.slice(start).split(' ')[0]!
        // A plural's singular is a whole word: "reset vj mapping" names Reset VJ mappings.
        if (word === `${text.slice(start, end)}s`) continue
        // The whole words before may name it already: "remove" names Delete, so "remove c" lists it.
        const before = text.slice(0, start).trim()
        if (before && ids(before).includes(a.id)) continue
        expect(ids(text.slice(0, end)), `${a.id}: “${text.slice(0, end)}”`).not.toContain(a.id)
      }
    }
  }
}

const searches = covered.flatMap((a) =>
  a.search.map((query) => [query, a.palette, `${a.area} › ${a.name}`] as const),
)

const onScreenNames = covered.flatMap((a) =>
  (a.controls ?? []).flatMap((label) =>
    typeof label === 'string' && /^\S+( \S+){1,4}$/.test(label) && !/ (on|off)$/.test(label)
      ? [[label, a.palette, `${a.area} › ${a.name}`] as const]
      : [],
  ),
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

  // With a video clip selected, which most actions on the selection can act on: one that can't run ranks lower.
  it.each(searches)('“%s” lists %s in the top three (%s)', (query, id) => {
    withVideoSelected(() =>
      expect(
        paletteResults(query)
          .slice(0, 3)
          .map((a) => a.id),
      ).toContain(id),
    )
  })

  // What a control's name on screen says, typed as is, finds what it does, with a selection that shows the control.
  // Names of one word are often shared ("Color", "Remove"), a switch's name ends with its state ("Shadow on") and a
  // card's name runs on into its description, so those are left to the searches above.
  it.each(onScreenNames)('the on-screen name “%s” lists %s in the top three (%s)', (label, id) => {
    const before = get().selection
    const clips = Object.values(editor.getProject().clips)
    const text = clips.find((c) => c.type === 'text' && !c.lyricLineId)!
    const line = clips.find((c) => c.type === 'text' && c.lyricLineId)!
    const found = (selection: Selection) => {
      set({ selection })
      return paletteResults(label)
        .slice(0, 3)
        .some((a) => a.id === id)
    }
    try {
      expect(
        [
          { type: 'clip', id: firstVideo().id },
          { type: 'clip', id: text.id },
          { type: 'clip', id: line.id },
          { type: 'none' },
        ].some((s) => found(s as Selection)),
      ).toBe(true)
    } finally {
      set({ selection: before })
    }
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
    for (const search of ['dark mode', 'chroma key', 'srt file'])
      expect(paletteResults(search), search).toEqual([])
  })

  it('finds no action through another sense of a word', () =>
    withVideoSelected(() => {
      // "Speed up" is a clip's speed, not the song's tempo.
      const speed = paletteResults('speed up').map((a) => a.id)
      expect(speed[0]).toBe('speed')
      expect(speed).not.toContain('doubleTempo')
      expect(paletteResults('info')[0]?.id).toBe('about')
      expect(paletteResults('info').map((a) => a.id)).not.toContain('exportVertical')
      const music = paletteResults('music').map((a) => a.id)
      // The new AI music video names it too; the song’s beats don’t.
      expect(music.slice(0, 2)).toContain('react')
      expect(music).not.toContain('beatSnap')
      expect(music).not.toContain('showGrid')
    }))

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

  it('reads an alias of several words as an action’s name only with all of them: “clip” isn’t Delete', () =>
    withVideoSelected(() => {
      for (const search of ['clip', 'the clip', 'this clip', 'what is a clip'])
        expect(paletteResults(search)[0]?.id, search).not.toBe('delete')
      expect(paletteResults('remove the clip')[0]?.id).toBe('delete')
    }))

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

  it('ranks an action on the selection below the ones that can run while nothing fits it, and just below an equal match', () => {
    const before = get()
    const ids = (search: string) => paletteResults(search).map((a) => a.id)
    const video = Object.values(editor.getProject().clips).find((c) => c.type === 'video')!
    try {
      set({ selection: { type: 'none' }, playhead: video.start + video.duration / 2 })
      expect(ids('play')[0]).toBe('play')
      expect(ids('end')[0]).toBe('end')
      expect(ids('end')).toContain('trimEnd')
      expect(ids('end').indexOf('trimEnd')).toBeGreaterThan(ids('end').indexOf('sectionEndTime'))
      // The project's look is there to act on, but the name of the feature still opens it.
      expect(ids('look')[0]).toBe('looks')
      expect(ids('look')).toContain('lookIntensity')
      select({ type: 'clip', id: video.id })
      expect(ids('end')[0]).toBe('end')
      expect(ids('end').indexOf('trimEnd')).toBeLessThan(ids('end').indexOf('sectionEndTime'))
    } finally {
      set({ selection: before.selection, playhead: before.playhead })
    }
  })

  it('opens a page of common speeds for the selected video clip, and the one picked is one undo step', () => {
    const before = get().selection
    const video = Object.values(editor.getProject().clips).find((c) => c.type === 'video')!
    const speed = actionsById.get('speed')!
    const items = () => PAGES.values.groups({ id: 'values', action: 'speed' }).flatMap((g) => g.items)
    // Picking says so in a toast, which times itself out.
    vi.stubGlobal('window', globalThis)
    try {
      set({ selection: { type: 'none' } })
      expect(speed.unavailable?.()).toBe('Select a video clip first')
      expect(items()).toEqual([])
      select({ type: 'clip', id: video.id })
      expect(speed.unavailable?.()).toBeUndefined()
      expect(items().find((i) => i.current)?.label).toBe('100%')
      // The speed it has already changes nothing: no undo step, and so no toast.
      const unchanged = editor.getProject()
      items()
        .find((i) => i.current)
        ?.run?.()
      expect(editor.getProject()).toBe(unchanged)
      items()
        .find((i) => i.label === '50%')
        ?.run?.()
      expect(editor.getProject().clips[video.id]).toMatchObject({ playbackRate: 0.5 })
      expect(editor.undoLabel()).toBe('Change speed')
      editor.undo()
      expect(editor.getProject().clips[video.id]).toMatchObject({ playbackRate: 1 })
    } finally {
      set({ selection: before })
      // Before window goes: a toast's timer that fires later, while other tests run, would find no window.
      for (const t of get().toasts) dismissToast(t.id)
      vi.unstubAllGlobals()
    }
  })

  it('ranks an action that can’t run for the selection below the ones that can, old and new alike', () =>
    withVideoSelected(() => {
      // Animate with AI needs an image: with a video clip selected, the director comes first for an AI music video.
      const ids = paletteResults('ai music video').map((a) => a.id)
      expect(ids.slice(0, 3)).toContain('director')
      expect(ids.indexOf('animateImage')).toBeGreaterThan(ids.indexOf('director'))
    }))

  it('lists no action above Ask Assist for a question made of small words', () => {
    expect(paletteResults('how do i')).toEqual([])
  })

  describe('with nothing selected and the playhead in a chorus or a verse', () => {
    const at = (kind: SectionKind, check: () => void) => () => {
      const before = { selection: get().selection, playhead: get().playhead }
      const section = sectionsOf(editor.getProject()).find((s) => sectionKind(s) === kind)!
      try {
        set({ selection: { type: 'none' }, playhead: section.start + 1 })
        check()
      } finally {
        set(before)
      }
    }
    const ids = (search: string) => paletteResults(search).map((a) => a.id)
    const rename = actionsById.get('renameSection')!
    // First, above Ask Assist where a sentence has it, so Enter renames.
    const renames = (search: string) =>
      ids(search)[0] === 'renameSection' && actionScore(rename, search) > ASK_SCORE

    it(
      'offers to ask Assist for every search no action matches, so the list never ends empty',
      at('verse', () => {
        for (const search of ['rename chorus', 'paste chorus', 'zebra', 'zebra stripes']) {
          expect(ids(search), search).toEqual([])
          expect(offersAsk(search), search).toBe(true)
        }
        // A short search an action matches runs it with Enter, with no Ask Assist row above it.
        for (const search of ['rename section', 'rename verse', 'rename', 'cut'])
          expect(offersAsk(search), search).toBe(false)
        expect(offersAsk('rename the chorus')).toBe(true)
        expect(offersAsk('ctrl+q')).toBe(false)
        expect(offersAsk('  ')).toBe(false)
      }),
    )

    it(
      'finds Rename the section by the name of the section it renames, numbered or not',
      at('chorus', () => {
        for (const search of ['rename chorus', 'rename the chorus', 'rename chorus 1'])
          expect(renames(search), search).toBe(true)
        for (const search of ['rename verse', 'rename chorus 2', 'rename pre chorus'])
          expect(renames(search), search).toBe(false)
      }),
    )

    it(
      'finds Rename the section for “rename verse” in a verse, and not for “rename chorus” there',
      at('verse', () => {
        expect(renames('rename verse')).toBe(true)
        expect(renames('rename chorus')).toBe(false)
      }),
    )
  })

  it('ranks Delete first for removing a clip, and finds it for getting rid of one', () =>
    withVideoSelected(() => {
      expect(paletteResults('remove this clip')[0]?.id).toBe('delete')
      const rid = paletteResults('get rid of the clip').map((a) => a.id)
      expect(rid).toContain('delete')
      expect(rid).not.toContain('showGrid')
    }))

  it('lists Delete this project… only for a search that names the project, even with nothing selected', () => {
    const before = get().selection
    try {
      set({ selection: { type: 'none' } })
      expect(paletteResults('delete').map((a) => a.id)).not.toContain('deleteProject')
      expect(paletteResults('delete project')[0]?.id).toBe('deleteProject')
    } finally {
      set({ selection: before })
    }
  })

  describe.each([
    ['nothing selected', () => set({ selection: { type: 'none' } })],
    ['a video clip selected', () => select({ type: 'clip', id: firstVideo().id })],
  ])('with %s', (_, choose) => {
    const ids = (search: string) => paletteResults(search).map((a) => a.id)
    const withSelection = (check: () => void) => () => {
      const before = get().selection
      choose()
      try {
        check()
      } finally {
        set({ selection: before })
      }
    }

    // Enter runs the first row: one that can't run does nothing and says why, where another would do what the search
    // didn't ask for.
    it(
      'lists every action on the selection first for its own name, whether or not it can run',
      withSelection(() => {
        const named = actions.filter((a) => a.idle && typeof a.label === 'string')
        expect(named.length).toBeGreaterThan(20)
        for (const a of named) {
          const first = paletteResults(labelOf(a))[0]
          expect(first && labelOf(first), a.id).toBe(labelOf(a))
        }
      }),
    )

    it.each([
      ['delete', 'delete'],
      ['copy', 'copy'],
      ['duplicate', 'duplicate'],
      ['cut', 'cut'],
      ['close gap', 'closeGap'],
      ['delete gap', 'closeGap'],
      ['erase', 'delete'],
      ['trash', 'delete'],
      ['make a karaoke video', 'newProject.lyric'],
    ])('“%s” lists %s first', (search, id) => withSelection(() => expect(ids(search)[0]).toBe(id))())

    it(
      'lists the director and New AI music video… for “music video”',
      withSelection(() => expect(ids('music video').slice(0, 2)).toEqual(['director', 'newProject.ai'])),
    )

    it(
      'lists Close gap first with no gap to close, and never Delete and close gap for it',
      withSelection(() => {
        expect(actionsById.get('closeGap')!.unavailable?.()).toBe(
          'No gap at the playhead or before the selected clip',
        )
        expect(ids('close gap')).toEqual(['closeGap'])
        expect(ids('gap')).not.toContain('rippleDelete')
      }),
    )

    it(
      'lists an action that deletes only for a search that names it in full',
      withSelection(() => {
        for (const search of [
          'close gap',
          'gap',
          'delete gap',
          'ripple',
          'clip',
          'delete',
          'project',
          'remove',
        ])
          expect(ids(search), search).not.toContain(
            search === 'delete' || search === 'remove' ? 'deleteProject' : 'rippleDelete',
          )
        for (const search of ['erase', 'trash']) expect(ids(search), search).toEqual(['delete'])
        for (const search of ['clip', 'project']) expect(ids(search), search).not.toContain('delete')
        expect(ids('ripple delete')[0]).toBe('rippleDelete')
        expect(ids('delete and close gap')[0]).toBe('rippleDelete')
        expect(ids('remove this clip')[0]).toBe('delete')
        expect(ids('delete this project')[0]).toBe('deleteProject')
      }),
    )

    // Enter runs the first row, so the start of a word must not list what it is on its way to.
    it(
      'lists no action that deletes for “de”, “del”, “dele” or “delet”, and Delete first for “delete”',
      withSelection(() => {
        for (const search of ['de', 'del', 'dele', 'delet'])
          expect(
            ids(search).filter((id) => destructiveNow(actionsById.get(id)!)),
            search,
          ).toEqual([])
        expect(ids('delete')[0]).toBe('delete')
      }),
    )
  })

  it('lists no action that deletes for a search that stops partway through a word of one of its names', () =>
    withVideoSelected(() => {
      const destructive = actions.filter(destructiveNow)
      expect(destructive.map((a) => a.id).sort()).toEqual([
        'delete',
        'deleteProject',
        'removeKeyframes',
        'removeTransition',
        'rippleDelete',
        'vjResetMappings',
      ])
      expectWholeNamesOnly(destructive)
    }))

  describe.each([
    [
      'an outline, a shadow and a background on the selected text',
      ['textOutline', 'textShadow', 'textBackground'],
      ['outline', 'shadow', 'background', 'box'],
      ['stroke', 'text border', 'drop shadow', 'text box', 'background box', 'highlight box'],
      () => {
        const text = Object.values(editor.getProject().clips).find(
          (c) => c.type === 'text' && !c.lyricLineId,
        )!
        select({ type: 'clip', id: text.id })
        for (const id of ['textOutline', 'textShadow', 'textBackground']) {
          const toggle = actionsById.get(id)!
          if (labelOf(toggle).startsWith('Add')) toggle.run?.()
        }
      },
    ],
    [
      'the karaoke highlight on the selected lyric line',
      ['karaoke'],
      ['karaoke', 'highlight', 'turn on karaoke'],
      ['word highlight', 'karaoke highlight'],
      () => {
        const line = Object.values(editor.getProject().clips).find((c) => c.type === 'text' && c.lyricLineId)!
        select({ type: 'clip', id: line.id })
        const toggle = actionsById.get('karaoke')!
        if (labelOf(toggle).startsWith('Turn on')) toggle.run?.()
      },
    ],
    [
      'text behind the selected clip’s subject',
      ['behindClip'],
      ['front', 'behind subject'],
      ['text behind this person', 'lyrics behind this clip'],
      () => {
        const [host, cutout] = Object.values(editor.getProject().clips).filter((c) => c.type === 'video')
        editor.dispatch({
          type: 'clip.set',
          clipId: cutout!.id,
          path: ['meta'],
          value: { behindSubjectOf: host!.id },
        })
        select({ type: 'clip', id: host!.id })
      },
    ],
  ])('with %s', (_, toggles, partWords, nounNames, setUp) => {
    const inState = (check: () => void) => () => {
      const before = get().selection
      const steps = editor.history().undo.length
      try {
        setUp()
        check()
      } finally {
        while (editor.history().undo.length > steps) editor.undo()
        set({ selection: before })
      }
    }

    it(
      'lists the toggle that would remove it, which deletes then, only for whole names',
      inState(() => {
        const now = actions.filter((a) => typeof a.destructive === 'function' && destructiveNow(a))
        expect(now.map((a) => a.id)).toEqual(expect.arrayContaining(toggles))
        expectWholeNamesOnly(now)
      }),
    )

    it('lists it for no search that only names the part, or asks for the other way', () => {
      // The names it has while it adds, with nothing selected: “text box”, “word highlight”, “text behind this person”.
      const before = get().selection
      set({ selection: { type: 'none' } })
      const addNames = toggles.flatMap((id) => {
        const toggle = actionsById.get(id)!
        expect(destructiveNow(toggle), id).toBe(false)
        const aliases = typeof toggle.aliases === 'function' ? toggle.aliases() : (toggle.aliases ?? [])
        return [labelOf(toggle), ...aliases]
      })
      set({ selection: before })
      expect(addNames).toEqual(expect.arrayContaining(nounNames))
      inState(() => {
        for (const search of [...partWords, ...addNames]) {
          const ids = paletteResults(search).map((a) => a.id)
          expect(
            toggles.filter((id) => ids.includes(id)),
            search,
          ).toEqual([])
        }
      })()
    })
  })

  it('lists a text toggle by the start of a word while it adds, and only by whole names once it would remove', () => {
    const before = get().selection
    const steps = editor.history().undo.length
    const text = Object.values(editor.getProject().clips).find((c) => c.type === 'text' && !c.lyricLineId)!
    const background = actionsById.get('textBackground')!
    const ids = (search: string) => paletteResults(search).map((a) => a.id)
    try {
      select({ type: 'clip', id: text.id })
      expect(labelOf(background)).toBe('Add a background to the text')
      for (const search of ['box', 'backgr', 'text box'])
        expect(ids(search), search).toContain('textBackground')
      background.run?.()
      expect(labelOf(background)).toBe('Remove the text background')
      for (const search of ['box', 'backgr', 'background', 'text box', 'remove the text backgr'])
        expect(ids(search), search).not.toContain('textBackground')
      for (const search of [
        'remove text box',
        'remove background',
        'background off',
        'remove the text background',
      ])
        expect(ids(search), search).toContain('textBackground')
    } finally {
      while (editor.history().undo.length > steps) editor.undo()
      set({ selection: before })
    }
  })

  it('lists Reset VJ mappings for the names people give it, but not for “reset”, “default”, “mappings” or “reset vj”', () => {
    const ids = (search: string) => paletteResults(search).map((a) => a.id)
    for (const search of [
      'reset mappings',
      'reset midi',
      'midi reset',
      'reset midi mapping',
      'reset keys',
      'reset pads',
      'reset bindings',
      'reset keys and pads',
      'default mappings',
      'default bindings',
      'clear midi mappings',
      'clear vj mappings',
    ])
      expect(ids(search), search).toContain('vjResetMappings')
    // “reset vj” may mean VJ settings, and “vj reset” has the same words.
    for (const search of ['reset', 'default', 'mappings', 'reset vj', 'vj reset'])
      expect(ids(search), search).not.toContain('vjResetMappings')
  })

  it('lists the track move the search names first on a track that can’t move that way', () => {
    const before = get().selection
    const { tracks, clips } = editor.getProject()
    const clipOn = (track: (typeof tracks)[number]) =>
      Object.values(clips).find((c) => c.trackId === track.id)!
    try {
      select({ type: 'clip', id: clipOn(tracks.at(-1)!).id })
      expect(actionsById.get('trackDown')!.unavailable?.()).toBeDefined()
      expect(paletteResults('move track down')[0]?.id).toBe('trackDown')
      select({ type: 'clip', id: clipOn(tracks[0]!).id })
      expect(actionsById.get('trackUp')!.unavailable?.()).toBeDefined()
      expect(paletteResults('move track up')[0]?.id).toBe('trackUp')
      set({ selection: { type: 'none' } })
      expect(paletteResults('move track down')[0]?.id).toBe('trackDown')
    } finally {
      set({ selection: before })
    }
  })

  it('lists New lyric video… first for a karaoke video, even with a lyric line selected, whose karaoke rows can run', () => {
    const before = get().selection
    const line = Object.values(editor.getProject().clips).find((c) => c.type === 'text' && c.lyricLineId)!
    try {
      select({ type: 'clip', id: line.id })
      const ids = paletteResults('make a karaoke video').map((a) => a.id)
      expect(ids[0]).toBe('newProject.lyric')
      expect(ids.slice(1, 3)).toContain('karaokeFill')
    } finally {
      set({ selection: before })
    }
  })

  it('without WebGL 2, says so for what draws, and still edits a 3D camera move already on an image', () => {
    const before = get().selection
    const reason = (id: string) => actionsById.get(id)!.unavailable?.()
    const image = stillClips(editor.getProject())[0]!
    gpu.webgl2 = false
    try {
      const drawing = ['export', 'vj', 'vjRecord', 'vjMap', 'saveFrame', 'exportTeaser', 'exportLoop']
      for (const id of [...drawing, 'exportVertical', 'exportSquare', 'exportPortrait', 'exportLandscape'])
        expect(reason(id), id).toBe(NO_GRAPHICS_REASON)
      // Starting a project needs no drawing: its setup screen and the editor say what is missing.
      for (const id of ['newProject.lyric', 'newProject.blank']) expect(reason(id), id).toBeUndefined()

      select({ type: 'clip', id: image.id })
      expect(reason('cameraMove')).toBe(NO_GRAPHICS_REASON)
      expect(reason('behindClip')).toBe(NO_GRAPHICS_REASON)
      editor.dispatch({
        type: 'effect.add',
        clipId: image.id,
        effect: {
          id: 'move',
          effectId: CAMERA_EFFECT_ID,
          enabled: true,
          params: { preset: { value: 'dolly-in' }, intensity: { value: 0.4 } },
        },
        index: 0,
      })
      // A move already on the image is an edit of the project: its choices and strength still change it.
      expect(reason('cameraMove')).toBeUndefined()
      expect(reason('cameraStrength')).toBeUndefined()
      expect(reason('addDepth')).toBe(NO_GRAPHICS_REASON)
      gpu.webgl2 = true
      expect(reason('addDepth')).toBeUndefined()
      editor.undo()
    } finally {
      gpu.webgl2 = true
      set({ selection: before })
    }
  })

  it('ranks the director above every new project of a kind for a sentence that names no kind', () => {
    const ids = paletteResults('make a video for me').map((a) => a.id)
    expect(ids).toContain('director')
    expect(ids.slice(0, ids.indexOf('director')).filter((id) => id.startsWith('newProject.'))).toEqual([])
    expect(paletteResults('new lyric video')[0]?.id).toBe('newProject.lyric')
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
