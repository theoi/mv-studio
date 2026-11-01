import { describe, expect, it } from 'vitest'
import {
  blankAssets,
  blankClipsNote,
  buildVisualAnalysis,
  hasBlankVerdict,
  hasUncheckedMedia,
  isBlankClip,
  projectLibrary,
  readClipIndex,
  readSubjectTrack,
  reframePlanFor,
  VISION_ANALYSIS_VERSION,
  withoutUnchecked,
} from '../../../src/vision/analysisData.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { Asset } from '../../../src/model/types.ts'
import { cropAt } from '../../../src/vision/reframe/planner.ts'
import type { ClipVisionIndex, ReframePlan, SubjectTrack } from '../../../src/vision/types.ts'
import { createRng, randomUnit } from './matching/helpers.ts'

function index(mediaId: string, frames = 30, dim = 512): ClipVisionIndex {
  const rng = createRng(7)
  const embeddings = new Float32Array(frames * dim)
  for (let i = 0; i < frames; i++) embeddings.set(randomUnit(dim, rng), i * dim)
  return {
    version: 1,
    mediaId,
    duration: frames,
    model: 'clipB32',
    dim,
    times: Array.from({ length: frames }, (_, i) => i),
    embeddings,
    hubness: Array.from({ length: frames }, (_, i) => 0.2 + i / 1000),
    motion: {
      fps: 4,
      energy: [1.234, 5.678],
      camera: [0.5, 0.25],
      cuts: [3.5],
      meanEnergy: 3.456,
      p90Energy: 5.2,
      meanCamera: 0.375,
    },
  }
}

const SUBJECTS: SubjectTrack = {
  version: 1,
  mediaId: 'a1',
  sourceSize: { width: 1920, height: 1080 },
  samples: [
    {
      t: 0,
      focus: { x: 0.5, y: 0.3 },
      box: { x: 0.4, y: 0.2, width: 0.2, height: 0.7 },
      confidence: 0.9,
      source: 'face',
    },
    { t: 0.2, focus: { x: 0.5, y: 0.5 }, box: null, confidence: 0, source: 'none' },
  ],
}

