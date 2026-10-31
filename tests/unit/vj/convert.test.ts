import { describe, expect, it } from 'vitest'
import { ease, sampleKeyframes } from '../../../src/engine/animation.ts'
import {
  ProjectEditor,
  createTextClip,
  createVideoClip,
  type Clip,
  type Project,
} from '../../../src/model/index.ts'
import { lookRegistry } from '../../../src/plugins/looks.ts'
import {
  beatGridOf,
  defaultLayout,
  laneOfClip,
  takeToCommands,
  type ConvertOptions,
  type PadSnapshot,
  type Take,
} from '../../../src/vj/index.ts'
import {
  addVisualTrack,
  amount,
  catalog,
  makeProject,
  makeTake,
  padsByLabel,
  press,
  release,
} from './helpers.ts'

function setup() {
  const project = makeProject()
  const pads = padsByLabel(defaultLayout(project, catalog))
  return { project, pads }
}

function commit(project: Project, take: Take, options: Partial<ConvertOptions> = {}) {
  const conversion = takeToCommands(project, take, { catalog, grid: beatGridOf(project), ...options })
  const editor = new ProjectEditor(project)
  editor.dispatch(conversion.commands)
  return { conversion, project: editor.getProject(), editor }
}

function lane(project: Project, key: string): Clip[] {
  return Object.values(project.clips)
    .filter((c) => laneOfClip(c) === key)
    .sort((a, b) => a.start - b.start)
}

const span = (c: Clip) => [round(c.start), round(c.start + c.duration)]
const round = (v: number) => Math.round(v * 1000) / 1000
const trackName = (p: Project, c: Clip) => p.tracks.find((t) => t.id === c.trackId)?.name
const assetOf = (c: Clip | undefined) => (c as { assetId?: string } | undefined)?.assetId
const rate = (c: Clip) => (c.type === 'video' ? [round(c.sourceStart), c.playbackRate] : null)

function withAction(pad: PadSnapshot, patch: Record<string, unknown>): PadSnapshot {
  return { ...pad, id: pad.id + ':custom', action: { ...pad.action, ...patch } as PadSnapshot['action'] }
}

describe('takeToCommands: clips', () => {
  it('makes one clip per shot, merging re-presses and continuing footage where it left off', () => {
    const { project, pads } = setup()
    const city = pads['Night city']!
    const singer = pads['Singer']!
    const sunset = pads['Sunset']!
    const take = makeTake(
      [city, singer, sunset],
      [press(1, city), press(3, singer), press(5, city), press(5.5, city), press(8, sunset)],
      { end: 10 },
    )
    const { project: p } = commit(project, take)
    const clips = lane(p, 'clips')
    expect(clips.map(span)).toEqual([
      [1, 3],
      [3, 5],
      [5, 8],
      [8, 10],
    ])
    expect(clips.map((c) => c.type)).toEqual(['video', 'video', 'video', 'image'])
    expect(clips.map((c) => (c.type === 'video' ? c.sourceStart : null))).toEqual([0, 0, 2, null])
    expect(clips.every((c) => c.type !== 'video' || c.muted)).toBe(true)
    expect(new Set(clips.map((c) => trackName(p, c)))).toEqual(new Set(['VJ clips']))
    expect(clips[0]?.meta).toEqual({ vj: { take: take.id, lane: 'clips', pad: city.id } })
  })

  it('cuts back to the start on each press of a restart pad', () => {
    const { project, pads } = setup()
    const singer = withAction(pads['Singer']!, { playback: 'restart' })
    const { project: p } = commit(
      project,
      makeTake([singer], [press(0, singer), press(1, singer)], { end: 2 }),
    )
    const clips = lane(p, 'clips')
    expect(clips.map(span)).toEqual([
      [0, 1],
      [1, 2],
    ])
    expect(clips.map((c) => (c.type === 'video' ? c.sourceStart : -1))).toEqual([0, 0])
  })

  it('drops a shot shorter than a frame and snaps cuts to frames', () => {
    const { project, pads } = setup()
    const city = pads['Night city']!
    const singer = pads['Singer']!
    const { project: p } = commit(
      project,
      makeTake([city, singer], [press(1, city), press(1.01, singer), press(1.52, city)], { end: 2 }),
    )
    const clips = lane(p, 'clips')
    expect(clips.map((c) => assetOf(c))).toEqual(['singer', 'city'])
    expect(clips.map(span)).toEqual([
      [1, 1.533],
      [1.533, 2],
    ])
    for (const c of clips) expect(Math.abs(c.start * 30 - Math.round(c.start * 30))).toBeLessThan(1e-6)
    expect(clips.every((c) => c.duration > 0)).toBe(true)
  })

  it('loops footage that ends before the shot does', () => {
    const { project, pads } = setup()
    const singer = pads['Singer']!
    const { project: p, conversion } = commit(project, makeTake([singer], [press(0, singer)], { end: 10 }))
    const clips = lane(p, 'clips')
    expect(clips.map(span)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ])
    expect(clips.map((c) => (c.type === 'video' ? c.sourceStart : -1))).toEqual([0, 0, 0])
    expect(conversion.cursors[singer.id]).toBeCloseTo(2)
  })

  it('shows a momentary pad only while held, then returns to the latched clip', () => {
    const { project, pads } = setup()
    const city = pads['Night city']!
    const sunset = withAction(pads['Sunset']!, { trigger: 'momentary' })
    const { project: p } = commit(
      project,
      makeTake([city, sunset], [press(0, city), press(2, sunset), release(3, sunset)], { end: 5 }),
    )
    const clips = lane(p, 'clips')
    expect(clips.map((c) => [assetOf(c), ...span(c)])).toEqual([
      ['city', 0, 2],
      ['sunset', 2, 3],
      ['city', 3, 5],
    ])
    expect(clips[2]?.type === 'video' && clips[2].sourceStart).toBeCloseTo(2)
  })

  it('switches looks, leaving a gap for Original', () => {
    const { project, pads } = setup()
    const neon = pads['Neon night']!
    const original = pads['Original']!
    const mono = pads['Mono']!.row === 'looks' ? pads['Mono']! : null
    const monoLook = mono ?? Object.values(pads).find((x) => x.row === 'looks' && x.label === 'Mono')!
    const { project: p } = commit(
      project,
      makeTake([neon, original, monoLook], [press(0, neon), press(2, original), press(4, monoLook)], {
        end: 6,
      }),
    )
    const looks = lane(p, 'looks')
    expect(looks.map(span)).toEqual([
      [0, 2],
      [4, 6],
    ])
    const first = looks[0]!
    expect(first.type).toBe('adjustment')
    expect(first.type === 'adjustment' && first.adjustments?.contrast?.value).toBe(
      lookRegistry.get('neon')?.adjustments.contrast,
    )
    expect(first.type === 'adjustment' && first.effects.map((e) => e.effectId)).toEqual(['glow'])
    expect(trackName(p, first)).toBe('VJ looks')
  })
})

