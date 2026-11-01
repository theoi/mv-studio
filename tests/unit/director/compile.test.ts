import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  compilePlan,
  directorMeta,
  generationOptionsFor,
  planLocally,
  shotsToGenerate,
  type EditPlan,
} from '../../../src/director/index.ts'
import { BAND_EDGES_HZ } from '../../../src/analysis/features/features.ts'
import { planFrame } from '../../../src/engine/layout.ts'
import { describeReaction } from '../../../src/plugins/reactions.ts'
import { createFromTemplate, templateState } from '../../../src/plugins/templates.ts'
import { createTextClip, createTrack } from '../../../src/model/factory.ts'
import type { EditCommand } from '../../../src/model/commands.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { Asset, Clip, ImageClip, Project, TextClip, VideoClip } from '../../../src/model/types.ts'
import { fakeProvider, makeProject, SONG_ID, type FixtureOptions } from './fixtures.ts'

async function setup(kind: EditPlan['kind'] = 'beat-cut', fixture: FixtureOptions = {}, extra: object = {}) {
  const project = makeProject(fixture)
  const editor = new ProjectEditor(project)
  const plan = await planLocally(await buildPlannerInput(project, { kind, seed: 5, ...extra }))
  return { project, editor, plan }
}

const clips = (p: Project) => Object.values(p.clips)
const directorClips = (p: Project) => clips(p).filter((c) => directorMeta(c))

/** A project whose song file name gives a title and an artist, and the lyric draft's plan for it. */
async function titledDraft() {
  const project = makeProject()
  project.assets[SONG_ID] = { ...project.assets[SONG_ID]!, name: 'Josh Woodward - Show Me.mp3' }
  const editor = new ProjectEditor(project)
  const plan = await planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 5 }))
  return { project, editor, plan }
}

async function redraft(editor: ProjectEditor): Promise<Project> {
  const p = editor.getProject()
  const plan = await planLocally(await buildPlannerInput(p, { kind: 'lyric', seed: 9 }))
  editor.dispatch(compilePlan(plan, p).commands)
  return editor.getProject()
}

function renamedSong(p: Project, name: string): Project {
  return { ...p, assets: { ...p.assets, [SONG_ID]: { ...p.assets[SONG_ID]!, name } } }
}

const trackNamed = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!

/** The plan with a third title card shown with the title and artist, as a language model's plan can have. */
function withLive(plan: EditPlan): EditPlan {
  const artist = plan.texts.find((x) => x.text === 'Josh Woodward')!
  return { ...plan, texts: [...plan.texts, { ...artist, id: `${artist.id}-live`, text: 'Live', start: 1.1 }] }
}

/** Each title track, top to bottom, with the text on it. */
const titleRows = (p: Project) =>
  p.tracks
    .filter((track) => /^Titles/.test(track.name))
    .map((track) => [
      track.name,
      ...clips(p)
        .filter((c) => c.trackId === track.id)
        .map((c) => (c as TextClip).text),
    ])

