import { describe, expect, it } from 'vitest'
import { buildPlannerInput, compilePlan, directorMeta, planLocally } from '../../../src/director/index.ts'
import { titleCardCommands } from '../../../src/director/titleCard.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { Project, TextClip } from '../../../src/model/types.ts'
import { makeProject, SONG_ID } from './fixtures.ts'

/** An editor holding a lyric draft of a song whose file name gives the title card's title and artist. */
async function drafted(name = 'Josh Woodward - Show Me.mp3') {
  const project = makeProject()
  project.assets[SONG_ID] = { ...project.assets[SONG_ID]!, name }
  const plan = await planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 5 }))
  const editor = new ProjectEditor(project)
  editor.dispatch(compilePlan(plan, project).commands)
  return editor
}

/** The title card's rows, title first. */
const card = (p: Project) =>
  Object.values(p.clips)
    .filter((c): c is TextClip => c.type === 'text' && directorMeta(c)?.textRole === 'title')
    .sort((a, b) => (directorMeta(a)?.titleRow ?? 0) - (directorMeta(b)?.titleRow ?? 0)) as [
    TextClip,
    TextClip,
  ]

/** Top and bottom of a text clip's rows, as fractions of the frame height. */
function extent(c: TextClip) {
  const height = (c.text.split('\n').length * c.style.lineHeight * c.style.fontSize) / 1080
  return { top: c.transform.y.value - height / 2, bottom: c.transform.y.value + height / 2 }
}

function retype(editor: ProjectEditor, clip: TextClip, text: string) {
  editor.dispatch({ type: 'clip.set', clipId: clip.id, path: ['text'], value: text })
  editor.dispatch(titleCardCommands(editor.getProject(), clip.id))
}

describe('a retyped title card', () => {
  it('breaks a longer title into rows that clear the artist, about the center the user moved the card to', async () => {
    const editor = await drafted()
    for (const row of card(editor.getProject()))
      editor.dispatch({
        type: 'clip.set',
        clipId: row.id,
        path: ['transform', 'y', 'value'],
        value: row.transform.y.value - 0.2,
      })
    const [before] = card(editor.getProject())
    expect(before.text).toBe('Show Me')
    retype(editor, before, 'Show Me Where The Long Road Ends Tonight')
    const [title, artist] = card(editor.getProject())
    expect(title.text).toContain('\n')
    expect(extent(artist).top - extent(title).bottom).toBeCloseTo(0.02, 3)
    expect((extent(title).top + extent(artist).bottom) / 2).toBeCloseTo(0.3, 2)
  })

  it('grows a title shrunk to fit back to the size it was laid out from once it is short again', async () => {
    const editor = await drafted('Ana Ruiz - Neon Skyline Over The Endless Burning City Lights Forever.mp3')
    const [shrunk] = card(editor.getProject())
    const base = directorMeta(shrunk)!.titleSize!.base
    expect(shrunk.style.fontSize).toBeLessThan(base)
    retype(editor, shrunk, 'Blue Hour')
    const [title] = card(editor.getProject())
    expect(title.style.fontSize).toBe(base)
    expect(directorMeta(title)?.titleSize).toEqual({ base, fitted: base })
  })

  it('keeps a size the user set, and line breaks the user typed where the rows fit', async () => {
    const editor = await drafted()
    const [title] = card(editor.getProject())
    editor.dispatch({ type: 'clip.set', clipId: title.id, path: ['style', 'fontSize'], value: 60 })
    retype(editor, title, 'Show\nMe Again')
    const [after, artist] = card(editor.getProject())
    expect(after).toMatchObject({ text: 'Show\nMe Again', style: { fontSize: 60 } })
    expect(extent(artist).top - extent(after).bottom).toBeCloseTo(0.02, 3)
  })

  it('shrinks a longer artist on one row before breaking it, and closes the card up about its center', async () => {
    const editor = await drafted()
    const [title, artist] = card(editor.getProject())
    retype(editor, artist, 'Josh Woodward And The Night Band')
    const [titleAfter, artistAfter] = card(editor.getProject())
    expect(artistAfter.text).not.toContain('\n')
    expect(artistAfter.style.fontSize).toBeLessThan(artist.style.fontSize)
    expect(titleAfter.transform.y.value).toBeGreaterThan(title.transform.y.value)
    expect(extent(artistAfter).top - extent(titleAfter).bottom).toBeCloseTo(0.02, 3)
    expect((extent(titleAfter).top + extent(artistAfter).bottom) / 2).toBeCloseTo(0.5, 2)
  })

  it('leaves a card with a row on a locked track, and any other clip, as it is', async () => {
    const editor = await drafted()
    const project = editor.getProject()
    const [title, artist] = card(project)
    const lyric = Object.values(project.clips).find((c) => directorMeta(c)?.textRole === 'lyric')!
    expect(titleCardCommands(project, lyric.id)).toEqual([])
    editor.dispatch({
      type: 'clip.set',
      clipId: title.id,
      path: ['text'],
      value: 'Show Me Where The Long Road Ends Tonight',
    })
    expect(titleCardCommands(editor.getProject(), title.id)).not.toEqual([])
    editor.dispatch({ type: 'track.update', trackId: artist.trackId, patch: { locked: true } })
    expect(titleCardCommands(editor.getProject(), title.id)).toEqual([])
  })
})
