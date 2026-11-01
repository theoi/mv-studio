import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Clip, Project } from '../../../src/model/index.ts'
import {
  assetSuitability,
  bringToFront,
  canTryCutout,
  cutoutCommands,
  cutoutNote,
  cutoutsOf,
  findPersonMask,
  footageRows,
  personMaskRecord,
  putBehind,
  refusalText,
  remakeOfflineMasks,
  replaceMaskCommands,
  retryPeopleSkipped,
  suitabilityOf,
  suitabilityText,
  suitableClips,
  type PersonMaskRecord,
  type Suitability,
  useBehind,
  withCutoutTrims,
  withCutouts,
} from '../../../src/app/state/behind.ts'
import { PERSON_TRACK_VERSION } from '../../../src/vision/segmentation/personTrack.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'

beforeEach(() => loadDemoProject())

const clipsOf = (project: Project, assetId: string) =>
  Object.values(project.clips)
    .filter((c) => c.type === 'video' && c.assetId === assetId)
    .sort((a, b) => a.start - b.start)

/** Adds an imported video and one clip of it after the end of the first clip of the singer. */
function importFootage(): { asset: Asset; clip: Clip } {
  const project = editor.getProject()
  const host = clipsOf(project, 'm-singer')[0]!
  const asset: Asset = {
    ...project.assets['m-singer']!,
    id: 'a-interview',
    name: 'interview.webm',
    storageKey: 'opfs/a-interview',
    origin: { type: 'import' },
  }
  const clip = { ...structuredClone(host), id: 'c-interview', assetId: asset.id, start: 0.5 } as Clip
  editor.dispatch([
    { type: 'asset.add', asset },
    { type: 'clip.add', clip },
  ])
  return { asset, clip }
}

const personMask = (parent: string): Asset => ({
  id: `mask-of-${parent}`,
  kind: 'video',
  name: 'person mask',
  mimeType: 'video/webm',
  byteSize: 100,
  storageKey: `opfs/mask-of-${parent}`,
  origin: { type: 'derived', parentAssetId: parent, provider: 'vision.person-mask' },
  createdAt: new Date(0).toISOString(),
})