describe('compilePlan', () => {
  it('applies a plan as one undo step that restores the project exactly', async () => {
    const { project, editor, plan } = await setup('lyric')
    const compiled = compilePlan(plan, project)
    editor.dispatch(compiled.commands, { label: compiled.label })
    const after = editor.getProject()
    const shots = plan.shots.length
    const texts = plan.texts.length
    // Shots, lyric lines, the look layer, and the song placed on the timeline.
    expect(clips(after)).toHaveLength(shots + texts + 1 + 1)
    expect(editor.undoLabel()).toBe(`Director: ${plan.title}`)
    // The title card has a track of its own, above the lyrics, and the shots go on the project's empty Video 1 track.
    expect(after.tracks.slice(0, 4).map((t) => t.name)).toEqual(['Titles', 'Text', 'Look', 'Video 1'])
    const titles = plan.texts.filter((t) => t.role === 'title')
    expect(titles.length).toBeGreaterThan(0)
    expect(clips(after).filter((c) => c.trackId === after.tracks[0]!.id)).toHaveLength(titles.length)
    editor.undo()
    expect(editor.getProject()).toEqual(project)
    expect(editor.canUndo()).toBe(false)
  })

  it('puts title cards that overlap in time on rows of their own, and a redraft keeps one row each', async () => {
    const { project, editor, plan } = await titledDraft()
    expect(plan.texts.filter((t) => t.role === 'title').map((t) => t.text)).toEqual([
      'Show Me',
      'Josh Woodward',
    ])
    const compiled = compilePlan(plan, project)
    editor.dispatch(compiled.commands)
    const after = editor.getProject()
    expect(titleRows(after)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    // Just below the Titles track, above the lyrics.
    expect(after.tracks.slice(0, 3).map((t) => t.name)).toEqual(['Titles', 'Titles 2', 'Text'])
    expect(compiled.stats.addedTracks).toBe(after.tracks.length - project.tracks.length)

    const redrafted = await redraft(editor)
    expect(titleRows(redrafted)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    expect(redrafted.tracks.map((t) => t.id)).toEqual(after.tracks.map((t) => t.id))

    // Without an artist, the second row goes with the earlier draft.
    const untitled = renamedSong(redrafted, 'Show Me.mp3')
    const once = new ProjectEditor(untitled)
    expect(titleRows(await redraft(once))).toEqual([['Titles', 'Show Me']])

    // Removed after the new tracks go in: the Text track again goes between the titles and the look.
    const noText = new ProjectEditor(untitled)
    noText.dispatch([{ type: 'track.remove', trackId: trackNamed(untitled, 'Text').id }])
    const relyric = await redraft(noText)
    expect(relyric.tracks.slice(0, 3).map((t) => t.name)).toEqual(['Titles', 'Text', 'Look'])
  })

  it('reuses the title rows the user changed on a redraft, and names a new row so no two are alike', async () => {
    const drafted = async () => {
      const { project, editor, plan } = await titledDraft()
      editor.dispatch(compilePlan(plan, project).commands)
      const p = editor.getProject()
      const artist = clips(p).find((c) => (c as TextClip).text === 'Josh Woodward')!
      const title = clips(p).find((c) => (c as TextClip).text === 'Show Me')!
      return { editor, p, artist, title, titles: trackNamed(p, 'Titles'), second: trackNamed(p, 'Titles 2') }
    }

    // The user deleted the artist: the emptied row takes the new one.
    let d = await drafted()
    d.editor.dispatch([{ type: 'clip.remove', clipIds: [d.artist.id] }])
    let after = await redraft(d.editor)
    expect(titleRows(after)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    expect(after.tracks.map((t) => t.id)).toEqual(d.p.tracks.map((t) => t.id))

    // The user dragged the artist onto Titles: Titles keeps the first row, and the emptied Titles 2 the artist.
    d = await drafted()
    d.editor.dispatch([
      { type: 'clip.move', moves: [{ clipId: d.artist.id, start: d.artist.start, trackId: d.titles.id }] },
    ])
    after = await redraft(d.editor)
    expect(titleRows(after)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    expect(after.tracks.map((t) => t.id)).toEqual(d.p.tracks.map((t) => t.id))

    // The user pasted a copy of the artist on a track of its own: one row still takes the artist.
    d = await drafted()
    const copyTrack = createTrack('visual', 'Copy')
    d.editor.dispatch([
      { type: 'track.add', track: copyTrack, index: 2 },
      { type: 'clip.add', clip: { ...d.artist, id: 'pasted-artist', trackId: copyTrack.id } },
    ])
    after = await redraft(d.editor)
    expect(titleRows(after)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    expect(after.tracks.map((t) => t.id)).toEqual(d.p.tracks.map((t) => t.id))

    // The user hid the artist's row and pasted a copy of the song's title onto it: it stays the artist's, hidden.
    d = await drafted()
    d.editor.dispatch([
      { type: 'track.update', trackId: d.second.id, patch: { hidden: true } },
      { type: 'clip.add', clip: { ...d.title, id: 'pasted-title', trackId: d.second.id, start: 10 } },
    ])
    after = await redraft(d.editor)
    expect(titleRows(after)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    expect(after.tracks.map((t) => t.id)).toEqual(d.p.tracks.map((t) => t.id))
    expect(after.tracks.find((t) => t.id === d.second.id)?.hidden).toBe(true)

    // The user hid the artist's row: it stays hidden.
    d = await drafted()
    d.editor.dispatch([{ type: 'track.update', trackId: d.second.id, patch: { hidden: true } }])
    after = await redraft(d.editor)
    expect(titleRows(after)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    expect(after.tracks.find((t) => t.id === d.second.id)?.hidden).toBe(true)
    expect(after.tracks).toHaveLength(d.p.tracks.length)

    // The user's own text on Titles: the song's title gets a new row above Titles 2, which keeps the artist.
    d = await drafted()
    d.editor.dispatch([
      {
        type: 'clip.add',
        clip: createTextClip({ trackId: d.titles.id, text: 'Mine', start: 30, duration: 2 }),
      },
    ])
    expect(titleRows(await redraft(d.editor))).toEqual([
      ['Titles', 'Mine'],
      ['Titles 3', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])

    // The user's own text on Titles 2: a Titles 3 goes in just below Titles.
    d = await drafted()
    d.editor.dispatch([
      {
        type: 'clip.add',
        clip: createTextClip({ trackId: d.second.id, text: 'Mine', start: 30, duration: 2 }),
      },
    ])
    expect(titleRows(await redraft(d.editor))).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 3', 'Josh Woodward'],
      ['Titles 2', 'Mine'],
    ])

    // Titles locked with the earlier title on it: the new title gets a row of its own, the artist stays on Titles 2.
    d = await drafted()
    d.editor.dispatch([{ type: 'track.update', trackId: d.titles.id, patch: { locked: true } }])
    expect(titleRows(await redraft(d.editor))).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 3', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
  })

  it('names the draft’s title rows around a Titles track the user already has', async () => {
    const { editor, plan } = await titledDraft()
    const mine = createTrack('visual', 'Titles')
    editor.dispatch([
      { type: 'track.add', track: mine, index: 0 },
      { type: 'clip.add', clip: createTextClip({ trackId: mine.id, text: 'Mine', start: 30, duration: 2 }) },
    ])
    editor.dispatch(compilePlan(plan, editor.getProject()).commands)
    expect(titleRows(editor.getProject())).toEqual([
      ['Titles 2', 'Show Me'],
      ['Titles 3', 'Josh Woodward'],
      ['Titles', 'Mine'],
    ])
  })

  it('gives each further title row back its own track on a redraft, by row', async () => {
    const { project, editor, plan } = await titledDraft()
    editor.dispatch(compilePlan(withLive(plan), project).commands)
    const p = editor.getProject()
    expect(titleRows(p)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
      ['Titles 3', 'Live'],
    ])
    // The user's text on Titles 2 keeps the artist off it; Titles 3 still takes the third card.
    editor.dispatch([
      {
        type: 'clip.add',
        clip: createTextClip({ trackId: trackNamed(p, 'Titles 2').id, text: 'Mine', start: 30, duration: 2 }),
      },
    ])
    const mine = editor.getProject()
    const again = await planLocally(await buildPlannerInput(mine, { kind: 'lyric', seed: 9 }))
    editor.dispatch(compilePlan(withLive(again), mine).commands)
    expect(titleRows(editor.getProject())).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 4', 'Josh Woodward'],
      ['Titles 2', 'Mine'],
      ['Titles 3', 'Live'],
    ])
  })

  it('never gives a row kept for a later title card to an earlier one on a redraft', async () => {
    const { project, editor, plan } = await titledDraft()
    editor.dispatch(compilePlan(withLive(plan), project).commands)
    // The user deleted the artist's track, so the third card's sits just below Titles.
    editor.dispatch([{ type: 'track.remove', trackId: trackNamed(editor.getProject(), 'Titles 2').id }])
    const deleted = editor.getProject()
    const again = await planLocally(await buildPlannerInput(deleted, { kind: 'lyric', seed: 9 }))
    editor.dispatch(compilePlan(withLive(again), deleted).commands)
    expect(titleRows(editor.getProject())).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
      ['Titles 3', 'Live'],
    ])
  })

  it('keeps each title card on its own row on a redraft when the user hid the artist and put text on Titles', async () => {
    const { project, editor, plan } = await titledDraft()
    editor.dispatch(compilePlan(plan, project).commands)
    const p = editor.getProject()
    const second = trackNamed(p, 'Titles 2')
    editor.dispatch([
      { type: 'track.update', trackId: second.id, patch: { hidden: true } },
      {
        type: 'clip.add',
        clip: createTextClip({ trackId: trackNamed(p, 'Titles').id, text: 'Mine', start: 0, duration: 4 }),
      },
    ])
    const after = await redraft(editor)
    expect(titleRows(after)).toEqual([
      ['Titles', 'Mine'],
      ['Titles 3', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    // The song's title stays in view and the artist stays hidden.
    expect(trackNamed(after, 'Titles 3').hidden).toBe(false)
    expect(after.tracks.find((t) => t.id === second.id)?.hidden).toBe(true)
  })

  it.each([
    ['locked', { locked: true }, 'Titles 2', 'Titles 3'],
    ['named for something else', { name: 'Extras 2' }, 'Extras 2', 'Titles 2'],
    ['named without a number', { name: 'Titles B' }, 'Titles B', 'Titles 2'],
  ])(
    'leaves an emptied row below Titles that is %s, adding a new row for the artist',
    async (_, patch, kept, added) => {
      const { project, editor, plan } = await titledDraft()
      editor.dispatch(compilePlan(plan, project).commands)
      const p = editor.getProject()
      const artist = clips(p).find((c) => (c as TextClip).text === 'Josh Woodward')!
      editor.dispatch([
        { type: 'clip.remove', clipIds: [artist.id] },
        { type: 'track.update', trackId: artist.trackId, patch },
      ])
      const after = await redraft(editor)
      expect(after.tracks.slice(0, 3).map((t) => t.name)).toEqual(['Titles', added, kept])
      expect(clips(after).filter((c) => c.trackId === artist.trackId)).toEqual([])
      expect(
        clips(after)
          .filter((c) => c.trackId === trackNamed(after, added).id)
          .map((c) => (c as TextClip).text),
      ).toEqual(['Josh Woodward'])
    },
  )

  it.each(['Titles', 'Text'])(
    'puts the shots on a track of their own on a redraft after the user deleted every visual track but %s',
    async (kept) => {
      const { project, editor, plan } = await titledDraft()
      editor.dispatch(compilePlan(plan, project).commands)
      const p = editor.getProject()
      editor.dispatch(
        p.tracks
          .filter((t) => t.kind === 'visual' && t.name !== kept)
          .map((t): EditCommand => ({ type: 'track.remove', trackId: t.id })),
      )
      const after = await redraft(editor)
      expect(after.tracks.map((t) => t.name)).toEqual(['Titles', 'Titles 2', 'Text', 'Look', 'Shots', 'Song'])
      const shots = directorClips(after).filter((c) => directorMeta(c)!.role === 'shots')
      expect(shots.length).toBeGreaterThan(0)
      expect(shots.every((c) => c.trackId === trackNamed(after, 'Shots').id)).toBe(true)
    },
  )

  it('removes the earlier title rows on a redraft without title cards, never putting the shots on one', async () => {
    const { project, editor, plan } = await titledDraft()
    editor.dispatch(compilePlan(plan, project).commands)
    // The user deleted every visual track but the titles.
    const p = editor.getProject()
    editor.dispatch(
      p.tracks
        .filter((t) => t.kind === 'visual' && !t.name.startsWith('Titles'))
        .map((t): EditCommand => ({ type: 'track.remove', trackId: t.id })),
    )
    const titlesOnly = editor.getProject()
    const beatCut = await planLocally(await buildPlannerInput(titlesOnly, { kind: 'beat-cut', seed: 1 }))
    expect(beatCut.texts).toHaveLength(0)
    editor.dispatch(compilePlan(beatCut, titlesOnly).commands)
    const after = editor.getProject()
    expect(after.tracks.map((t) => t.name)).toEqual(['Look', 'Shots', 'Song'])
    expect(directorClips(after).filter((c) => directorMeta(c)!.role === 'shots').length).toBeGreaterThan(0)
  })

  it('puts the shots on a new project’s empty Video 1 track, so no empty track is left under the draft', async () => {
    const { project, editor, plan } = await setup('ai')
    const video = project.tracks.find((t) => t.kind === 'visual')!
    expect(clips(project).filter((c) => c.trackId === video.id)).toHaveLength(0)
    const compiled = compilePlan(plan, project)
    editor.dispatch(compiled.commands)
    const after = editor.getProject()
    const shots = directorClips(after).filter((c) => directorMeta(c)!.role === 'shots')
    expect(shots.length).toBe(plan.shots.filter((s) => s.layer === 'main').length)
    expect(shots.every((c) => c.trackId === video.id)).toBe(true)
    expect(
      after.tracks.filter((t) => t.kind === 'visual' && !clips(after).some((c) => c.trackId === t.id)),
    ).toEqual([])
    expect(after.tracks.map((t) => t.name)).not.toContain('Shots')
    editor.undo()
    expect(editor.getProject()).toEqual(project)
  })

  it('leaves a new project’s Video 1 track alone when it is locked, hidden or the user has clips on a visual track', async () => {
    const { project, plan } = await setup('ai')
    const video = project.tracks.find((t) => t.kind === 'visual')!
    const mine = createTextClip({ trackId: video.id, text: 'Mine', start: 1, duration: 2 })
    const other = createTrack('visual', 'My titles')
    const theirs = createTextClip({ trackId: other.id, text: 'Theirs', start: 1, duration: 2 })
    const variants: Project[] = [
      { ...project, tracks: project.tracks.map((t) => (t.id === video.id ? { ...t, locked: true } : t)) },
      { ...project, tracks: project.tracks.map((t) => (t.id === video.id ? { ...t, hidden: true } : t)) },
      { ...project, clips: { [mine.id]: mine } },
      {
        ...project,
        tracks: project.tracks.flatMap((t) => (t.id === video.id ? [t, other] : [t])),
        clips: { [theirs.id]: theirs },
      },
    ]
    for (const variant of variants) {
      const editor = new ProjectEditor(variant)
      editor.dispatch(compilePlan(plan, variant).commands)
      const after = editor.getProject()
      expect(after.tracks.map((t) => t.name)).toContain('Shots')
      expect(
        clips(after).filter((c) => c.trackId === video.id && directorMeta(c)?.role === 'shots'),
      ).toHaveLength(0)
    }
  })

  it('keeps title cards that follow one another on one row', async () => {
    const { project, editor, plan } = await setup('lyric')
    const [title] = plan.texts.filter((t) => t.role === 'title')
    expect(title).toBeDefined()
    const texts = [
      { ...title!, id: 'a', text: 'First', start: 0.5, end: 2 },
      { ...title!, id: 'b', text: 'Second', start: 2, end: 4 },
      ...plan.texts.filter((t) => t.role !== 'title'),
    ]
    editor.dispatch(compilePlan({ ...plan, texts }, project).commands)
    const after = editor.getProject()
    expect(after.tracks.filter((t) => /^Titles/.test(t.name)).map((t) => t.name)).toEqual(['Titles'])
    expect(
      clips(after)
        .filter((c) => c.trackId === after.tracks[0]!.id)
        .map((c) => (c as TextClip).text),
    ).toEqual(['First', 'Second'])
  })

  it('hides the user’s tracks under full-frame shots in the same undo step, deleting nothing', async () => {
    const { project: base, plan } = await setup('beat-cut')
    const editor = new ProjectEditor(base)
    const track = createTrack('visual', 'My titles')
    editor.dispatch([
      { type: 'track.add', track },
      { type: 'clip.add', clip: createTextClip({ trackId: track.id, start: 2, duration: 4, text: 'Mine' }) },
    ])
    const empty = editor.getProject().tracks.find((t) => t.kind === 'visual' && t.id !== track.id)
    const project = editor.getProject()
    const compiled = compilePlan(plan, project)
    expect(compiled.stats.hiddenTracks).toEqual([track.id])
    editor.dispatch(compiled.commands, { label: compiled.label })
    const after = editor.getProject()
    expect(after.tracks.find((t) => t.id === track.id)?.hidden).toBe(true)
    // Tracks with nothing on them are left as they are.
    if (empty) expect(after.tracks.find((t) => t.id === empty.id)?.hidden).toBe(false)
    expect(clips(after).some((c) => c.type === 'text' && c.text === 'Mine')).toBe(true)
    editor.undo()
    expect(editor.getProject()).toEqual(project)
  })

  it('turns plan shots into clips with the planned timing, source window and mute', async () => {
    const { project, editor, plan } = await setup('beat-cut')
    editor.dispatch(compilePlan(plan, project).commands)
    const after = editor.getProject()
    const byShot = new Map(directorClips(after).map((c) => [directorMeta(c)!.shotId, c]))
    for (const shot of plan.shots) {
      const clip = byShot.get(shot.id) as VideoClip
      expect(clip.start).toBeCloseTo(shot.start, 3)
      expect(clip.duration).toBeCloseTo(shot.end - shot.start, 3)
      if (shot.source.type === 'media') {
        expect(clip.assetId).toBe(shot.source.assetId)
        expect(clip.sourceStart).toBeCloseTo(shot.source.sourceStart ?? 0, 3)
        expect(clip.muted).toBe(true)
      }
    }
  })

  it('adds camera moves to stills and beat pulses as audio modulation', async () => {
    const { project, editor, plan } = await setup('beat-cut', { videos: 0, images: 3 })
    editor.dispatch(compilePlan(plan, project).commands)
    const after = editor.getProject()
    const pushIn = plan.shots.find((s) => s.motion === 'push-in')!
    const image = directorClips(after).find((c) => directorMeta(c)!.shotId === pushIn.id) as ImageClip
    expect(image.type).toBe('image')
    expect(image.transform.scaleX.keyframes?.map((k) => [k.time, k.value])).toEqual([
      [0, 1],
      [image.duration, 1.12],
    ])
    const pulsing = plan.shots.find((s) => s.reactive?.some((r) => r.target === 'scale'))!
    const clip = directorClips(after).find((c) => directorMeta(c)!.shotId === pulsing.id) as ImageClip
    expect(clip.transform.scaleY.modulation?.[0]).toMatchObject({
      source: { kind: 'beat' },
      mode: 'multiply',
    })
  })

  it('writes music reactions the way the reaction picker does, with chorus particles on their own track', async () => {
    const { project, editor, plan } = await setup('visualizer', { videos: 0 })
    editor.dispatch(compilePlan(plan, project).commands)
    const after = editor.getProject()
    const shot = plan.shots.find((s) => s.reactions?.length)!
    const clip = directorClips(after).find((c) => directorMeta(c)!.shotId === shot.id)!
    const active = describeReaction(after, { clipId: clip.id, property: 'scale' })
    expect(active).toMatchObject({ kind: 'reaction', reaction: { id: 'kick' }, exact: true })
    expect(active?.kind === 'reaction' && active.amount).toBeCloseTo(shot.reactions![0]!.amount, 5)
    const names = after.tracks.map((t) => t.name)
    expect(names.indexOf('Accents')).toBeGreaterThan(names.indexOf('Look'))
    expect(names.indexOf('Accents')).toBeLessThan(names.indexOf('Overlay'))
  })

  it('links lyric text to lyric lines and keeps it above the look layer', async () => {
    const { project, editor, plan } = await setup('lyric')
    editor.dispatch(compilePlan(plan, project).commands)
    const after = editor.getProject()
    const texts = clips(after).filter((c): c is TextClip => c.type === 'text')
    // Emphasized words keep their line in the plan but are timed by their own start, unlinked.
    expect(plan.texts.some((t) => t.role === 'emphasis' && t.lyricLineId)).toBe(true)
    expect(texts.map((t) => t.lyricLineId)).toEqual(
      plan.texts.map((t) => (t.role === 'emphasis' ? undefined : t.lyricLineId)),
    )
    const lyrics = texts.filter((t) => t.lyricLineId)
    expect(lyrics.length).toBeGreaterThan(0)
    expect(lyrics.every((t) => t.karaoke?.mode === 'word')).toBe(true)
    const textTrack = after.tracks.findIndex((t) => t.id === texts[0]!.trackId)
    const look = clips(after).find((c) => c.type === 'adjustment')!
    expect(textTrack).toBeLessThan(after.tracks.findIndex((t) => t.id === look.trackId))
  })

  it('lays out as engine cross-transitions between neighbouring shots', async () => {
    const { project, editor, plan } = await setup('beat-cut')
    editor.dispatch(compilePlan(plan, project).commands)
    const after = editor.getProject()
    const main = plan.shots.filter((s) => s.layer === 'main')
    const withTransition = main.find((s, i) => i > 0 && s.transitionIn)!
    const previous = main[main.indexOf(withTransition) - 1]!
    const layers = planFrame(after, withTransition.start + 0.01)
    const transition = layers.find((l) => l.kind === 'transition')
    if (!transition || transition.kind !== 'transition') throw new Error('expected a transition layer')
    expect(transition.to && directorMeta(transition.to)?.shotId).toBe(withTransition.id)
    expect(transition.from && directorMeta(transition.from)?.shotId).toBe(previous.id)
    // The look layer applies on top of the shots.
    expect(layers[layers.length - 1]?.kind).toBe('adjustment')
  })

  it('replaces the previous draft and leaves the user clips alone', async () => {
    const { project, editor, plan } = await setup('beat-cut')
    const userTrack = project.tracks.find((t) => t.kind === 'visual')!
    const userClip = createTextClip({ trackId: userTrack.id, text: 'Mine', start: 1, duration: 2 })
    editor.dispatch({ type: 'clip.add', clip: userClip })
    editor.dispatch(compilePlan(plan, editor.getProject()).commands)
    const first = editor.getProject()
    const second = await planLocally(await buildPlannerInput(first, { kind: 'beat-cut', seed: 9 }))
    const compiled = compilePlan(second, first)
    editor.dispatch(compiled.commands)
    const after = editor.getProject()
    expect(compiled.stats.removedClips).toBe(
      directorClips(first).filter((c) => directorMeta(c)!.role !== 'song').length,
    )
    expect(after.tracks).toHaveLength(first.tracks.length)
    expect(after.clips[userClip.id]).toEqual(userClip)
    const planIds = new Set(
      directorClips(after)
        .filter((c) => directorMeta(c)!.role !== 'song')
        .map((c) => directorMeta(c)!.planId),
    )
    expect([...planIds]).toEqual([second.id])
    expect(clips(after).filter((c) => c.type === 'audio')).toHaveLength(1)
  })

  it('removes director tracks the new draft no longer needs', async () => {
    const { project, editor, plan } = await setup('lyric')
    editor.dispatch(compilePlan(plan, project).commands)
    const first = editor.getProject()
    const beatCut = await planLocally(await buildPlannerInput(first, { kind: 'beat-cut', seed: 1 }))
    expect(beatCut.texts).toHaveLength(0)
    editor.dispatch(compilePlan(beatCut, first).commands)
    const names = editor.getProject().tracks.map((t) => t.name)
    expect(names).not.toContain('Text')
    expect(names.filter((n) => n === 'Video 1')).toHaveLength(1)
    expect(names).not.toContain('Shots')
  })

  it('keeps earlier director clips on locked tracks and says so', async () => {
    const { project, editor, plan } = await setup('beat-cut')
    editor.dispatch(compilePlan(plan, project).commands)
    const first = editor.getProject()
    const shotsTrack = first.tracks.find((t) =>
      directorClips(first).some((c) => c.trackId === t.id && directorMeta(c)!.role === 'shots'),
    )!
    editor.dispatch({ type: 'track.update', trackId: shotsTrack.id, patch: { locked: true } })
    const compiled = compilePlan(plan, editor.getProject())
    editor.dispatch(compiled.commands)
    const after = editor.getProject()
    expect(clips(after).filter((c) => c.trackId === shotsTrack.id)).toHaveLength(plan.shots.length)
    expect(compiled.warnings.some((w) => w.includes('locked'))).toBe(true)
  })

  it('leaves out effects and transitions the catalog does not have', async () => {
    const { project, plan } = await setup('beat-cut')
    const edited: EditPlan = {
      ...plan,
      shots: plan.shots.map((s, i) =>
        i === 1
          ? {
              ...s,
              effects: [{ effectId: 'warp-drive' }, { effectId: 'glow' }],
              transitionIn: { kind: 'teleport', duration: 0.3 },
            }
          : s,
      ),
    }
    const compiled = compilePlan(edited, project)
    const editor = new ProjectEditor(project)
    editor.dispatch(compiled.commands)
    const clip = directorClips(editor.getProject()).find(
      (c) => directorMeta(c)!.shotId === plan.shots[1]!.id,
    ) as VideoClip
    expect(clip.effects.map((e) => e.effectId)).toEqual(['glow'])
    expect(clip.transitionIn).toBeUndefined()
    expect(compiled.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('warp-drive'), expect.stringContaining('teleport')]),
    )
  })

  it('shows placeholders for AI shots until they are generated, then uses the generated media', async () => {
    const provider = fakeProvider()
    const generation = generationOptionsFor(provider, { mode: 'images', tier: 'draft' })!
    const { project, plan } = await setup('ai', { videos: 0 }, { generation })
    const pending = compilePlan(plan, project)
    expect(pending.stats.placeholders).toBe(plan.shots.length)
    const toMake = shotsToGenerate(plan).length
    expect(toMake).toBeLessThan(plan.shots.length)
    expect(pending.warnings).toContain(
      `${toMake} AI shots are not generated yet; dark placeholders mark where they go.`,
    )
    const placeholder = pending.commands.find((c) => c.type === 'clip.add' && directorMeta(c.clip)?.pending)
    expect(placeholder && placeholder.type === 'clip.add' && placeholder.clip.type).toBe('solid')

    const generated = new Map<string, Asset>(
      shotsToGenerate(plan).map((s, i) => [
        s.id,
        {
          id: `gen-${i}`,
          kind: 'image',
          name: `AI ${i}`,
          mimeType: 'image/jpeg',
          byteSize: 10,
          storageKey: `media/gen-${i}`,
          origin: { type: 'generated', provider: s.source.modelId, prompt: s.source.prompt },
          createdAt: new Date(0).toISOString(),
        },
      ]),
    )
    const compiled = compilePlan(plan, project, { generated })
    const editor = new ProjectEditor(project)
    editor.dispatch(compiled.commands)
    const after = editor.getProject()
    expect(compiled.stats.placeholders).toBe(0)
    expect(Object.keys(after.assets).filter((id) => id.startsWith('gen-'))).toHaveLength(generated.size)
    const images = clips(after).filter((c): c is ImageClip => c.type === 'image')
    expect(images).toHaveLength(plan.shots.length)
    // Chorus repeats reuse the first chorus' pictures instead of new ones.
    const sameAs = plan.shots.find((s) => s.source.type === 'generate' && s.source.sameAs)!
    const target = sameAs.source.type === 'generate' ? sameAs.source.sameAs! : ''
    const clipOf = (shotId: string) => images.find((c) => directorMeta(c)!.shotId === shotId)!
    expect(clipOf(sameAs.id).assetId).toBe(clipOf(target).assetId)
  })

  it('drives effect parameters from band analysis when the song has it', async () => {
    const { project, plan } = await setup('beat-cut')
    const withBands: Project = {
      ...project,
      analysis: {
        ...project.analysis,
        audio: {
          [SONG_ID]: {
            ...project.analysis.audio[SONG_ID]!,
            features: {
              rate: 10,
              loudness: [0],
              bands: [BAND_EDGES_HZ.slice(1).map(() => 0)],
              bandEdgesHz: BAND_EDGES_HZ,
              onsets: [],
            },
          },
        },
      },
    }
    const edited: EditPlan = {
      ...plan,
      shots: plan.shots.map((s, i) =>
        i === 0
          ? {
              ...s,
              effects: [{ effectId: 'glow', react: [{ param: 'intensity', source: 'bass', amount: 0.5 }] }],
            }
          : s,
      ),
    }
    const add = compilePlan(edited, withBands).commands.find(
      (c): c is Extract<typeof c, { type: 'clip.add' }> =>
        c.type === 'clip.add' && directorMeta(c.clip)?.shotId === plan.shots[0]!.id,
    )!
    const clip = add.clip as Clip & { effects: VideoClip['effects'] }
    const mod = clip.effects[0]!.params.intensity!.modulation![0]!
    // Band 1 is the analysis' 60-250 Hz bass band.
    expect(mod.source).toEqual({ kind: 'band', band: 1 })
    // Amount scales with the parameter range (glow intensity is 0..4).
    expect(mod.amount).toBeCloseTo(2, 6)
  })
})

describe('a title card the user corrected', () => {
  const textOf = (p: Project, text: string) => clips(p).find((c) => (c as TextClip).text === text)!
  const setText = (editor: ProjectEditor, text: string, to: string) =>
    editor.dispatch({
      type: 'clip.set',
      clipId: textOf(editor.getProject(), text).id,
      path: ['text'],
      value: to,
    })

  it('keeps the title and artist the user typed on it through later drafts of the song', async () => {
    const { project, editor, plan } = await titledDraft()
    editor.dispatch(compilePlan(plan, project).commands)
    setText(editor, 'Show Me', 'Show Me (Live)')
    setText(editor, 'Josh Woodward', 'J. Woodward')
    const fixed = [
      ['Titles', 'Show Me (Live)'],
      ['Titles 2', 'J. Woodward'],
    ]
    expect(titleRows(await redraft(editor))).toEqual(fixed)
    // The redraft's card shows the correction it read, and the one after reads it again from that card.
    expect(titleRows(await redraft(editor))).toEqual(fixed)
  })

  it('keeps a correction when a copy of the card still shows the song’s own title', async () => {
    const { project, editor, plan } = await titledDraft()
    editor.dispatch(compilePlan(plan, project).commands)
    const card = textOf(editor.getProject(), 'Show Me')
    // Pasted copies keep the card's Director tag.
    editor.dispatch({ type: 'clip.add', clip: { ...card, id: 'pasted-title', start: 20 } })
    setText(editor, 'Show Me', 'Show Me (Live)')
    expect((await buildPlannerInput(editor.getProject(), { kind: 'lyric' })).song.title).toBe(
      'Show Me (Live)',
    )
  })

  describe('takes nothing the user typed on a copy of the card', () => {
    /** A copy of the card showing `text` at `start`, as duplicating or pasting it makes (keeping its tag). */
    const copy = (editor: ProjectEditor, of: string, text: string, start: number) =>
      editor.dispatch({
        type: 'clip.add',
        clip: { ...(textOf(editor.getProject(), of) as TextClip), id: `copy-${start}`, start, text },
      })
    const songAfter = async (editor: ProjectEditor) =>
      (await buildPlannerInput(editor.getProject(), { kind: 'lyric' })).song

    it('a duplicated title retyped as a chapter title', async () => {
      const { project, editor, plan } = await titledDraft()
      editor.dispatch(compilePlan(plan, project).commands)
      const card = textOf(editor.getProject(), 'Show Me')
      copy(editor, 'Show Me', 'Chapter 2', card.start + card.duration)
      expect((await songAfter(editor)).title).toBe('Show Me')
    })

    it('a later copy over a real correction on the card', async () => {
      const { project, editor, plan } = await titledDraft()
      editor.dispatch(compilePlan(plan, project).commands)
      setText(editor, 'Show Me', 'Show Me (Live)')
      copy(editor, 'Show Me (Live)', 'Thanks for watching', 60)
      expect((await songAfter(editor)).title).toBe('Show Me (Live)')
    })

    it('a retyped copy of the artist', async () => {
      const { project, editor, plan } = await titledDraft()
      editor.dispatch(compilePlan(plan, project).commands)
      copy(editor, 'Josh Woodward', 'Directed by Ana Ruiz', 30)
      expect(await songAfter(editor)).toMatchObject({ title: 'Show Me', artist: 'Josh Woodward' })
    })
  })

  it('reads a title the draft broke over two lines as the song’s own', async () => {
    const long = renamedSong(makeProject(), 'Josh Woodward - Show Me Where The Long Road Ends Tonight.mp3')
    const plan = await planLocally(await buildPlannerInput(long, { kind: 'lyric', seed: 5 }))
    const drafted = new ProjectEditor(long)
    drafted.dispatch(compilePlan(plan, long).commands)
    const card = clips(drafted.getProject()).find((c) => directorMeta(c)?.textRole === 'title')! as TextClip
    expect(card.text).toContain('\n')
    const input = await buildPlannerInput(drafted.getProject(), { kind: 'lyric', seed: 9 })
    expect(input.song.title).toBe('Show Me Where The Long Road Ends Tonight')
  })

  it('takes nothing from a card of another song, or from one drafted before cards recorded their song', async () => {
    const { project, editor, plan } = await titledDraft()
    editor.dispatch(compilePlan(plan, project).commands)
    setText(editor, 'Show Me', 'Show Me (Live)')
    const fixed = editor.getProject()
    expect((await buildPlannerInput(fixed, { kind: 'lyric' })).song.title).toBe('Show Me (Live)')

    const other: Asset = { ...fixed.assets[SONG_ID]!, id: 'other-song', name: 'Ana Ruiz - Blue Hour.mp3' }
    const switched = new ProjectEditor(fixed)
    switched.dispatch([
      { type: 'asset.add', asset: other },
      { type: 'project.setSong', assetId: other.id },
    ])
    expect((await buildPlannerInput(switched.getProject(), { kind: 'lyric' })).song).toMatchObject({
      title: 'Blue Hour',
      artist: 'Ana Ruiz',
    })

    const older = structuredClone(fixed)
    for (const c of Object.values(older.clips))
      delete (c.meta?.director as { songId?: string } | undefined)?.songId
    expect((await buildPlannerInput(older, { kind: 'lyric' })).song.title).toBe('Show Me')
  })

  it('never takes a further title card of a song without an artist as its artist', async () => {
    const plain = renamedSong(makeProject(), 'Show Me.mp3')
    const single = await planLocally(await buildPlannerInput(plain, { kind: 'lyric', seed: 5 }))
    // A language model's plan with a second card shown with the title, where there is no artist.
    const title = single.texts.find((x) => x.role === 'title')!
    const withSubtitle = {
      ...single,
      texts: [...single.texts, { ...title, id: 'subtitle', text: 'Live', start: 0.8 }],
    }
    const drafted = new ProjectEditor(plain)
    drafted.dispatch(compilePlan(withSubtitle, plain).commands)
    expect(titleRows(drafted.getProject())).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Live'],
    ])
    expect((await buildPlannerInput(drafted.getProject(), { kind: 'lyric' })).song.artist).toBeUndefined()
  })
})

