import { describe, expect, it } from 'vitest'
import { ProjectEditor } from '../../../../src/model/editor.ts'
import { createTrack, createVideoClip } from '../../../../src/model/factory.ts'
import type { Clip, Project, Track } from '../../../../src/model/types.ts'
import { TEMPLATE_EXTENSION } from '../../../../src/plugins/templates.ts'
import { JobError } from '../../../../src/shared/jobs.ts'
import { AUTOCUT_TRACK_NAME, autoCutMeta, isUntouchedAutoCut } from '../../../../src/vision/autocut/apply.ts'
import { chooseClips, type ChooseInput, type ChooseSpan } from '../../../../src/vision/autocut/choose.ts'
import {
  applyAutoCut,
  autoCut,
  autoCutPool,
  planAutoCut,
  type AutoCutOptions,
} from '../../../../src/vision/autocut/index.ts'
import type { MatchQuery } from '../../../../src/vision/types.ts'
import { BEATS, CLIPS, fakeMatcher, makeProject, SONG_LENGTH } from './fixtures.ts'

const matcher = fakeMatcher()
const plan = (project: Project, o: AutoCutOptions = {}) => planAutoCut(project, o, { matcher })
const autoCutClips = (p: Project) =>
  Object.values(p.clips)
    .filter((c) => autoCutMeta(c))
    .sort((a, b) => a.start - b.start)
const trackNamed = (p: Project, name: string) => p.tracks.filter((t) => t.name === name)
const durationOf = (p: Project, id: string) => p.assets[id]!.duration ?? Infinity