describe('suitability', () => {
  it('knows the sample footage: the singer can be cut out, the crowd is too small', () => {
    const project = editor.getProject()
    expect(assetSuitability(project.assets['m-singer']!)).toEqual({
      status: 'checked',
      verdict: 'good',
      reasons: [],
    })
    const crowd = assetSuitability(project.assets['m-crowd']!)
    expect(crowd).toMatchObject({ verdict: 'unsuitable', reasons: ['subject-too-small'] })
    expect(suitabilityText(crowd)).toEqual({
      status: 'Not suitable',
      why: 'People are too small in this wide shot.',
      ok: false,
    })
    expect(canTryCutout(crowd)).toBe(false)
    const city = assetSuitability(project.assets['m-city']!)
    expect(city).toMatchObject({ reasons: ['no-subject'] })
    // Nobody found can also mean people too small to find, so the text does not claim the shot is empty.
    expect(suitabilityText(city).why).toBe('No one in this shot is large enough to cut out.')
    // In a marginal shot the reason is about the parts without a person, so it must not contradict "Person found".
    expect(suitabilityText({ status: 'checked', verdict: 'marginal', reasons: ['no-subject'] })).toEqual({
      status: 'Person found',
      why: 'Works in parts of this shot. In the other parts, no one is large enough to cut out.',
      ok: true,
    })
  })

  it('leaves imported footage unchecked until a check result is stored for it', () => {
    const { asset, clip } = importFootage()
    const project = editor.getProject()
    expect(suitabilityOf(project, project.clips[clip.id], {})).toEqual({ status: 'unchecked' })
    expect(canTryCutout({ status: 'unchecked' })).toBe(true)
    const checked: Suitability = { status: 'checked', verdict: 'marginal', reasons: ['unstable-mask'] }
    expect(suitabilityOf(project, project.clips[clip.id], { [asset.id]: checked })).toBe(checked)
    expect(suitabilityText(checked)).toEqual({
      status: 'Person found',
      why: 'The cutout flickers in places, so the lyrics can blink around the person for a moment.',
      ok: true,
    })
  })

  it('lists the clips with a known person, including imported ones once checked', () => {
    const { asset, clip } = importFootage()
    const project = editor.getProject()
    const people = [...clipsOf(project, 'm-singer'), ...clipsOf(project, 'm-dancer')].map((c) => c.id)
    expect(people.length).toBeGreaterThan(1)
    expect(suitableClips(project, {}).sort()).toEqual(people.sort())
    const good: Suitability = { status: 'checked', verdict: 'good', reasons: [] }
    expect(suitableClips(project, { [asset.id]: good })).toContain(clip.id)
    expect(suitableClips(project, { [asset.id]: { ...good, verdict: 'unsuitable' } })).not.toContain(clip.id)
  })

  it('says when no one was looked for because the person detector could not download', () => {
    const note =
      'Couldn’t check for people, so the cutout may include animals or objects. It checks again when you’re back online.'
    expect(suitabilityText({ status: 'checked', verdict: 'good', reasons: [], peopleSkipped: true })).toEqual(
      { status: 'Person found', why: note, brief: 'Not checked for people', ok: true },
    )
    expect(
      suitabilityText({
        status: 'checked',
        verdict: 'marginal',
        reasons: ['unstable-mask'],
        peopleSkipped: true,
      }).why,
    ).toBe(`The cutout flickers in places, so the lyrics can blink around the person for a moment. ${note}`)
    // Without the detector more of the mask counts, so a shot turned down then would be turned down with it.
    expect(
      suitabilityText({
        status: 'checked',
        verdict: 'unsuitable',
        reasons: ['subject-too-small'],
        peopleSkipped: true,
      }).why,
    ).toBe('People are too small in this wide shot.')
  })

  it('forgets the checks made without the person detector, so they are made again once back online', () => {
    const withDetector: Suitability = { status: 'checked', verdict: 'good', reasons: [] }
    useBehind.setState({
      checks: {
        'a-offline': { ...withDetector, peopleSkipped: true },
        'a-online': withDetector,
        'a-failed': { status: 'failed', message: 'The clip couldn’t be read.' },
      },
    })
    retryPeopleSkipped()
    expect(useBehind.getState().checks).toEqual({
      'a-offline': { status: 'unchecked' },
      'a-online': withDetector,
      'a-failed': { status: 'failed', message: 'The clip couldn’t be read.' },
    })
    useBehind.setState({ checks: {} })
  })

  it('says the cutout may still turn down a shot the quick check found a person in only in parts', () => {
    const quick: Suitability = {
      status: 'checked',
      verdict: 'marginal',
      reasons: ['no-subject'],
      quick: true,
    }
    expect(suitabilityText(quick)).toEqual({
      status: 'Person found',
      why: 'Works in parts of this shot. In the other parts, no one is large enough to cut out. The cutout takes a closer look and may still turn it down.',
      brief: 'Works in parts of this shot, may change on a closer look',
      ok: true,
    })
    expect(suitabilityText({ status: 'checked', verdict: 'good', reasons: [], quick: true })).toEqual({
      status: 'Person found',
      ok: true,
    })
  })

  it('says a turn-down after an offer comes from the cutout’s closer look', () => {
    const refused = (first: 'no-subject' | 'subject-too-small'): Suitability => ({
      status: 'checked',
      verdict: 'unsuitable',
      reasons: [first, 'many-small-subjects'],
    })
    expect(refusalText(refused('no-subject'))).toBe('On a closer look, no one is large enough to cut out.')
    expect(refusalText(refused('subject-too-small'))).toBe(
      'On a closer look, people are too small in this wide shot.',
    )
  })

  it('says no person was found where the cutout shape is large but not a person', () => {
    expect(
      suitabilityText({
        status: 'checked',
        verdict: 'unsuitable',
        reasons: ['no-person-found', 'no-subject'],
      }),
    ).toEqual({ status: 'Not suitable', why: 'Couldn’t find a person to cut out in this shot.', ok: false })
    expect(suitabilityText({ status: 'checked', verdict: 'marginal', reasons: ['no-person-found'] })).toEqual(
      {
        status: 'Person found',
        why: 'Works in parts of this shot. Couldn’t find a person in the other parts.',
        ok: true,
      },
    )
    expect(refusalText({ status: 'checked', verdict: 'unsuitable', reasons: ['no-person-found'] })).toBe(
      'On a closer look, the cutout couldn’t find a person in this shot.',
    )
  })

  it('says why a failed check failed and that only video clips have people', () => {
    expect(suitabilityText({ status: 'failed', message: 'The clip couldn’t be read.' })).toMatchObject({
      why: 'The clip couldn’t be read.',
      ok: false,
    })
    const project = editor.getProject()
    const text = Object.values(project.clips).find((c) => c.type === 'text')
    expect(suitabilityOf(project, text)).toEqual({ status: 'unsupported' })
  })
})