describe('takeToCommands: effects', () => {
  it('fires one-shots as decaying hits scaled by velocity, cutting a hit short when retriggered', () => {
    const { project, pads } = setup()
    const rgb = pads['RGB split']!
    expect(rgb.action.kind === 'effect' && rgb.action.trigger).toBe('one-shot')
    const { project: p } = commit(
      project,
      makeTake([rgb], [press(2, rgb, 0.5), press(4, rgb), press(4.2, rgb)], { end: 6 }),
    )
    const hits = lane(p, 'fx:' + rgb.id)
    expect(hits.map(span)).toEqual([
      [2, 2.35],
      [4, 4.2],
      [4.2, 4.55],
    ])
    const param = (c: Clip) => (c.type === 'adjustment' ? c.effects[0]!.params.amount! : null)
    expect(hits[0]?.type === 'adjustment' && hits[0].effects[0]?.effectId).toBe('rgb-split')
    expect(param(hits[0]!)?.keyframes).toEqual([
      { time: 0, value: 14, easing: 'ease-out' },
      { time: 0.35, value: 0, easing: 'linear' },
    ])
    const cut = param(hits[1]!)?.keyframes
    expect(cut?.[0]?.value).toBe(28)
    expect(cut?.[1]?.time).toBeCloseTo(0.2)
    expect(cut?.[1]?.value).toBeCloseTo(28 * (1 - ease('ease-out', 0.2 / 0.35)), 3)
    expect(trackName(p, hits[0]!)).toBe('VJ RGB split')
  })

  it('holds an effect from press to release and keys knob moves with few keyframes', () => {
    const { project, pads } = setup()
    const glow = pads['Glow']!
    const ramp = Array.from({ length: 50 }, (_, i) => amount(1.5 + i / 49, glow, 1 - 0.5 * (i / 49)))
    const take = makeTake([glow], [press(1, glow), ...ramp, release(3, glow)], {
      end: 4,
      amounts: { [glow.id]: 1 },
    })
    const { project: p } = commit(project, take)
    const [hit] = lane(p, 'fx:' + glow.id)
    expect(span(hit!)).toEqual([1, 3])
    const intensity = hit!.type === 'adjustment' ? hit!.effects[0]!.params.intensity! : null
    const keys = intensity?.keyframes as { time: number; value: number; easing: 'linear' }[]
    expect(keys.length).toBeLessThanOrEqual(4)
    expect(keys[0]?.value).toBe(2)
    expect(keys.at(-1)?.value).toBeCloseTo(1, 2)
    expect(sampleKeyframes(keys, 1.0)).toBeCloseTo(1.5, 1)
  })

  it('toggles an effect on and off, and runs a knob-driven effect while its knob is up', () => {
    const { project, pads } = setup()
    const vignette = pads['Vignette']!
    const blur = withAction(pads['Blur']!, { trigger: 'knob' })
    const take = makeTake(
      [vignette, blur],
      [press(1, vignette), amount(1, blur, 0.5), press(2, vignette), amount(2, blur, 0)],
      { end: 4, amounts: { [blur.id]: 0 } },
    )
    const { project: p } = commit(project, take)
    const vig = lane(p, 'fx:' + vignette.id)
    expect(vig.map(span)).toEqual([[1, 2]])
    expect(vig[0]?.type === 'adjustment' && vig[0].effects[0]?.params.amount).toEqual({ value: 0.85 })
    const knob = lane(p, 'fx:' + blur.id)
    expect(knob.map(span)).toEqual([[1, 2]])
    expect(knob[0]?.type === 'adjustment' && knob[0].effects[0]?.params.radius?.keyframes?.[0]?.value).toBe(
      12,
    )
  })

  it('strobes on the beat grid while held', () => {
    const { project, pads } = setup()
    const strobe = pads['Strobe']!
    const { project: p } = commit(
      project,
      makeTake([strobe], [press(1, strobe), release(2, strobe)], { end: 3 }),
    )
    const [clip] = lane(p, 'fx:' + strobe.id)
    expect(clip?.type).toBe('solid')
    expect(span(clip!)).toEqual([1, 2])
    const keys = clip!.type === 'solid' ? clip!.opacity.keyframes! : []
    expect(keys).toHaveLength(16)
    expect(keys.slice(0, 4).map((k) => [round(k.time), k.value, k.easing])).toEqual([
      [0, 0.9, 'hold'],
      [0.063, 0, 'hold'],
      [0.125, 0.9, 'hold'],
      [0.188, 0, 'hold'],
    ])
  })
})