describe('auto-cut plan', () => {
  it('is deterministic for a project, options and seed', async () => {
    const project = makeProject()
    const a = await plan(project)
    const b = await plan(project)
    expect(a.shots).toEqual(b.shots)
    expect(a.shots.length).toBeGreaterThan(10)
    const shuffled = await plan(project, { order: 'shuffled', seed: 1 })
    const reshuffled = await plan(project, { order: 'shuffled', seed: 2 })
    expect(shuffled.shots.map((s) => s.assetId)).not.toEqual(reshuffled.shots.map((s) => s.assetId))
  })

  it('matches clips to the lyric being sung, without immediate repeats', async () => {
    const { shots } = await plan(makeProject())
    const during = (start: number, end: number) => shots.filter((s) => s.start >= start && s.start < end)
    const city = during(9.6, 14.4)
    const ocean = during(14.4, 19.2)
    const crowd = during(28.8, 33.6)
    expect(city[0]).toMatchObject({ assetId: 'city', reason: 'lyric', lyricLineId: 'l1' })
    expect(ocean[0]).toMatchObject({ assetId: 'ocean', reason: 'lyric', lyricLineId: 'l2' })
    expect(crowd.filter((s) => s.assetId === 'crowd').length).toBeGreaterThanOrEqual(crowd.length / 2 - 1)
    shots.slice(1).forEach((s, i) => expect(s.assetId).not.toBe(shots[i]!.assetId))
  })

  it('takes every shot from inside its clip and does not reuse a range of a clip', async () => {
    const { shots } = await plan(makeProject())
    for (const s of shots) {
      expect(s.sourceStart).toBeGreaterThanOrEqual(0)
      expect(s.sourceStart + (s.end - s.start) * s.playbackRate).toBeLessThanOrEqual(
        CLIPS.find((c) => c.id === s.assetId)!.duration! + 1e-6,
      )
    }
    for (const id of new Set(shots.map((s) => s.assetId))) {
      const ranges = shots
        .filter((s) => s.assetId === id)
        .map((s) => [s.sourceStart, s.sourceStart + (s.end - s.start) * s.playbackRate] as const)
        .sort((a, b) => a[0] - b[0])
      ranges.slice(1).forEach((r, i) => expect(r[0]).toBeGreaterThanOrEqual(ranges[i]![1] - 1e-6))
    }
  })

  it('walks through the footage in import order for a chronological cut', async () => {
    const { shots } = await plan(makeProject(), { order: 'chronological' })
    const order = CLIPS.map((c) => c.id)
    const seen = shots.map((s) => order.indexOf(s.assetId))
    seen.slice(1).forEach((k, i) => expect(k).toBeGreaterThanOrEqual(seen[i]!))
    expect(new Set(seen).size).toBe(order.length)
    for (const id of order) {
      const starts = shots.filter((s) => s.assetId === id).map((s) => s.sourceStart)
      starts.slice(1).forEach((t, i) => expect(t).toBeGreaterThanOrEqual(starts[i]!))
    }
  })

  it('picks for variety with a warning when the clips are not analyzed yet', async () => {
    const project = makeProject({ clips: CLIPS.map((c) => ({ ...c, indexed: false })) })
    const result = await plan(project)
    expect(result.warnings.join(' ')).toMatch(/aren’t analyzed yet/)
    expect(new Set(result.shots.map((s) => s.assetId)).size).toBe(CLIPS.length)
    expect(result.shots.every((s) => s.reason === 'variety')).toBe(true)
  })

  it('words the warning about clips without analysis as the caller says, naming the clips it means', async () => {
    const calls: [readonly string[], boolean][] = []
    const unanalyzedWarning = (ids: readonly string[], all: boolean) => {
      calls.push([ids, all])
      return all ? 'Footage analysis ran out of memory.' : undefined
    }
    const none = makeProject({ clips: CLIPS.map((c) => ({ ...c, indexed: false })) })
    const all = await planAutoCut(none, {}, { matcher, unanalyzedWarning })
    expect(all.warnings).toContain('Footage analysis ran out of memory.')
    expect(all.warnings.join(' ')).not.toMatch(/analyzed yet/)
    const some = makeProject({ clips: [...CLIPS.slice(0, 2), { ...CLIPS[2]!, indexed: false }] })
    const partial = await planAutoCut(some, {}, { matcher, unanalyzedWarning })
    expect(partial.warnings.join(' ')).toMatch(/1 clip isn’t analyzed yet/)
    expect(calls).toEqual([
      [CLIPS.map((c) => c.id), true],
      [[CLIPS[2]!.id], false],
    ])
  })

  it('uses only the chosen clips, and refuses without a song or clips', async () => {
    const { shots } = await plan(makeProject(), { assetIds: ['ocean', 'misc'] })
    expect(new Set(shots.map((s) => s.assetId))).toEqual(new Set(['ocean', 'misc']))
    await expect(plan(makeProject({ song: false }))).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(plan(makeProject({ clips: [] }))).rejects.toBeInstanceOf(JobError)
  })

  it('follows an even grid with a warning when the song has no beat analysis', async () => {
    const result = await plan(makeProject({ analyzed: false }), { followEnergy: false })
    expect(result.estimatedGrid).toBe(true)
    expect(result.bpm).toBe(120)
    expect(result.warnings[0]).toMatch(/even 120 BPM grid/)
  })
})