describe('clips showing part of their footage', () => {
  /**
   * An imported 6 s video and three clips of it: its first 2.5 s, 2 s from 3.5 s on, and all of it at double speed.
   */
  function threeParts(): Asset {
    const project = editor.getProject()
    const host = clipsOf(project, 'm-singer')[0]!
    const asset: Asset = {
      ...project.assets['m-singer']!,
      id: 'a-parts',
      name: 'parts.webm',
      storageKey: 'opfs/a-parts',
      origin: { type: 'import' },
      duration: 6,
    }
    const base = { ...structuredClone(host), assetId: asset.id, playbackRate: 1 } as Clip
    const parts = [
      { ...base, id: 'c-first', start: 0.5, sourceStart: 0, duration: 2.5 },
      { ...base, id: 'c-last', start: 3.5, sourceStart: 3.5, duration: 2 },
      { ...base, id: 'c-whole', start: 6, sourceStart: 0, duration: 3, playbackRate: 2 },
    ]
    editor.dispatch([
      { type: 'asset.add', asset },
      ...parts.map((clip) => ({ type: 'clip.add' as const, clip: clip as Clip })),
    ])
    return asset
  }

  /** The check of a shot with a large person in its first 3 s only, as the vision check reports it. */
  const firstHalf: Suitability = {
    status: 'checked',
    verdict: 'marginal',
    reasons: ['subject-too-small'],
    evidence: {
      frames: Array.from({ length: 30 }, (_, i) => ({
        t: i * 0.2,
        verdict: i < 15 ? ('ok' as const) : ('subject-too-small' as const),
        coverage: 0.2,
      })),
      spacing: 0.2,
      pops: null,
    },
  }

  it('are judged on the part they show, in the inspector and in Assist', () => {
    const asset = threeParts()
    const project = editor.getProject()
    const checks = { [asset.id]: firstHalf }
    const first = suitabilityOf(project, project.clips['c-first'], checks)
    expect(first).toMatchObject({ verdict: 'good', reasons: [] })
    expect(suitabilityText(first)).toEqual({ status: 'Person found', ok: true })
    const last = suitabilityOf(project, project.clips['c-last'], checks)
    expect(suitabilityText(last)).toEqual({
      status: 'Not suitable',
      why: 'People are too small in this wide shot.',
      ok: false,
    })
    expect(suitableClips(project, checks)).toContain('c-first')
    expect(suitableClips(project, checks)).not.toContain('c-last')
    const rows = footageRows(project, checks).filter((r) => r.asset.id === asset.id)
    expect(rows.map((r) => [r.suitability.status === 'checked' && r.suitability.verdict, r.clips])).toEqual([
      ['good', 1],
      ['marginal', 1],
      ['unsuitable', 1],
    ])
    expect(new Set(rows.map((r) => r.key)).size).toBe(3)
  })

  it('get the whole verdict when they show all of it, and keep the note that no one was looked for', () => {
    const asset = threeParts()
    const project = editor.getProject()
    const whole = suitabilityOf(project, project.clips['c-whole'], {
      [asset.id]: { ...firstHalf, peopleSkipped: true },
    })
    expect(whole).toMatchObject({ verdict: 'marginal', reasons: ['subject-too-small'], peopleSkipped: true })
  })

  it('keep a quick check’s hedge when the part they show has a person only in parts', () => {
    const asset = threeParts()
    const project = editor.getProject()
    const checks = { [asset.id]: { ...firstHalf, quick: true } }
    expect(suitabilityText(suitabilityOf(project, project.clips['c-whole'], checks)).brief).toBe(
      'Works in parts of this shot, may change on a closer look',
    )
    expect(suitabilityText(suitabilityOf(project, project.clips['c-first'], checks))).toEqual({
      status: 'Person found',
      ok: true,
    })
  })
})