describe('takeToCommands: freeze', () => {
  it('holds the frame while Freeze is held, then the footage continues from there', () => {
    const { project, pads } = setup()
    const [city, freeze] = [pads['Night city']!, pads['Freeze']!]
    const { project: p } = commit(
      project,
      makeTake([city, freeze], [press(0, city), press(2, freeze), release(3, freeze)], { end: 5 }),
    )
    const clips = lane(p, 'clips')
    expect(clips.map((c) => [...span(c), ...rate(c)!])).toEqual([
      [0, 2, 0, 1],
      [2, 3, 2, 0],
      [3, 5, 2, 1],
    ])
    expect(Object.values(p.tracks).some((t) => t.name === 'VJ Freeze')).toBe(false)
  })

  it('freezes footage recorded in an earlier take', () => {
    const { project, pads } = setup()
    const [city, freeze] = [pads['Night city']!, pads['Freeze']!]
    const first = commit(project, makeTake([city], [press(0, city)], { end: 10 })).project
    const { project: p } = commit(
      first,
      makeTake([freeze], [press(5, freeze), release(6, freeze)], { start: 4, end: 8 }),
    )
    expect(lane(p, 'clips').map((c) => [...span(c), ...rate(c)!])).toEqual([
      [0, 5, 0, 1],
      [5, 6, 5, 0],
      [6, 10, 6, 1],
    ])
  })
})