describe('choosing clips for a planner', () => {
  /** Eight 1.2 s mid-energy shots in the chorus after its lyric line. */
  const shots = (hints: Omit<ChooseSpan, 'start' | 'end'> = {}): ChooseSpan[] =>
    Array.from({ length: 8 }, (_, i) => ({ start: 36 + i * 1.2, end: 37.2 + i * 1.2, energy: 0.5, ...hints }))
  const choose = (project: Project, spans: ChooseSpan[], m: ChooseInput['matcher'] = matcher) =>
    chooseClips({
      spans,
      pool: autoCutPool(project),
      order: 'matched',
      lyrics: project.lyrics!,
      matcher: m,
      seed: 1,
    })

  it('lists the clips and stills in import order, with their analysis when there is one', () => {
    const project = makeProject({
      clips: [{ id: 'still', image: true }, ...CLIPS.slice(0, 2), { ...CLIPS[2]!, indexed: false }],
    })
    const pool = autoCutPool(project)
    expect(pool.map((p) => [p.assetId, p.kind, !!p.index])).toEqual([
      ['still', 'image', true],
      ['city', 'video', true],
      ['ocean', 'video', true],
      ['crowd', 'video', false],
    ])
    expect(autoCutPool(project, ['ocean']).map((p) => p.assetId)).toEqual(['ocean'])
  })

  it("matches a shot's text and mood together with the lyric sung during it", async () => {
    const project = makeProject()
    const queries: MatchQuery[] = []
    const recording = {
      model: matcher.model,
      rankAll: (...args: Parameters<typeof matcher.rankAll>) => {
        queries.push(...args[1])
        return matcher.rankAll(...args)
      },
    }
    const ocean = (await choose(project, shots({ text: 'the ocean' }), recording)).picks
    const plain = (await choose(project, shots())).picks
    expect(ocean[0]).toMatchObject({ assetId: 'ocean', reason: 'brief' })
    const count = (picks: typeof plain) => picks.filter((p) => p?.assetId === 'ocean').length
    expect(count(ocean)).toBeGreaterThan(count(plain))
    queries.length = 0
    await choose(project, shots({ mood: 'dreamy' }), recording)
    expect(queries[0]).toMatchObject({ mood: 'dreamy', energy: 0.5 })

    queries.length = 0
    const sung = await choose(project, [{ start: 10.2, end: 12, text: 'at sunset' }], recording)
    expect(queries[0]?.text).toBe('at sunset, neon city lights at night')
    expect(sung.picks[0]).toMatchObject({ assetId: 'city', reason: 'lyric', lyricLineId: 'l1' })
  })

  it('prefers the clips a brief asks for, without playing one twice in a row', async () => {
    const project = makeProject()
    const plain = await choose(project, shots())
    const preferred = await choose(project, shots({ prefer: ['misc'] }))
    const count = (picks: typeof plain.picks) => picks.filter((p) => p?.assetId === 'misc').length
    expect(count(preferred.picks)).toBeGreaterThanOrEqual(4)
    expect(count(preferred.picks)).toBeGreaterThan(count(plain.picks))
    expect(preferred.picks.find((p) => p?.assetId === 'misc')?.reason).toBe('brief')
    preferred.picks.slice(1).forEach((p, i) => expect(p?.assetId).not.toBe(preferred.picks[i]?.assetId))
  })
})