describe('footage rows', () => {
  it('put shots with a person first, then unchecked ones, then the unsuitable ones, with their clip counts', () => {
    const { asset } = importFootage()
    const project = editor.getProject()
    const rows = footageRows(project, {})
    const ranks = rows.map((r) =>
      r.suitability.status === 'checked' ? (r.suitability.verdict === 'unsuitable' ? 2 : 0) : 1,
    )
    expect(ranks).toEqual([...ranks].sort())
    expect(
      rows
        .slice(0, 2)
        .map((r) => r.asset.id)
        .sort(),
    ).toEqual(['m-dancer', 'm-singer'])
    expect(rows[2]).toMatchObject({ asset: { id: asset.id }, suitability: { status: 'unchecked' }, clips: 1 })
    for (const r of rows) expect(r.clips).toBe(clipsOf(project, r.asset.id).length)
    expect(rows.reduce((n, r) => n + r.clips, 0)).toBeGreaterThan(rows.length)

    const good: Suitability = { status: 'checked', verdict: 'good', reasons: [] }
    expect(footageRows(project, { [asset.id]: good })[0]?.asset.id).toBe(asset.id)
  })

  it('keep the order of first use within a group and leave out cutouts and stills', () => {
    const project = editor.getProject()
    const rows = footageRows(project, {})
    const firstUse = new Map<string, number>()
    for (const c of Object.values(project.clips))
      if (c.type === 'video' && project.assets[c.assetId]?.kind === 'video')
        firstUse.set(c.assetId, Math.min(firstUse.get(c.assetId) ?? Infinity, c.start))
    const unsuitable = rows.filter(
      (r) => r.suitability.status === 'checked' && r.suitability.verdict === 'unsuitable',
    )
    expect(unsuitable.length).toBeGreaterThan(2)
    const starts = unsuitable.map((r) => firstUse.get(r.asset.id)!)
    expect(starts).toEqual([...starts].sort((x, y) => x - y))
    expect(rows).toHaveLength(firstUse.size)

    const singer = clipsOf(project, 'm-singer')[0]!
    editor.dispatch(cutoutCommands(project, [singer.id]).commands)
    expect(footageRows(editor.getProject(), {})).toEqual(rows)
  })
})
describe('cutout commands', () => {
  it('copy the clip onto a new top Subject track with the scene mask, as one undo step', () => {
    const project = editor.getProject()
    const singer = clipsOf(project, 'm-singer')[0]!
    const crowd = clipsOf(project, 'm-crowd')[0]!
    const { commands, count } = cutoutCommands(project, [singer.id, crowd.id, singer.id])
    expect(count).toBe(1)
    editor.dispatch(commands)

    const after = editor.getProject()
    expect(after.tracks[0]).toMatchObject({ name: 'Subject', kind: 'visual' })
    const cut = Object.values(after.clips).filter((c) => c.meta?.behindSubjectOf === singer.id)
    expect(cut).toHaveLength(1)
    expect(cut[0]).toMatchObject({
      trackId: after.tracks[0]!.id,
      start: singer.start,
      duration: singer.duration,
      matte: { sourceAssetId: 'm-singer', mode: 'inside' },
    })
    const mask = after.assets[(cut[0] as Extract<Clip, { type: 'video' }>).matte!.maskAssetId]
    expect(mask).toMatchObject({ kind: 'image', origin: { type: 'derived', parentAssetId: 'm-singer' } })
    expect(cutoutCommands(after, [singer.id])).toEqual({ commands: [], count: 0 })

    editor.undo()
    expect(editor.getProject()).toEqual(project)
  })

  it('reuse the Subject track and the mask asset for more clips of the same footage', () => {
    const project = editor.getProject()
    const [a, b] = clipsOf(project, 'm-singer')
    expect(b).toBeDefined()
    editor.dispatch(cutoutCommands(project, [a!.id]).commands)
    const once = editor.getProject()
    const { commands, count } = cutoutCommands(once, [b!.id])
    expect(count).toBe(1)
    expect(commands.map((c) => c.type)).toEqual(['clip.add'])
    editor.dispatch(commands)
    expect(editor.getProject().tracks.filter((t) => t.name === 'Subject')).toHaveLength(1)
  })

  it('cut imported footage out only with a person mask, and find that mask afterwards', () => {
    const { asset, clip } = importFootage()
    const project = editor.getProject()
    expect(cutoutCommands(project, [clip.id]).count).toBe(0)
    expect(findPersonMask(project, asset.id)).toBeUndefined()

    const mask = personMask(asset.id)
    const { commands, count } = cutoutCommands(
      project,
      [clip.id],
      new Map([[asset.id, mask]]),
      new Map([[mask.id, { trackVersion: PERSON_TRACK_VERSION }]]),
    )
    expect(count).toBe(1)
    editor.dispatch(commands)
    const after = editor.getProject()
    expect(findPersonMask(after, asset.id)).toEqual(mask)
    expect(personMaskRecord(after, mask.id)).toEqual({ trackVersion: PERSON_TRACK_VERSION })
    const cut = Object.values(after.clips).find((c) => c.meta?.behindSubjectOf === clip.id)
    expect(cut).toMatchObject({ matte: { maskAssetId: mask.id, sourceAssetId: asset.id, mode: 'inside' } })
  })

  it('reuse a person mask for a new cutout only when the current person track made it with the people looked for', () => {
    const { asset } = importFootage()
    const mask = personMask(asset.id)
    const withRecord = (record: PersonMaskRecord | null) => {
      loadDemoProject()
      const { clip } = importFootage()
      const records = new Map(record ? [[mask.id, record]] : [])
      editor.dispatch(
        cutoutCommands(editor.getProject(), [clip.id], new Map([[asset.id, mask]]), records).commands,
      )
      return findPersonMask(editor.getProject(), asset.id)
    }
    expect(withRecord({ trackVersion: PERSON_TRACK_VERSION })).toEqual(mask)
    // Made before masks had a record, by an older track version, or without the person detector.
    expect(withRecord(null)).toBeUndefined()
    expect(withRecord({ trackVersion: PERSON_TRACK_VERSION - 1 })).toBeUndefined()
    expect(withRecord({ trackVersion: PERSON_TRACK_VERSION, peopleSkipped: true })).toBeUndefined()
  })
})

