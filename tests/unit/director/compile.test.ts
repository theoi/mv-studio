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
    // The title card has a track of its own, above the lyrics.
    expect(after.tracks.slice(0, 4).map((t) => t.name)).toEqual(['Titles', 'Text', 'Look', 'Shots'])
    const titles = plan.texts.filter((t) => t.role === 'title')
    expect(titles.length).toBeGreaterThan(0)
    expect(clips(after).filter((c) => c.trackId === after.tracks[0]!.id)).toHaveLength(titles.length)
    editor.undo()
    expect(editor.getProject()).toEqual(project)
    expect(editor.canUndo()).toBe(false)
  })

  it('puts title cards that overlap in time on rows of their own, and a redraft keeps one row each', async () => {
    const project = makeProject()
    project.assets[SONG_ID] = { ...project.assets[SONG_ID]!, name: 'Josh Woodward - Show Me.mp3' }
    const editor = new ProjectEditor(project)
    const plan = await planLocally(await buildPlannerInput(project, { kind: 'lyric', seed: 5 }))
    expect(plan.texts.filter((t) => t.role === 'title').map((t) => t.text)).toEqual([
      'Show Me',
      'Josh Woodward',
    ])
    const compiled = compilePlan(plan, project)
    editor.dispatch(compiled.commands)
    const titleRows = (p: Project) =>
      p.tracks
        .filter((track) => /^Titles/.test(track.name))
        .map((track) => [
          track.name,
          ...clips(p)
            .filter((c) => c.trackId === track.id)
            .map((c) => (c as TextClip).text),
        ])
    const after = editor.getProject()
    expect(titleRows(after)).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])
    // Just below the Titles track, above the lyrics.
    expect(after.tracks.slice(0, 3).map((t) => t.name)).toEqual(['Titles', 'Titles 2', 'Text'])
    expect(compiled.stats.addedTracks).toBe(after.tracks.length - project.tracks.length)

    const again = await planLocally(await buildPlannerInput(after, { kind: 'lyric', seed: 9 }))
    editor.dispatch(compilePlan(again, after).commands)
    expect(titleRows(editor.getProject())).toEqual([
      ['Titles', 'Show Me'],
      ['Titles 2', 'Josh Woodward'],
    ])

    // Without an artist, the second row goes with the earlier draft.
    const plain = editor.getProject()
    const song = plain.assets[SONG_ID]!
    const untitled = { ...plain, assets: { ...plain.assets, [SONG_ID]: { ...song, name: 'Show Me.mp3' } } }
    const single = await planLocally(await buildPlannerInput(untitled, { kind: 'lyric', seed: 9 }))
    const once = new ProjectEditor(untitled)
    once.dispatch(compilePlan(single, untitled).commands)
    expect(titleRows(once.getProject())).toEqual([['Titles', 'Show Me']])
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
    expect(names.filter((n) => n === 'Shots')).toHaveLength(1)
  })

  it('keeps earlier director clips on locked tracks and says so', async () => {
    const { project, editor, plan } = await setup('beat-cut')
    editor.dispatch(compilePlan(plan, project).commands)
    const first = editor.getProject()
    const shotsTrack = first.tracks.find((t) => t.name === 'Shots')!
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
})