describe('visual analysis data', () => {
  it('stores embeddings compactly and reads them back with near-identical similarities', () => {
    const original = index('a1')
    const analysis = buildVisualAnalysis({
      assetId: 'a1',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: original,
    })
    expect(analysis.version).toBe(VISION_ANALYSIS_VERSION)
    expect(JSON.stringify(analysis).length).toBeLessThan(original.embeddings.byteLength / 2.5)
    const back = readClipIndex(JSON.parse(JSON.stringify(analysis)))!
    expect(back.times).toEqual(original.times)
    expect(back.motion.cuts).toEqual([3.5])
    expect(back.motion.energy).toEqual([1.23, 5.68])
    for (let i = 0; i < original.times.length; i++) {
      let dot = 0
      for (let k = 0; k < original.dim; k++)
        dot += back.embeddings[i * 512 + k]! * original.embeddings[i * 512 + k]!
      expect(dot).toBeGreaterThan(0.999)
    }
  })

  it('merges new parts into the previous analysis', () => {
    const first = buildVisualAnalysis({
      assetId: 'a1',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: index('a1'),
    })
    const second = buildVisualAnalysis(
      { assetId: 'a1', duration: 30, sourceSize: { width: 1920, height: 1080 }, subjects: SUBJECTS },
      first,
    )
    expect(readClipIndex(second)).not.toBeNull()
    expect(readSubjectTrack(second)?.samples).toEqual(SUBJECTS.samples)
  })

  it('returns null for missing, foreign or corrupt data', () => {
    const good = buildVisualAnalysis({
      assetId: 'a1',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: index('a1'),
    })
    expect(readClipIndex(undefined)).toBeNull()
    expect(readClipIndex({ ...good, version: 'other-1' })).toBeNull()
    const truncated = structuredClone(good)
    const emb = truncated.data.embedding as { data: string }
    emb.data = emb.data.slice(0, 100)
    expect(readClipIndex(truncated)).toBeNull()
    expect(readSubjectTrack(good)).toBeNull()
  })

  it('collects the matching library from a project, skipping assets without an index', () => {
    const a = buildVisualAnalysis({
      assetId: 'a',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: index('a'),
    })
    const b = buildVisualAnalysis({
      assetId: 'b',
      duration: 5,
      sourceSize: { width: 1920, height: 1080 },
      subjects: SUBJECTS,
    })
    const library = projectLibrary({ analysis: { audio: {}, visual: { a, b } } })
    expect(library.map((l) => l.mediaId)).toEqual(['a'])
  })

  it('says whether any clip or still has yet to be checked for showing nothing', () => {
    const media = (id: string, kind: Asset['kind'], extra: Partial<Asset> = {}): Asset => ({
      id,
      kind,
      name: id,
      mimeType: 'video/mp4',
      byteSize: 1,
      storageKey: id,
      duration: 5,
      width: 640,
      height: 360,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
      ...extra,
    })
    const checked = (assetId: string) =>
      buildVisualAnalysis({
        assetId,
        duration: 5,
        sourceSize: { width: 640, height: 360 },
        blankCheck: { peakLuma: 90, frames: 8 },
      })
    const project = {
      ...createProject({ name: 'Unchecked', now: new Date(0) }),
      assets: {
        clip: media('clip', 'video'),
        still: media('still', 'image'),
        song: media('song', 'audio'),
        stem: media('stem', 'video', { origin: { type: 'stem' } }),
      },
    }
    expect(hasUncheckedMedia(project)).toBe(true)
    expect(hasUncheckedMedia(project, ['song', 'stem'])).toBe(false)
    const withClip = { ...project, analysis: { audio: {}, visual: { clip: checked('clip') } } }
    expect(hasUncheckedMedia(withClip, ['clip'])).toBe(false)
    expect(hasUncheckedMedia(withClip)).toBe(true)
    const both = {
      ...project,
      analysis: { audio: {}, visual: { clip: checked('clip'), still: checked('still') } },
    }
    expect(hasUncheckedMedia(both)).toBe(false)
    expect(hasUncheckedMedia(withClip, undefined, (a) => a.id === 'still')).toBe(false)
  })

  it('finds the clips that show nothing from the brightest pixel analysis measured, not from older analyses', () => {
    const analyzed = (assetId: string, peakLuma?: number) => {
      const i = index(assetId)
      return buildVisualAnalysis({
        assetId,
        duration: 30,
        sourceSize: { width: 1920, height: 1080 },
        index: { ...i, motion: { ...i.motion, ...(peakLuma === undefined ? {} : { peakLuma }) } },
      })
    }
    const stored = (a: ReturnType<typeof analyzed>) => JSON.parse(JSON.stringify(a)) as typeof a
    expect(isBlankClip(stored(analyzed('clear', 0)))).toBe(true)
    expect(isBlankClip(stored(analyzed('night', 60)))).toBe(false)
    expect(isBlankClip(stored(analyzed('older')))).toBe(false)
    expect(isBlankClip(undefined)).toBe(false)
    expect(readClipIndex(stored(analyzed('clear', 0)))?.motion.peakLuma).toBe(0)
    expect(hasBlankVerdict(stored(analyzed('older')))).toBe(false)
    expect(hasBlankVerdict(stored(analyzed('night', 60)))).toBe(true)

    // The fast blank check flags a clip before the matching index exists; the index, which sees more frames, wins.
    const checked = (assetId: string, peakLuma: number, previous?: ReturnType<typeof analyzed>) =>
      buildVisualAnalysis(
        {
          assetId,
          duration: 30,
          sourceSize: { width: 1920, height: 1080 },
          blankCheck: { peakLuma, frames: 8 },
        },
        previous,
      )
    expect(isBlankClip(stored(checked('clear', 3)))).toBe(true)
    expect(hasBlankVerdict(stored(checked('clear', 3)))).toBe(true)
    expect(isBlankClip(stored(checked('night', 60)))).toBe(false)
    expect(isBlankClip(stored(checked('flash', 3, analyzed('flash', 200))))).toBe(false)
    expect(isBlankClip(stored(checked('older', 3, analyzed('older'))))).toBe(true)

    const asset = (id: string, createdAt: string, extra: Partial<Asset> = {}): Asset => ({
      id,
      kind: 'video',
      name: `${id}.webm`,
      mimeType: 'video/webm',
      byteSize: 1,
      storageKey: id,
      origin: { type: 'import' },
      createdAt,
      ...extra,
    })
    const project = {
      ...createProject({ name: 'Blank', now: new Date(0) }),
      assets: {
        later: asset('later', '2026-01-02T00:00:00.000Z'),
        first: asset('first', '2026-01-01T00:00:00.000Z'),
        night: asset('night', '2026-01-01T00:00:00.000Z'),
        stem: asset('stem', '2026-01-01T00:00:00.000Z', { origin: { type: 'stem' } }),
      },
      analysis: {
        audio: {},
        visual: {
          later: analyzed('later', 3),
          first: analyzed('first', 0),
          night: analyzed('night', 60),
          stem: analyzed('stem', 0),
        },
      },
    }
    expect(blankAssets(project).map((a) => a.id)).toEqual(['first', 'later'])
    expect(blankClipsNote([])).toBeUndefined()
    expect(blankClipsNote(['a.webm'])).toBe(
      'Left out “a.webm” because every frame of it is black or see-through.',
    )
    expect(blankClipsNote(['a.webm', 'night_drive_with_the_windows_down.webm'])).toBe(
      'Left out 2 clips because every frame of them is black or see-through: “a.webm”, “night_drive_wi…own.webm”.',
    )
  })
})

