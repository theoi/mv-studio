import { describe, expect, it } from 'vitest'
import { buildPlannerInput, compilePlan, directorMeta, planLocally } from '../../../src/director/index.ts'
import { titleCardCommands } from '../../../src/director/titleCard.ts'
import { frameWidth, textWidth } from '../../../src/director/typography.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { AspectPreset, Project, TextClip } from '../../../src/model/types.ts'
import { makeProject, SONG_ID } from './fixtures.ts'

/** An editor holding a lyric draft of a song whose file name gives the title card's title and artist. */
async function drafted(name = 'Josh Woodward - Show Me.mp3', aspect: AspectPreset = '16:9') {
  const project = makeProject()
  project.settings = { ...project.settings, aspect }
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

/** How much wider than the clip's wrap width its widest row is estimated to be, as a share of it (1: just fits). */
function widest(c: TextClip, aspect: AspectPreset) {
  const style = { ...c.style, uppercase: c.style.textTransform === 'uppercase' }
  const rows = c.text.split('\n').map((row) => textWidth(row, style, c.style.fontSize))
  return Math.max(...rows) / (c.style.maxWidth * frameWidth(aspect))
}

const LONG_TITLES = [
  'Neon Skyline (The Extended Midnight Club Remix Version)',
  'Neon Skyline Over The Endless City (feat. Mara Lane & Choir) [Extended Club Mix]',
]

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
    const base = directorMeta(shrunk)!.titleLayout!.base
    expect(shrunk.style.fontSize).toBeLessThan(base)
    retype(editor, shrunk, 'Blue Hour')
    const [title] = card(editor.getProject())
    expect(title.style.fontSize).toBe(base)
    expect(directorMeta(title)?.titleLayout).toMatchObject({ base, fitted: base })
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

  it.each(LONG_TITLES)(
    'keeps every row of “%s” within the clip’s width, clear of the artist',
    async (long) => {
      const editor = await drafted()
      retype(editor, card(editor.getProject())[0], long)
      const [title, artist] = card(editor.getProject())
      expect(widest(title, '16:9')).toBeLessThanOrEqual(1)
      expect(extent(artist).top - extent(title).bottom).toBeCloseTo(0.02, 3)
    },
  )

  it.each(
    LONG_TITLES.flatMap((long) => (['16:9', '9:16'] as const).map((aspect) => [long, aspect] as const)),
  )('drafts “%s” at %s with every row within the clip’s width', async (long, aspect) => {
    const [title, artist] = card((await drafted(`The Night Shift - ${long}.mp3`, aspect)).getProject())
    expect(title.text.replace(/\s+/g, ' ')).toBe(long)
    expect(widest(title, aspect)).toBeLessThanOrEqual(1)
    expect(widest(artist, aspect)).toBeLessThanOrEqual(1)
    expect(extent(artist).top - extent(title).bottom).toBeCloseTo(0.02, 2)
  })

  it('keeps a long title the user typed on four lines as typed', async () => {
    const editor = await drafted()
    const typed = 'Neon Skyline (The\nExtended\nMidnight Club\nRemix Version)'
    retype(editor, card(editor.getProject())[0], typed)
    const [title] = card(editor.getProject())
    expect(title.text).toBe(typed)
    expect(widest(title, '16:9')).toBeLessThanOrEqual(1)
  })

  it('starts a row with a phrase in brackets when the type stays as large', async () => {
    const editor = await drafted()
    retype(editor, card(editor.getProject())[0], 'Neon Skyline (Night Mix) [Extended Version]')
    expect(card(editor.getProject())[0].text).toBe('Neon Skyline\n(Night Mix)\n[Extended Version]')
  })

  it('leaves a row the user placed apart where it is, and lays out only the retyped row, about its own center', async () => {
    const editor = await drafted()
    const [title, artist] = card(editor.getProject())
    const place = (clip: TextClip, path: string, value: number) =>
      editor.dispatch({ type: 'clip.set', clipId: clip.id, path: ['transform', path, 'value'], value })
    place(artist, 'x', 0.2)
    place(artist, 'y', 0.9)
    retype(editor, title, 'Show Me Where The Long Road Ends Tonight')
    const [longer, apart] = card(editor.getProject())
    expect(longer.text).toContain('\n')
    expect(longer.transform.y.value).toBeCloseTo(title.transform.y.value, 3)
    expect([apart.transform.x.value, apart.transform.y.value]).toEqual([0.2, 0.9])

    const other = await drafted()
    const [above, below] = card(other.getProject())
    other.dispatch({ type: 'clip.set', clipId: above.id, path: ['transform', 'y', 'value'], value: 0.15 })
    retype(other, below, 'Josh Woodward And The Night Band')
    const [placed, artistAlone] = card(other.getProject())
    expect(placed.transform.y.value).toBe(0.15)
    // Laid out alone, the artist still shrinks on one row before it breaks.
    expect(artistAlone.text).not.toContain('\n')
  })

  it.each([
    ['Josh Woodward - Show Me.mp3', '16:9'],
    // Found again from rounded positions, these cards' centers are off by 0.001.
    ['Josh Woodward - Show Me Where The Long Road Ends Tonight.mp3', '9:16'],
    ['The Midnight Broadcasting Orchestra Of Somewhere Far - Neon Skyline.mp3', '1:1'],
  ] as const)('leaves an untouched card of “%s” at %s as it is', async (name, aspect) => {
    const project = (await drafted(name, aspect)).getProject()
    for (const row of card(project)) expect(titleCardCommands(project, row.id)).toEqual([])
  })
})
