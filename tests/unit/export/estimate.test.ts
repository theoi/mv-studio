import { describe, expect, it } from 'vitest'
import type { ExportProbe } from '../../../src/engine/encode.ts'
import {
  estimateFromTrial,
  newOutput,
  planOutput,
  rememberedEstimate,
  rememberPace,
  trialRuns,
  type ExportPace,
  type ExportPaceStore,
} from '../../../src/export/index.ts'
import type { OutputSpec } from '../../../src/export/types.ts'
import {
  createAudioClip,
  createImageClip,
  createProject,
  createVideoClip,
  createSolidClip,
  createTrack,
  type Asset,
  type Project,
  type SolidClip,
} from '../../../src/model/index.ts'

const measure = (text: string, font: string) => text.length * Number(/([\d.]+)px/.exec(font)?.[1]) * 0.5

/** A 60 s project: a solid under everything. */
function plain(): Project {
  const project = createProject({ name: 'Estimate' })
  const solid = createSolidClip({ trackId: project.tracks[0]!.id, color: '#333333', start: 0, duration: 60 })
  project.clips[solid.id] = solid
  project.duration = 60
  return project
}

/** Adds a solid with effects (three by default) on a track of its own, from `start` for `duration` seconds. */
function addBusy(
  project: Project,
  start: number,
  duration: number,
  effects = ['glow', 'film-grain', 'rgb-split'],
): SolidClip {
  const track = createTrack('visual', 'Effects')
  project.tracks.unshift(track)
  const clip = createSolidClip({ trackId: track.id, color: '#ffffff', start, duration })
  clip.effects = effects.map((effectId, i) => ({
    id: `e${i}`,
    effectId,
    enabled: true,
    params: {},
  }))
  project.clips[clip.id] = clip
  return clip
}

/** Adds `count` 1920×1080 photos of 3 s each, one after another, on a track of their own. */
function addPhotos(project: Project, count: number): void {
  const track = createTrack('visual', 'Photos')
  project.tracks.unshift(track)
  for (let i = 0; i < count; i++) {
    const asset: Asset = {
      id: `photo${i}`,
      kind: 'image',
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
      byteSize: 1,
      storageKey: `media/photo${i}.jpg`,
      width: 1920,
      height: 1080,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
    }
    project.assets[asset.id] = asset
    const clip = createImageClip({ trackId: track.id, assetId: asset.id, start: i * 3, duration: 3 })
    project.clips[clip.id] = clip
  }
}

const plan = (project: Project, patch: Partial<OutputSpec> = {}) =>
  planOutput(project, newOutput(project, 'video', patch), { measure })

/**
 * A trial whose runs took `msPerRender` per frame: four frames from `firsts` (by default 0, 100, 200, ...), the
 * first of each also seeking for `seekMs`.
 */
function trial(msPerRender: number[], seekMs = 0, firsts = msPerRender.map((_, i) => i * 100)): ExportProbe {
  return {
    setupMs: 0,
    flushMs: 0,
    windows: msPerRender.map((ms, i) => ({
      first: firsts[i]!,
      firstMs: ms + seekMs,
      ms: 3 * ms,
      renders: 3,
      frameMs: [ms, ms, ms],
    })),
  }
}

function memoryStore(): ExportPaceStore {
  const paces = new Map<string, ExportPace>()
  return {
    get: (projectId, key) => paces.get(`${projectId}/${key}`),
    set: (projectId, key, pace) => void paces.set(`${projectId}/${key}`, pace),
  }
}

describe('trial runs', () => {
  it('cover the busiest moment as well as the start, middle and end, four frames each', () => {
    const project = plain()
    addBusy(project, 40, 3)
    const runs = trialRuns(plan(project))
    const starts = runs.map((r) => r[0]! / 30)
    expect(starts.some((t) => t >= 40 && t < 43)).toBe(true)
    expect(starts.some((t) => t < 10)).toBe(true)
    expect(starts.some((t) => t > 25 && t < 35)).toBe(true)
    expect(starts.some((t) => t > 50)).toBe(true)
    expect(runs.length).toBeGreaterThanOrEqual(4)
    for (const run of runs) expect(run).toEqual([0, 1, 2, 3].map((k) => run[0]! + k))
  })

  it("include a loop's last frames, where each frame blends two renders", () => {
    const project = createProject({ name: 'Loop' })
    project.songAssetId = 'song'
    const audioTrack = project.tracks.find((t) => t.kind === 'audio')!
    const song = createAudioClip({ trackId: audioTrack.id, assetId: 'song', start: 0, duration: 60 })
    project.clips[song.id] = song
    const solid = createSolidClip({
      trackId: project.tracks[0]!.id,
      color: '#336699',
      start: 0,
      duration: 60,
    })
    project.clips[solid.id] = solid
    const beats = Array.from({ length: 121 }, (_, i) => i * 0.5)
    project.analysis.audio.song = {
      assetId: 'song',
      version: 'test',
      tempo: { bpm: 120, confidence: 1 },
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
    }
    const planned = planOutput(project, newOutput(project, 'loop'), { measure })
    expect(planned.loop?.crossfade).toBeGreaterThan(0)
    const last = planned.frames - 1
    expect(trialRuns(planned).at(-1)).toEqual([last - 3, last - 2, last - 1, last])
  })
})