describe('cutouts of a clip a drop trims', () => {
  const round = (t: number) => Math.round(t * 1000) / 1000
  /** The singer's first clip with a cutout whose start and end are moved `by` seconds from the clip's. */
  function cutOut(by: { start: number; end: number } = { start: 0, end: 0 }) {
    const host = clipsOf(editor.getProject(), 'm-singer')[0] as Extract<Clip, { type: 'video' }>
    editor.dispatch(cutoutCommands(editor.getProject(), [host.id]).commands)
    const cutout = cutoutsOf(editor.getProject(), host.id)[0]!
    if (by.start || by.end) {
      const start = host.start + by.start
      const duration = host.duration + by.end - by.start
      editor.dispatch({ type: 'clip.trim', clipId: cutout.id, start, duration })
    }
    return { host, cutout: editor.getProject().clips[cutout.id] as Extract<Clip, { type: 'video' }> }
  }
  /** Moves a clip `by` seconds and trims it to `start`..`end` seconds into where it lands, as a swap or a gap fill does. */
  function drop(clipId: string, by: number, start: number, end: number) {
    const p = editor.getProject()
    const at = p.clips[clipId]!.start + by
    const moves = withCutouts(p, [{ clipId, start: at }])
    const trims = withCutoutTrims(p, moves, [
      { type: 'clip.trim', clipId, start: at + start, duration: end - start },
    ])
    editor.dispatch([{ type: 'clip.move', moves }, ...trims])
    return trims
  }
  const placed = (id: string) => {
    const c = editor.getProject().clips[id] as Extract<Clip, { type: 'video' }>
    return [c.start, c.start + c.duration, c.sourceStart].map(round)
  }

  it('trim a cutout with its clip, so it keeps showing the same frames', () => {
    const { host, cutout } = cutOut()
    drop(host.id, 1, 0.05, host.duration - 0.04)
    expect(placed(host.id)).toEqual(
      [host.start + 1.05, host.start + host.duration + 0.96, host.sourceStart + 0.05 * host.playbackRate].map(
        round,
      ),
    )
    expect(placed(cutout.id)).toEqual(placed(host.id))
    editor.undo()
    expect(placed(cutout.id)).toEqual([host.start, host.start + host.duration, host.sourceStart].map(round))
  })

  it('cut a shorter cutout back only where it would stick out, and leave one on a locked track', () => {
    const { host, cutout } = cutOut({ start: 0.5, end: -0.02 })
    const end = host.start + host.duration
    drop(host.id, 1, 0, host.duration - 0.08)
    expect(placed(cutout.id)).toEqual([host.start + 1.5, end + 0.92, cutout.sourceStart].map(round))
    editor.undo()

    const subject = editor.getProject().tracks[0]!
    editor.dispatch({ type: 'track.update', trackId: subject.id, patch: { locked: true } })
    expect(drop(host.id, 1, 0, host.duration - 0.08).map((t) => t.clipId)).toEqual([host.id])
    expect(placed(cutout.id)).toEqual([host.start + 0.5, end - 0.02, cutout.sourceStart].map(round))
  })
})