describe('takeToCommands: tracks and takes', () => {
  it('stacks new VJ tracks above the footage and below titles: effects, then looks, then clips', () => {
    const { project, pads } = setup()
    const video = project.tracks.find((t) => t.kind === 'visual')!
    const footage = createVideoClip({ trackId: video.id, assetId: 'city', start: 0, duration: 10 })
    project.clips[footage.id] = footage
    const titles = addVisualTrack(project, 'Titles', 0)
    const title = createTextClip({ trackId: titles.id, text: 'Hi', start: 0, duration: 5 })
    project.clips[title.id] = title
    const [glow, rgb, neon, city] = [
      pads['Glow']!,
      pads['RGB split']!,
      pads['Neon night']!,
      pads['Night city']!,
    ]
    const take = makeTake(
      [glow, rgb, neon, city],
      [press(0, city), press(0, neon), press(1, glow), press(1.5, rgb), release(2, glow)],
      { end: 4 },
    )
    const { project: p } = commit(project, take)
    expect(p.tracks.map((t) => t.name)).toEqual([
      'Titles',
      'VJ RGB split',
      'VJ Glow',
      'VJ looks',
      'VJ clips',
      'Video 1',
      'Song',
    ])
  })

  it('overdubs: a second take replaces only the lanes it plays, from its first press', () => {
    const { project, pads } = setup()
    const [city, singer, glow] = [pads['Night city']!, pads['Singer']!, pads['Glow']!]
    const first = commit(
      project,
      makeTake([city, glow], [press(0, city), press(5, glow), release(6, glow)], { end: 10 }),
    ).project
    const second = makeTake([singer], [press(6, singer)], { start: 4, end: 8 })
    const { project: p, conversion } = commit(first, second)
    const clips = lane(p, 'clips')
    expect(clips.map((c) => [assetOf(c), ...span(c)])).toEqual([
      ['city', 0, 6],
      ['singer', 6, 8],
      ['city', 8, 10],
    ])
    expect(clips[2]?.type === 'video' && clips[2].sourceStart).toBeCloseTo(8)
    expect(lane(p, 'fx:' + glow.id).map(span)).toEqual([[5, 6]])
    expect(conversion.summary.newTracks).toBe(0)
    expect(p.tracks.filter((t) => t.name === 'VJ clips')).toHaveLength(1)

    const replaced = commit(first, second, { mode: 'replace' }).project
    expect(lane(replaced, 'clips').map((c) => [assetOf(c), ...span(c)])).toEqual([
      ['city', 0, 4],
      ['singer', 6, 8],
      ['city', 8, 10],
    ])
    expect(lane(replaced, 'fx:' + glow.id)).toEqual([])
  })

  it('leaves a locked VJ track alone and records onto a new one', () => {
    const { project, pads } = setup()
    const [city, singer] = [pads['Night city']!, pads['Singer']!]
    const first = commit(project, makeTake([city], [press(0, city)], { end: 10 })).project
    const vjTrack = first.tracks.find((t) => t.name === 'VJ clips')!
    const locked = {
      ...first,
      tracks: first.tracks.map((t) => (t.id === vjTrack.id ? { ...t, locked: true } : t)),
    }
    const { project: p } = commit(locked, makeTake([singer], [press(2, singer)], { start: 2, end: 4 }))
    expect(p.tracks.filter((t) => t.name === 'VJ clips')).toHaveLength(2)
    expect(
      lane(p, 'clips')
        .filter((c) => c.trackId === vjTrack.id)
        .map(span),
    ).toEqual([[0, 10]])
  })

  it('is one undo step that restores the project exactly', () => {
    const { project, pads } = setup()
    const [city, glow, neon] = [pads['Night city']!, pads['Glow']!, pads['Neon night']!]
    const before = commit(project, makeTake([city], [press(0, city)], { end: 10 })).project
    const editor = new ProjectEditor(before)
    const take = makeTake(
      [city, glow, neon],
      [press(3, neon), press(4, city), press(5, glow), release(7, glow)],
      {
        start: 3,
        end: 8,
      },
    )
    editor.dispatch(takeToCommands(before, take, { catalog }).commands, { label: 'VJ take 2' })
    expect(editor.undoLabel()).toBe('VJ take 2')
    editor.undo()
    expect(editor.getProject()).toEqual(before)
    expect(editor.canUndo()).toBe(false)
  })

  it('quantizes presses to the beat grid with the chosen strength', () => {
    const { project, pads } = setup()
    const [city, singer] = [pads['Night city']!, pads['Singer']!]
    const take = makeTake([city, singer], [press(1.07, city), press(2.93, singer)], { end: 4 })
    const full = commit(project, take, { quantize: { enabled: true, grid: '1/4', strength: 1 } }).project
    expect(lane(full, 'clips').map(span)).toEqual([
      [1, 3],
      [3, 4],
    ])
    const half = commit(project, take, { quantize: { enabled: true, grid: '1/4', strength: 0.5 } }).project
    expect(lane(half, 'clips')[0]!.start).toBeCloseTo(31 / 30, 6)
  })

  it('continues the previous clip across a pause instead of cutting', () => {
    const { project, pads } = setup()
    const city = pads['Night city']!
    const first = commit(project, makeTake([city], [press(0, city)], { end: 3 })).project
    const resumed: Take = {
      ...makeTake([city], [press(3, city)], { start: 3, end: 5 }),
      cursors: { [city.id]: 3 },
    }
    const { project: p } = commit(first, resumed)
    expect(lane(p, 'clips').map(span)).toEqual([[0, 5]])
  })

  it('gives the live preview and the committed take the same ids', () => {
    const { project, pads } = setup()
    const [city, rgb] = [pads['Night city']!, pads['RGB split']!]
    const take = makeTake([city, rgb], [press(0, city), press(1, rgb)], { end: 3, id: 'fixed' })
    const a = takeToCommands(project, take, { catalog })
    const b = takeToCommands(project, take, { catalog })
    expect(a.commands).toEqual(b.commands)
    const live = takeToCommands(project, { ...take, end: undefined }, { catalog, end: 60 })
    const addedIds = (cmds: typeof a.commands) =>
      cmds.flatMap((c) => (c.type === 'clip.add' ? [c.clip.id] : []))
    expect(addedIds(live.commands)).toEqual(expect.arrayContaining(addedIds(a.commands)))
  })
})