describe('the estimate from a trial', () => {
  it("gives each look's frames the pace measured in it, so a short busy part is neither missed nor spread", () => {
    const project = plain()
    addBusy(project, 40, 3)
    const planned = plan(project)
    const runs = trialRuns(planned)
    const busy = (frame: number) => frame >= 40 * 30 && frame < 43 * 30
    const firsts = runs.map((r) => r[0]!)
    const seconds = estimateFromTrial(
      planned,
      trial(
        firsts.map((f) => (busy(f + 1) ? 50 : 10)),
        0,
        firsts,
      ),
    )
    expect(firsts.some((f) => busy(f + 1))).toBe(true)
    expect(seconds).toBeGreaterThanOrEqual((90 * 50 + (planned.frames - 90) * 10) / 1000)
    expect(seconds).toBeLessThan((planned.frames * 50) / 1000 / 2)
  })

  it('gives the frames of a look no run measured the slowest pace measured', () => {
    const project = plain()
    addBusy(project, 10, 10)
    addBusy(project, 40, 3, ['vignette'])
    const planned = plan(project)
    const measured = estimateFromTrial(planned, trial([10, 50, 50], 0, [0, 15 * 30, 41 * 30]))
    expect(estimateFromTrial(planned, trial([10, 50], 0, [0, 15 * 30]))).toBeCloseTo(measured, 6)
    expect(estimateFromTrial(planned, trial([10, 50, 10], 0, [0, 15 * 30, 41 * 30]))).toBeLessThan(measured)
  })

  it('adds what a seek costs for every cut to another photo or clip', () => {
    const project = plain()
    addPhotos(project, 20)
    const planned = plan(project)
    const withoutSeeks = estimateFromTrial(planned, trial([10, 10, 10, 10]))
    // 19 cuts after the first frame, at 200 ms each.
    expect(estimateFromTrial(planned, trial([10, 10, 10, 10], 200)) - withoutSeeks).toBeGreaterThanOrEqual(
      19 * 0.2,
    )
  })

  it('counts photos of the same size as one look, so the runs in a few of them stand for all', () => {
    const project = plain()
    addPhotos(project, 20)
    addBusy(project, 40, 3)
    const planned = plan(project)
    const firsts = trialRuns(planned).map((r) => r[0]!)
    const busy = (frame: number) => frame >= 40 * 30 && frame < 43 * 30
    const seconds = estimateFromTrial(
      planned,
      trial(
        firsts.map((f) => (busy(f + 1) ? 50 : 10)),
        0,
        firsts,
      ),
    )
    // With a look per photo, the photos no run landed in would take the busy part's pace.
    expect(seconds).toBeLessThan((planned.frames * 50) / 1000 / 2)
  })

  it("leaves out the first run's warm-up where a later run timed the same look", () => {
    const planned = plan(plain())
    const firsts = trialRuns(planned).map((r) => r[0]!)
    expect(firsts.length).toBeGreaterThan(1)
    const warm = estimateFromTrial(
      planned,
      trial(
        firsts.map(() => 10),
        0,
        firsts,
      ),
    )
    const cold = estimateFromTrial(
      planned,
      trial(
        firsts.map((_, i) => (i === 0 ? 14 : 10)),
        0,
        firsts,
      ),
    )
    expect(cold).toBeCloseTo(warm, 1)
  })
})
describe('trial runs, timed frame by frame', () => {
  it("count a run's frames at their median, so one slow frame of a few doesn't set its look's pace", () => {
    const planned = plan(plain())
    const firsts = trialRuns(planned).map((r) => r[0]!)
    const even = trial(
      firsts.map(() => 20),
      0,
      firsts,
    )
    const hiccup = structuredClone(even)
    hiccup.windows[1] = { ...hiccup.windows[1]!, ms: 100, frameMs: [20, 20, 60] }
    expect(estimateFromTrial(planned, hiccup)).toBeCloseTo(estimateFromTrial(planned, even), 6)
  })

  it('give a short output an estimate within 0.67 to 1.5 times its export (recorded on a 4-core machine without a GPU)', () => {
    // An 8 s video at 1080p: a song, a 1080p clip for its first half and a photo for the rest.
    const asset = (id: string, kind: Asset['kind'], mimeType: string, extra: Partial<Asset>): Asset => ({
      id,
      kind,
      name: id,
      mimeType,
      byteSize: 1,
      storageKey: `media/${id}`,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
      ...extra,
    })
    const d = 8.020657596371882
    const project = createProject({ name: 'Simple' })
    const song = asset('song', 'audio', 'audio/mpeg', { duration: d, sampleRate: 44100, channels: 2 })
    const clip = asset('clip', 'video', 'video/mp4', {
      width: 1920,
      height: 1080,
      duration: 4,
      frameRate: 30,
    })
    const photo = asset('photo', 'image', 'image/png', { width: 640, height: 360 })
    for (const a of [song, clip, photo]) project.assets[a.id] = a
    project.songAssetId = song.id
    const visual = project.tracks.find((t) => t.kind === 'visual')!
    const audio = project.tracks.find((t) => t.kind === 'audio')!
    for (const c of [
      createAudioClip({ trackId: audio.id, assetId: song.id, start: 0, duration: d }),
      createVideoClip({ trackId: visual.id, assetId: clip.id, start: 0, duration: d / 2 }),
      createImageClip({ trackId: visual.id, assetId: photo.id, start: d / 2, duration: d / 2 }),
    ])
      project.clips[c.id] = c
    const planned = plan(project, { resolution: '1080p' })
    // Each run's frames in ms, its first (which seeks) first; the export took 17.6 s.
    const recorded: [number, number[]][] = [
      [24, [327, 104, 129, 135]],
      [58, [198, 84, 97, 191]],
      [120, [221, 51, 51, 45]],
      [179, [49, 60, 70, 56]],
      [217, [52, 56, 53, 56]],
    ]
    expect(trialRuns(planned).map((r) => r[0])).toEqual(recorded.map(([first]) => first))
    const probe: ExportProbe = {
      setupMs: 10,
      flushMs: 36,
      windows: recorded.map(([first, [firstMs, ...rest]]) => ({
        first,
        firstMs: firstMs!,
        ms: rest.reduce((a, b) => a + b, 0),
        renders: rest.length,
        frameMs: rest,
      })),
    }
    const ratio = 17.6 / estimateFromTrial(planned, probe)
    expect(ratio).toBeGreaterThanOrEqual(0.67)
    expect(ratio).toBeLessThanOrEqual(1.5)
  })
})
describe('the remembered pace of an earlier export', () => {
  it('is never under the time that export took, for the same project and frame size only', () => {
    const store = memoryStore()
    const project = plain()
    rememberPace(project.id, plan(project), 90, store)
    expect(rememberedEstimate(project.id, plan(project), store)).toBeGreaterThanOrEqual(90)
    expect(rememberedEstimate(project.id, plan(project, { resolution: '720p' }), store)).toBeNull()
    expect(rememberedEstimate('another project', plan(project), store)).toBeNull()
  })

  it('stops counting once the project has become much busier, and survives a small change', () => {
    const store = memoryStore()
    const project = plain()
    addBusy(project, 0, 30)
    rememberPace(project.id, plan(project), 90, store)
    const trimmed = structuredClone(project)
    const busy = Object.values(trimmed.clips).find((c) => c.type === 'solid' && c.effects.length > 0)!
    busy.duration = 28
    expect(rememberedEstimate(project.id, plan(trimmed), store)).not.toBeNull()
    addBusy(project, 30, 30)
    expect(rememberedEstimate(project.id, plan(project), store)).toBeNull()
  })
})