describe('compilePlan in a project made from a starter template', () => {
  /** The AI starter template with the fixture's song, analysis, footage and lyrics, before anything is placed. */
  function templateProject(): Project {
    const base = makeProject()
    const template = createFromTemplate('ai', {
      song: base.assets[SONG_ID]!,
      analysis: base.analysis.audio[SONG_ID]!,
    })
    return {
      ...template,
      assets: { ...base.assets, ...template.assets },
      analysis: { ...template.analysis, visual: base.analysis.visual },
      ...(base.lyrics ? { lyrics: base.lyrics } : {}),
    }
  }
  const looks = (p: Project) => clips(p).filter((c) => c.type === 'adjustment')

  it('puts the draft on the template’s tracks and replaces its look, in one undo step and again on a redraft', async () => {
    const project = templateProject()
    const template = templateState(project)!
    const editor = new ProjectEditor(project)
    expect(looks(project)).toHaveLength(1)
    const lookTrack = looks(project)[0]!.trackId

    const plan = await planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 5 }))
    const compiled = compilePlan(plan, project)
    editor.dispatch(compiled.commands, { label: compiled.label })
    const after = editor.getProject()
    const onTrack = (id: string | undefined) => clips(after).filter((c) => c.trackId === id)
    const lyricTexts = (p: typeof plan) => p.texts.filter((t) => t.role !== 'title').length
    expect(onTrack(template.tracks.lyrics).length).toBe(lyricTexts(plan))
    expect(onTrack(template.tracks.lyrics).every((c) => directorMeta(c)?.role === 'text')).toBe(true)
    // The AI template has no Titles track, so the title card gets one above the lyrics instead of joining them.
    const titles = after.tracks[0]!
    expect(titles.name).toBe('Titles')
    expect(onTrack(titles.id).map((c) => directorMeta(c)?.textRole)).toEqual(
      plan.texts.filter((t) => t.role === 'title').map(() => 'title'),
    )
    expect(onTrack(titles.id).length).toBeGreaterThan(0)
    expect(onTrack(template.tracks.video).length).toBe(plan.shots.filter((s) => s.layer === 'main').length)
    expect(looks(after)).toHaveLength(1)
    expect(directorMeta(looks(after)[0]!)?.role).toBe('look')
    expect(looks(after)[0]!.trackId).toBe(lookTrack)
    // No director track stands in for a template one, and no template track is left empty.
    expect(after.tracks.slice(1).map((t) => t.id)).toEqual(project.tracks.map((t) => t.id))
    for (const id of Object.values(template.tracks)) expect(onTrack(id).length).toBeGreaterThan(0)
    expect(editor.undoLabel()).toBe(`Director: ${plan.title}`)
    editor.undo()
    expect(editor.getProject()).toEqual(project)
    editor.redo()

    const again = await planLocally(await buildPlannerInput(after, { kind: 'lyric', seed: 9 }))
    editor.dispatch(compilePlan(again, after).commands)
    const redrafted = editor.getProject()
    expect(redrafted.tracks.map((t) => t.id)).toEqual(after.tracks.map((t) => t.id))
    expect(looks(redrafted)).toHaveLength(1)
    expect(clips(redrafted).filter((c) => c.trackId === template.tracks.lyrics)).toHaveLength(
      lyricTexts(again),
    )
  })

  it('leaves template tracks with the user’s clips alone and never removes template tracks', async () => {
    const project = templateProject()
    const template = templateState(project)!
    const editor = new ProjectEditor(project)
    const mine = createTextClip({ trackId: template.tracks.video!, text: 'Mine', start: 1, duration: 2 })
    editor.dispatch({ type: 'clip.add', clip: mine })
    const plan = await planLocally(await buildPlannerInput(editor.getProject(), { kind: 'lyric', seed: 5 }))
    editor.dispatch(compilePlan(plan, editor.getProject()).commands)
    const first = editor.getProject()
    expect(first.tracks.map((t) => t.name)).toContain('Shots')
    expect(clips(first).filter((c) => c.trackId === template.tracks.video)).toEqual([mine])

    // A beat-cut draft has no text: the template's Lyrics track loses the draft's lines but stays.
    const beatCut = await planLocally(await buildPlannerInput(first, { kind: 'beat-cut', seed: 1 }))
    expect(beatCut.texts).toHaveLength(0)
    editor.dispatch(compilePlan(beatCut, first).commands)
    const after = editor.getProject()
    expect(after.tracks.some((t) => t.id === template.tracks.lyrics)).toBe(true)
    expect(clips(after).filter((c) => c.trackId === template.tracks.lyrics)).toHaveLength(0)
  })

  it('never removes a template track that held only title cards as a spare title row', async () => {
    const project = renamedSong(templateProject(), 'Josh Woodward - Show Me.mp3')
    const lyrics = templateState(project)!.tracks.lyrics!
    const editor = new ProjectEditor(project)
    const plan = await planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 5 }))
    editor.dispatch(compilePlan(plan, project).commands)
    const first = editor.getProject()
    // The user put the artist on the Lyrics track in place of the lines.
    const artist = clips(first).find((c) => (c as TextClip).text === 'Josh Woodward')!
    editor.dispatch([
      {
        type: 'clip.remove',
        clipIds: clips(first)
          .filter((c) => c.trackId === lyrics)
          .map((c) => c.id),
      },
      { type: 'clip.move', moves: [{ clipId: artist.id, start: artist.start, trackId: lyrics }] },
    ])
    const moved = editor.getProject()
    const beatCut = await planLocally(await buildPlannerInput(moved, { kind: 'beat-cut', seed: 1 }))
    editor.dispatch(compilePlan(beatCut, moved).commands)
    const after = editor.getProject()
    expect(after.tracks.some((t) => t.id === lyrics)).toBe(true)
    expect(clips(after).filter((c) => c.trackId === lyrics)).toHaveLength(0)
  })
})