describe('withoutUnchecked', () => {
  const pool = (kinds: string) =>
    [...kinds].map((k, i) => ({
      assetId: `m${i}`,
      kind: k === 'i' ? ('image' as const) : ('video' as const),
    }))
  const project = createProject({ name: 'Unchecked', now: new Date(0) })
  const ids = (items: readonly { assetId: string }[]) => items.map((m) => m.assetId)
  const draft = { rerun: 'Draft again' }

  it('leaves out media the blank check didn’t reach when at least 3 checked ones, and as many, are left', () => {
    expect(withoutUnchecked(project, pool('vvvv'), ['m3'], draft)).toEqual({
      pool: pool('vvv'),
      note: 'Left out 1 clip that wasn’t checked yet, in case it shows nothing. Draft again to use it.',
    })
    const mixed = withoutUnchecked(project, pool('vvvviv'), ['m3', 'm4', 'm5'], draft)
    expect(ids(mixed.pool)).toEqual(['m0', 'm1', 'm2'])
    expect(mixed.note).toBe(
      'Left out 2 clips and 1 image that weren’t checked yet, in case they show nothing. Draft again to use them.',
    )
  })

  it('uses them when too few checked ones are left, or when the user chose them, and says so', () => {
    expect(withoutUnchecked(project, pool('vvvv'), ['m2', 'm3'], draft)).toEqual({
      pool: pool('vvvv'),
      note: '2 clips weren’t checked yet, so one of them may show nothing. Draft again to check them.',
    })
    expect(withoutUnchecked(project, pool('vvv'), ['m2'], draft).note).toBe(
      '1 clip wasn’t checked yet, so it may show nothing. Draft again to check it.',
    )
    const chosen = withoutUnchecked(project, pool('vvvvi'), ['m4'], { rerun: 'Cut again', keep: true })
    expect(ids(chosen.pool)).toHaveLength(5)
    expect(chosen.note).toBe('1 image wasn’t checked yet, so it may show nothing. Cut again to check it.')
  })

  it('counts media checked since as checked, and says nothing when none is left unchecked', () => {
    const checked = {
      ...project,
      analysis: {
        audio: {},
        visual: {
          m3: buildVisualAnalysis({
            assetId: 'm3',
            duration: 5,
            sourceSize: { width: 1920, height: 1080 },
            blankCheck: { peakLuma: 120, frames: 8 },
          }),
        },
      },
    }
    expect(withoutUnchecked(checked, pool('vvvv'), ['m3'], draft)).toEqual({ pool: pool('vvvv') })
    expect(withoutUnchecked(project, pool('vvvv'), ['gone'], draft)).toEqual({ pool: pool('vvvv') })
  })
})

describe('reframePlanFor', () => {
  const asset = { id: 'a1', width: 1920, height: 1080 }
  const sourceSize = { width: 1920, height: 1080 }
  const centre = (plan: ReframePlan, t: number) => {
    const r = cropAt(plan, t)
    return r.x + r.width / 2
  }
  const subjectsAt = (x: (t: number) => number): SubjectTrack => ({
    ...SUBJECTS,
    samples: Array.from({ length: 21 }, (_, i) => ({
      t: i / 5,
      focus: { x: x(i / 5), y: 0.4 },
      box: null,
      confidence: 0.9,
      source: 'face' as const,
    })),
  })

  it('frames the stored subject, and falls back to a centred crop without subject data', () => {
    const analysis = buildVisualAnalysis({
      assetId: 'a1',
      duration: 4,
      sourceSize,
      subjects: subjectsAt(() => 0.85),
    })
    expect(centre(reframePlanFor(asset, analysis, '9:16'), 1)).toBeGreaterThan(0.8)
    const indexOnly = buildVisualAnalysis({ assetId: 'a1', duration: 30, sourceSize, index: index('a1') })
    for (const missing of [undefined, indexOnly]) {
      const crop = cropAt(reframePlanFor(asset, missing, '9:16'), 1)
      expect(crop.width).toBeCloseTo(0.31640625)
      expect(crop.x).toBeCloseTo((1 - 0.31640625) / 2)
    }
  })

  it('turns shot changes stored by indexing into hard cuts unless cuts are given', () => {
    const indexed = index('a1')
    const analysis = buildVisualAnalysis({
      assetId: 'a1',
      duration: 30,
      sourceSize,
      index: { ...indexed, motion: { ...indexed.motion, cuts: [1.9] } },
      subjects: subjectsAt((t) => (t < 1.9 ? 0.2 : 0.8)),
    })
    expect(centre(reframePlanFor(asset, analysis, '9:16'), 2.2)).toBeCloseTo(0.8)
    expect(centre(reframePlanFor(asset, analysis, '9:16', { cuts: [] }), 2.2)).toBeLessThan(0.5)
  })
})
