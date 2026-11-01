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
    const track = createTrack('visual', 'Photos')
    project.tracks.unshift(track)
    for (let i = 0; i < 20; i++) {
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
    const planned = plan(project)
    const withoutSeeks = estimateFromTrial(planned, trial([10, 10, 10, 10]))
    // 19 cuts after the first frame, at 200 ms each.
    expect(estimateFromTrial(planned, trial([10, 10, 10, 10], 200)) - withoutSeeks).toBeGreaterThanOrEqual(
      19 * 0.2,
    )
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
