import { beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Clip, Project } from '../../../src/model/index.ts'
import {
  assetSuitability,
  canTryCutout,
  cutoutCommands,
  findPersonMask,
  footageOnTimeline,
  suitabilityOf,
  suitabilityText,
  suitableClips,
  type Suitability,
} from '../../../src/app/state/behind.ts'
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
    expect(assetSuitability(project.assets['m-city']!)).toMatchObject({ reasons: ['no-subject'] })
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
      why: 'Works in parts of this shot. The cutout flickers in this shot.',
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

  it('says why a failed check failed and that only video clips have people', () => {
    expect(suitabilityText({ status: 'failed', message: 'The clip could not be read.' })).toMatchObject({
      why: 'The clip could not be read.',
      ok: false,
    })
    const project = editor.getProject()
    const text = Object.values(project.clips).find((c) => c.type === 'text')
    expect(suitabilityOf(project, text)).toEqual({ status: 'unsupported' })
  })
})

describe('footage on the timeline', () => {
  it('lists each video once, in order of first use, without cutouts or stills', () => {
    const project = editor.getProject()
    const footage = footageOnTimeline(project)
    const firstUse = new Map<string, number>()
    for (const c of Object.values(project.clips))
      if (c.type === 'video' && project.assets[c.assetId]?.kind === 'video')
        firstUse.set(c.assetId, Math.min(firstUse.get(c.assetId) ?? Infinity, c.start))
    expect(footage.map((a) => a.id)).toEqual(
      [...firstUse.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id),
    )
    const singer = clipsOf(project, 'm-singer')[0]!
    editor.dispatch(cutoutCommands(project, [singer.id]).commands)
    expect(footageOnTimeline(editor.getProject())).toEqual(footage)
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
    const { commands, count } = cutoutCommands(project, [clip.id], new Map([[asset.id, mask]]))
    expect(count).toBe(1)
    editor.dispatch(commands)
    const after = editor.getProject()
    expect(findPersonMask(after, asset.id)).toEqual(mask)
    const cut = Object.values(after.clips).find((c) => c.meta?.behindSubjectOf === clip.id)
    expect(cut).toMatchObject({ matte: { maskAssetId: mask.id, sourceAssetId: asset.id, mode: 'inside' } })
  })
})