describe('a cutout made without the person detector', () => {
  /** An imported clip cut out with a mask made offline, an undo step after the one that added the clip. */
  function cutOutOffline() {
    const { asset, clip } = importFootage()
    const offline = personMask(asset.id)
    const project = editor.getProject()
    editor.dispatch(
      cutoutCommands(
        project,
        [clip.id],
        new Map([[asset.id, offline]]),
        new Map([[offline.id, { trackVersion: PERSON_TRACK_VERSION, peopleSkipped: true }]]),
      ).commands,
    )
    return { asset, clip, offline }
  }
  const remade: Asset = { ...personMask('a-interview'), id: 'mask-again', storageKey: 'opfs/mask-again' }

  /** What the re-make dispatches once the mask is made again with the person detector. */
  const remake = (offline: Asset) =>
    editor.dispatch(
      replaceMaskCommands(editor.getProject(), offline.id, remade, { trackVersion: PERSON_TRACK_VERSION }),
      { history: 'skip' },
    )
  /** Lets the repairs that follow a change run. */
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const masksOf = (project: Project, ...hosts: Clip[]) =>
    hosts.flatMap((h) =>
      cutoutsOf(project, h.id).map((c) => (c as Extract<Clip, { type: 'video' }>).matte?.maskAssetId),
    )
  /** A second clip of the footage, cut out with the mask made offline, as two more undo steps. */
  function addSecondCutout(asset: Asset, clip: Clip, offline: Asset): Clip {
    const second = {
      ...structuredClone(editor.getProject().clips[clip.id]!),
      id: 'c-interview-2',
      start: 3,
    } as Clip
    editor.dispatch({ type: 'clip.add', clip: second })
    editor.dispatch(cutoutCommands(editor.getProject(), [second.id], new Map([[asset.id, offline]])).commands)
    return second
  }

  it('keeps saying no one was looked for after a check with the detector, until its mask is made again', () => {
    const { asset, clip, offline } = cutOutOffline()
    const checks: Record<string, Suitability> = {
      [asset.id]: { status: 'checked', verdict: 'good', reasons: [] },
    }
    const note = (project: Project) => suitabilityText(suitabilityOf(project, project.clips[clip.id], checks))
    expect(note(editor.getProject())).toMatchObject({ brief: 'Not checked for people', ok: true })

    // While the mask is made again, the note says no one was looked for, but no longer that a check comes later.
    const project = editor.getProject()
    const checking = suitabilityText(suitabilityOf(project, project.clips[clip.id], checks), true)
    expect(checking.why).toBe('Couldn’t check for people, so the cutout may include animals or objects.')
    expect(cutoutNote(project, clip.id, true)).toBe(checking.why)

    remake(offline)
    expect(note(editor.getProject())).toEqual({ status: 'Person found', ok: true })
  })

  it('gets the new mask in every cutout that used it, without an undo step of its own', async () => {
    const { asset, clip, offline } = cutOutOffline()
    const second = addSecondCutout(asset, clip, offline)
    expect(masksOf(editor.getProject(), clip, second)).toEqual([offline.id, offline.id])
    const undo = editor.history().undo.length

    remake(offline)
    await settled()
    const after = editor.getProject()
    expect(masksOf(after, clip, second)).toEqual([remade.id, remade.id])
    expect(findPersonMask(after, asset.id)).toEqual(remade)
    expect(editor.history().undo.length).toBe(undo)
    // An undo can still bring back a cutout on the old mask, so it stays until the project is opened again.
    expect(after.assets[offline.id]).toEqual(offline)
  })

  it('gives a cutout that an undo brings back after its mask was made again the new mask', async () => {
    const { clip, offline } = cutOutOffline()
    expect(bringToFront([clip.id])).toBe(true)
    remake(offline)
    editor.undo()
    await settled()
    const project = editor.getProject()
    expect(masksOf(project, clip)).toEqual([remade.id])
    expect(project.assets[remade.id]).toEqual(remade)
    expect(cutoutNote(project, clip.id)).toBeUndefined()
  })

  it('gives a cutout that reused the mask made offline the new mask when it is undone and redone', async () => {
    const { asset, clip, offline } = cutOutOffline()
    const second = addSecondCutout(asset, clip, offline)
    remake(offline)
    editor.undo()
    await settled()
    expect(cutoutsOf(editor.getProject(), second.id)).toEqual([])
    editor.redo()
    await settled()
    const project = editor.getProject()
    expect(masksOf(project, clip, second)).toEqual([remade.id, remade.id])
    expect(project.assets[remade.id]).toEqual(remade)
  })

  it('keeps the record of the new mask when the cutout is undone, and redoes the cutout with the new mask', async () => {
    const { asset, clip, offline } = cutOutOffline()
    remake(offline)
    editor.undo()
    await settled()
    let project = editor.getProject()
    expect(cutoutsOf(project, clip.id)).toEqual([])
    expect(personMaskRecord(project, remade.id)).toEqual({ trackVersion: PERSON_TRACK_VERSION })
    expect(findPersonMask(project, asset.id)).toEqual(remade)

    editor.redo()
    await settled()
    project = editor.getProject()
    expect(masksOf(project, clip)).toEqual([remade.id])
    expect(personMaskRecord(project, offline.id)).toEqual({
      trackVersion: PERSON_TRACK_VERSION,
      peopleSkipped: true,
    })
  })

  it('drops the mask made offline when the project opens again, once it is replaced and no cutout uses it', async () => {
    const { clip, offline } = cutOutOffline()
    remake(offline)
    editor.load(structuredClone(editor.getProject()))
    await settled()
    const project = editor.getProject()
    expect(project.assets[offline.id]).toBeUndefined()
    expect(personMaskRecord(project, offline.id)).toBeUndefined()
    expect(project.assets[remade.id]).toEqual(remade)
    expect(masksOf(project, clip)).toEqual([remade.id])
  })

  it('leaves a cutout on a locked track on the mask made offline until the track is unlocked', async () => {
    const { clip, offline } = cutOutOffline()
    const subject = editor.getProject().tracks.find((t) => t.name === 'Subject')!
    editor.dispatch({ type: 'track.update', trackId: subject.id, patch: { locked: true } })
    remake(offline)
    editor.load(structuredClone(editor.getProject()))
    await settled()
    expect(masksOf(editor.getProject(), clip)).toEqual([offline.id])
    expect(editor.getProject().assets[offline.id]).toEqual(offline)
    expect(cutoutNote(editor.getProject(), clip.id)).toMatch(/^Couldn’t check for people/)

    editor.dispatch({ type: 'track.update', trackId: subject.id, patch: { locked: false } })
    await settled()
    expect(masksOf(editor.getProject(), clip)).toEqual([remade.id])
  })

  it('makes the masks made offline again only while cutouts use them, titled by the cutouts it checks', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    try {
      const { asset, clip, offline } = cutOutOffline()
      expect(bringToFront([clip.id])).toBe(true)
      expect(remakeOfflineMasks()).toBeUndefined()

      addSecondCutout(asset, clip, offline)
      editor.dispatch(cutoutCommands(editor.getProject(), [clip.id], new Map([[asset.id, offline]])).commands)
      const job = remakeOfflineMasks()
      expect(job?.title).toBe('Checking 2 cutouts for people')
      expect(useBehind.getState().remaking).toEqual([offline.id])
      job!.cancel()
      await expect(job!.promise).rejects.toMatchObject({ code: 'cancelled' })
      expect(useBehind.getState().remaking).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stops a running re-make when a cutout starts, since it runs again after the cutout', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    let job: ReturnType<typeof remakeOfflineMasks>
    let cutout: ReturnType<typeof putBehind>
    try {
      cutOutOffline()
      job = remakeOfflineMasks()
      cutout = putBehind([clipsOf(editor.getProject(), 'm-singer')[0]!.id])
    } finally {
      // Offline again, so the re-make after the cutout does not start.
      vi.unstubAllGlobals()
    }
    expect(job).toBeDefined()
    await expect(job!.promise).rejects.toMatchObject({ code: 'cancelled' })
    await expect(cutout!.promise).resolves.toMatchObject({ count: 1 })
  })
})