describe('applying an auto-cut', () => {
  it('adds an Auto-cut track with clips on the beats as one undo step', async () => {
    const before = makeProject()
    const editor = new ProjectEditor(before)
    const result = await autoCut({ editor, matcher })
    const after = editor.getProject()
    const clips = autoCutClips(after)
    expect(result.stats).toMatchObject({ cuts: clips.length, replaced: 0, newTrack: true })
    expect(trackNamed(after, AUTOCUT_TRACK_NAME)).toHaveLength(1)
    expect(clips.every((c) => BEATS.some((b) => Math.abs(b - c.start) < 1e-6))).toBe(true)
    expect(clips.every((c) => c.type === 'video' && c.muted)).toBe(true)
    expect(clips[clips.length - 1]!.start + clips[clips.length - 1]!.duration).toBeCloseTo(SONG_LENGTH, 6)
    expect(editor.undoLabel()).toBe(result.label)
    expect(editor.undo()).toBe(true)
    expect(editor.getProject()).toEqual(before)
    expect(editor.canUndo()).toBe(false)
  })

  it('regenerates only untouched auto-cut clips and cuts around clips the user made or edited', async () => {
    const editor = new ProjectEditor(makeProject())
    await autoCut({ editor, matcher })
    const first = autoCutClips(editor.getProject())
    const edited = first[3]!
    editor.dispatch({ type: 'clip.set', clipId: edited.id, path: ['opacity', 'value'], value: 0.5 })
    const track = trackNamed(editor.getProject(), AUTOCUT_TRACK_NAME)[0]!
    const own = createVideoClip({ trackId: track.id, assetId: 'misc', start: 40, duration: 3 })
    editor.dispatch({ type: 'clip.add', clip: own })

    const second = await autoCut({ editor, matcher }, { order: 'shuffled', seed: 9 })
    const p = editor.getProject()
    expect(second.stats).toMatchObject({ replaced: first.length - 1, kept: 2, newTrack: false })
    expect(p.clips[edited.id]).toMatchObject({ opacity: { value: 0.5 } })
    expect(p.clips[own.id]).toBeDefined()
    expect(first.filter((c) => c.id !== edited.id).some((c) => p.clips[c.id])).toBe(false)
    const fresh = autoCutClips(p).filter(isUntouchedAutoCut)
    expect(fresh).toHaveLength(second.stats.cuts)
    for (const keep of [p.clips[edited.id]!, own] as Clip[]) {
      const overlapping = fresh.filter(
        (c) => c.start < keep.start + keep.duration - 1e-6 && c.start + c.duration > keep.start + 1e-6,
      )
      expect(overlapping).toEqual([])
    }
  })

  it('keeps a locked Auto-cut track and puts the new cut on a new track above it', async () => {
    const editor = new ProjectEditor(makeProject())
    await autoCut({ editor, matcher })
    const locked = trackNamed(editor.getProject(), AUTOCUT_TRACK_NAME)[0]!
    editor.dispatch({ type: 'track.update', trackId: locked.id, patch: { locked: true } })
    const lockedClips = autoCutClips(editor.getProject())

    const result = await autoCut({ editor, matcher }, { seed: 2 })
    const p = editor.getProject()
    const tracks = trackNamed(p, AUTOCUT_TRACK_NAME)
    expect(tracks).toHaveLength(2)
    expect(p.tracks.indexOf(tracks[0]!)).toBeLessThan(p.tracks.findIndex((t) => t.id === locked.id))
    expect(tracks[1]!.id).toBe(locked.id)
    for (const c of lockedClips) expect(p.clips[c.id]).toEqual(c)
    expect(result.warnings.filter((w) => w.includes('locked'))).toEqual([
      'The Auto-cut track is locked, so the new cut is on a new track above it.',
    ])
    expect(result.track).toEqual({ id: tracks[0]!.id, name: AUTOCUT_TRACK_NAME })
  })

  it('never touches clips on other tracks, locked or not', async () => {
    const project = makeProject()
    const footage = project.tracks.find((t) => t.kind === 'visual')!
    const userClip = createVideoClip({ trackId: footage.id, assetId: 'city', start: 0, duration: 8 })
    const lockedTrack = { ...createTrack('visual', 'Titles'), locked: true }
    const editor = new ProjectEditor({
      ...project,
      tracks: [lockedTrack, ...project.tracks],
      clips: { [userClip.id]: userClip },
    })
    await autoCut({ editor, matcher })
    const p = editor.getProject()
    expect(p.clips[userClip.id]).toEqual(userClip)
    const autoTrack = trackNamed(p, AUTOCUT_TRACK_NAME)[0]!
    expect(p.tracks.indexOf(autoTrack)).toBe(p.tracks.indexOf(p.tracks.find((t) => t.id === footage.id)!) - 1)
  })

  it('replaces only the requested range, grown to whole earlier auto-cut clips', async () => {
    const editor = new ProjectEditor(makeProject())
    await autoCut({ editor, matcher })
    const first = autoCutClips(editor.getProject())
    const result = await autoCut({ editor, matcher }, { range: { start: 29.9, end: 40 }, order: 'shuffled' })
    const p = editor.getProject()
    const outside = first.filter(
      (c) =>
        c.start + c.duration <= result.plan.range.start + 1e-6 || c.start >= result.plan.range.end - 1e-6,
    )
    for (const c of outside) expect(p.clips[c.id]).toEqual(c)
    expect(result.plan.range.start).toBeLessThanOrEqual(29.9)
    expect(first.some((c) => Math.abs(c.start - result.plan.range.start) < 1e-6)).toBe(true)
    const inside = autoCutClips(p).filter(
      (c) => c.start >= result.plan.range.start - 1e-6 && c.start < result.plan.range.end - 1e-6,
    )
    expect(inside.length).toBe(result.stats.cuts)
  })

  it('throws instead of dispatching an empty cut', async () => {
    const project = makeProject()
    const editor = new ProjectEditor(project)
    const p = await plan(project)
    expect(() => applyAutoCut(editor, { ...p, shots: [] })).toThrow(/nothing to cut/)
    expect(durationOf(project, 'city')).toBe(20)
  })
})