describe('transitions', () => {
  /** A 60 s project cut every 7 s, so no cut is near 10, 50 or 90% of it; with `transition` on every cut. */
  function cuts(transition?: string): Project {
    const project = createProject({ name: 'Cuts' })
    for (let start = 0; start < 60; start += 7) {
      const clip = createSolidClip({
        trackId: project.tracks[0]!.id,
        color: '#336699',
        start,
        duration: Math.min(7, 60 - start),
      })
      if (transition && start > 0) clip.transitionIn = { kind: transition, duration: 0.6, easing: 'linear' }
      project.clips[clip.id] = clip
    }
    project.duration = 60
    return project
  }

  const inTransition = (frame: number) => {
    const t = frame / 30
    return t >= 7 && t % 7 < 0.6
  }

  it('get a trial run of their own, though they sit away from the runs at 10, 50 and 90%', () => {
    expect(trialRuns(plan(cuts())).some((run) => run.some(inTransition))).toBe(false)
    expect(trialRuns(plan(cuts('zoom-blur'))).some((run) => inTransition(run[1]!))).toBe(true)
  })

  it('take the pace measured in them, so they raise the estimate', () => {
    const plainCuts = plan(cuts())
    const plainFirsts = trialRuns(plainCuts).map((r) => r[0]!)
    const withTransitions = plan(cuts('zoom-blur'))
    const firsts = trialRuns(withTransitions).map((r) => r[0]!)
    const without = estimateFromTrial(
      plainCuts,
      trial(
        plainFirsts.map(() => 10),
        0,
        plainFirsts,
      ),
    )
    const slow = estimateFromTrial(
      withTransitions,
      trial(
        firsts.map((f) => (inTransition(f + 1) ? 40 : 10)),
        0,
        firsts,
      ),
    )
    // 8 transitions of 18 frames at 30 ms more each.
    expect(slow - without).toBeGreaterThanOrEqual((8 * 18 * 30) / 1000)
  })

  it('count in the busyness a remembered pace is checked against', () => {
    const store = memoryStore()
    const project = cuts()
    rememberPace(project.id, plan(project), 90, store)
    expect(rememberedEstimate(project.id, plan(cuts('zoom-blur')), store)).toBeNull()
  })
})