describe('auto-cut in a project made from a starter template', () => {
  /** makeProject() with a template's Video track on top, as createFromTemplate('footage') records it. */
  const templated = (patch: Partial<Track> = {}) => {
    const base = makeProject()
    const video: Track = { ...createTrack('visual', 'Video'), ...patch }
    const project: Project = {
      ...base,
      tracks: [video, ...base.tracks],
      extensions: {
        ...base.extensions,
        [TEMPLATE_EXTENSION]: { kind: 'footage', tracks: { video: video.id } },
      },
    }
    return { project, video }
  }

  it('cuts on the template’s empty Video track, and cutting again replaces the cut there', async () => {
    const { project, video } = templated()
    const editor = new ProjectEditor(project)
    const first = await autoCut({ editor, matcher })
    let p = editor.getProject()
    const firstClips = autoCutClips(p)
    expect(first.track).toEqual({ id: video.id, name: 'Video' })
    expect(first.stats.newTrack).toBe(false)
    expect(p.tracks.map((t) => t.id)).toEqual(project.tracks.map((t) => t.id))
    expect(firstClips).toHaveLength(first.stats.cuts)
    expect(firstClips.every((c) => c.trackId === video.id)).toBe(true)

    const second = await autoCut({ editor, matcher }, { seed: 2 })
    p = editor.getProject()
    expect(second.track.id).toBe(video.id)
    expect(second.stats.replaced).toBe(first.stats.cuts)
    expect(p.tracks.map((t) => t.id)).toEqual(project.tracks.map((t) => t.id))
    expect(autoCutClips(p)).toHaveLength(second.stats.cuts)
    expect(editor.undo()).toBe(true)
    expect(autoCutClips(editor.getProject())).toEqual(firstClips)
    expect(editor.undo()).toBe(true)
    expect(editor.getProject()).toEqual(project)
  })

  it('names a track whose name already ends in “track” once', async () => {
    const { project, video } = templated({ name: 'Main track' })
    const editor = new ProjectEditor(project)
    const first = await autoCut({ editor, matcher })
    expect(first.track).toEqual({ id: video.id, name: 'Main track' })
    const edited = autoCutClips(editor.getProject())[2]!
    editor.dispatch({ type: 'clip.set', clipId: edited.id, path: ['opacity', 'value'], value: 0.5 })
    const second = await autoCut({ editor, matcher }, { seed: 2 })
    expect(second.warnings).toContain('Kept 1 clip you made or edited on the Main track.')
  })

  it.each([
    ['holds a clip of the user’s', {}, true],
    ['is locked', { locked: true }, false],
    ['is hidden', { hidden: true }, false],
  ])('adds its own Auto-cut track when the template’s Video track %s', async (_, patch, withClip) => {
    const { project, video } = templated(patch)
    const own = createVideoClip({ trackId: video.id, assetId: 'city', start: 0, duration: 4 })
    const editor = new ProjectEditor(withClip ? { ...project, clips: { [own.id]: own } } : project)
    const result = await autoCut({ editor, matcher })
    const p = editor.getProject()
    expect(result.track.name).toBe(AUTOCUT_TRACK_NAME)
    expect(result.stats.newTrack).toBe(true)
    expect(trackNamed(p, AUTOCUT_TRACK_NAME)).toHaveLength(1)
    expect(autoCutClips(p).some((c) => c.trackId === video.id)).toBe(false)
  })
})
