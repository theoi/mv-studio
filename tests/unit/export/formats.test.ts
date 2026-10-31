import { describe, expect, it } from 'vitest'
import { fitSize, layerMatrix } from '../../../src/engine/layout.ts'
import { cssFont, fontPxFor, layoutText } from '../../../src/engine/text.ts'
import {
  convertToFormat,
  framingOverrides,
  newOutput,
  planOutput,
  SAFE_AREAS,
  setFramingCommand,
  suggestedOutputs,
} from '../../../src/export/index.ts'
import {
  ProjectEditor,
  createImageClip,
  createProject,
  createSolidClip,
  createTextClip,
  createTrack,
  createVideoClip,
  type Asset,
  type GeneratorClip,
  type Project,
  type TextClip,
  type VideoClip,
  type VisualClip,
} from '../../../src/model/index.ts'
import { buildVisualAnalysis } from '../../../src/vision/analysisData.ts'
import type { SubjectSample } from '../../../src/vision/types.ts'

const measure = (text: string, font: string) => text.length * Number(/([\d.]+)px/.exec(font)?.[1]) * 0.5

function asset(id: string, kind: 'video' | 'image', width = 1920, height = 1080): Asset {
  return {
    id,
    kind,
    name: `${id}.${kind === 'video' ? 'mp4' : 'png'}`,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
    byteSize: 1,
    storageKey: id,
    width,
    height,
    ...(kind === 'video' ? { duration: 8, frameRate: 30 } : {}),
    origin: { type: 'import' },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as Asset
}

function footageProject(): { project: Project; shot: VideoClip } {
  const project = createProject({ name: 'Song' })
  project.assets.city = asset('city', 'video')
  const shot = createVideoClip({ trackId: project.tracks[0]!.id, assetId: 'city', start: 0, duration: 4 })
  project.clips[shot.id] = shot
  return { project, shot }
}

/** Subject focus over time (normalized source coordinates) as stored by the vision module. */
function withSubject(project: Project, focus: (t: number) => { x: number; y: number }): void {
  const samples: SubjectSample[] = []
  for (let t = 0; t <= 8; t += 0.2) {
    const f = focus(t)
    samples.push({
      t,
      focus: f,
      box: { x: f.x - 0.05, y: f.y - 0.1, width: 0.1, height: 0.3 },
      confidence: 0.9,
      source: 'face',
    })
  }
  project.analysis.visual.city = buildVisualAnalysis({
    assetId: 'city',
    duration: 8,
    sourceSize: { width: 1920, height: 1080 },
    subjects: { version: 1, mediaId: 'city', sourceSize: { width: 1920, height: 1080 }, samples },
  })
}

/** Where normalized source point (u, v) of a footage clip lands on a canvas, in pixels. */
function sourceToCanvas(
  clip: VideoClip,
  local: number,
  canvas: { width: number; height: number },
  u: number,
  v: number,
): { x: number; y: number; box: { left: number; right: number; top: number; bottom: number } } {
  const [bw, bh] = fitSize(clip.fit, 1920, 1080, canvas.width, canvas.height)
  const m = layerMatrix(clip, local, clip.start + local, bw, bh, canvas.width, canvas.height)
  return {
    x: m[0] * u + m[4],
    y: m[3] * v + m[5],
    box: { left: m[4], right: m[4] + m[0], top: m[5], bottom: m[5] + m[3] },
  }
}

const VERTICAL = { width: 1080, height: 1920 }

describe('convertToFormat: footage', () => {
  it('leaves a project in its own format unchanged', () => {
    const { project } = footageProject()
    expect(convertToFormat(project, '16:9').project).toBe(project)
  })

  it('keeps the subject in frame as it moves, with the crop inside the picture', () => {
    const { project, shot } = footageProject()
    withSubject(project, (t) => ({ x: 0.25 + t * 0.12, y: 0.4 }))
    const { project: out, clips, unanalysed } = convertToFormat(project, '9:16', { measure })
    expect(out.settings).toMatchObject({ aspect: '9:16', width: 1080, height: 1920 })
    expect(clips[shot.id]).toBe('reframed')
    expect(unanalysed).toEqual([])
    const clip = out.clips[shot.id] as VideoClip
    expect(clip.transform.x.keyframes?.length).toBeGreaterThan(1)
    for (const local of [0.5, 2, 3.5]) {
      const subject = 0.25 + local * 0.12
      const p = sourceToCanvas(clip, local, VERTICAL, subject, 0.4)
      expect(p.x, `t=${local}`).toBeGreaterThan(1080 * 0.2)
      expect(p.x, `t=${local}`).toBeLessThan(1080 * 0.8)
      expect(p.box.left).toBeLessThanOrEqual(1e-6)
      expect(p.box.right).toBeGreaterThanOrEqual(1080 - 1e-6)
      expect(p.box.top).toBeLessThanOrEqual(1e-6)
      expect(p.box.bottom).toBeGreaterThanOrEqual(1920 - 1e-6)
    }
  })

  it('crops the centre of footage that has no subject analysis and reports it', () => {
    const { project, shot } = footageProject()
    const { project: out, clips, unanalysed } = convertToFormat(project, '9:16', { measure })
    expect(clips[shot.id]).toBe('centred')
    expect(unanalysed).toEqual(['city'])
    const p = sourceToCanvas(out.clips[shot.id] as VideoClip, 1, VERTICAL, 0.5, 0.5)
    expect(p.x).toBeCloseTo(540)
    expect(p.y).toBeCloseTo(960)
  })

  it('fits the whole picture in fit mode', () => {
    const { project, shot } = footageProject()
    const { project: out, clips } = convertToFormat(project, '9:16', { measure, reframe: 'fit' })
    expect(clips[shot.id]).toBe('fit')
    const { box } = sourceToCanvas(out.clips[shot.id] as VideoClip, 1, VERTICAL, 0, 0)
    expect(box.right - box.left).toBeCloseTo(1080)
    expect(box.bottom - box.top).toBeCloseTo(1080 * (9 / 16))
    expect((box.top + box.bottom) / 2).toBeCloseTo(960)
  })

  it('applies per-clip offset and zoom on top of the automatic framing', () => {
    const { project, shot } = footageProject()
    withSubject(project, () => ({ x: 0.5, y: 0.5 }))
    const auto = convertToFormat(project, '9:16', { measure }).project.clips[shot.id] as VideoClip
    const moved = convertToFormat(project, '9:16', {
      measure,
      overrides: { [shot.id]: { offsetX: 0.25, zoom: 2 } },
    }).project.clips[shot.id] as VideoClip
    const a = sourceToCanvas(auto, 1, VERTICAL, 0.5, 0.5)
    const b = sourceToCanvas(moved, 1, VERTICAL, 0.5, 0.5)
    expect(a.x).toBeCloseTo(540, 0)
    // A quarter crop width to the right puts the subject a quarter of the frame left of centre.
    expect(b.x).toBeCloseTo(540 - 1080 / 4, 0)
    expect(moved.transform.scaleX.value / auto.transform.scaleX.value).toBeCloseTo(2)
  })

  it('keeps a Ken Burns zoom of the original clip', () => {
    const { project, shot } = footageProject()
    shot.transform.scaleX = {
      value: 1,
      keyframes: [
        { time: 0, value: 1, easing: 'linear' },
        { time: 4, value: 1.5, easing: 'linear' },
      ],
    }
    shot.transform.scaleY = shot.transform.scaleX
    const clip = convertToFormat(project, '9:16', { measure }).project.clips[shot.id] as VideoClip
    const width = (local: number) => {
      const { box } = sourceToCanvas(clip, local, VERTICAL, 0, 0)
      return box.right - box.left
    }
    expect(width(4) / width(0)).toBeCloseTo(1.5, 2)
  })

  it('reframes pillarboxed footage to fill the vertical frame', () => {
    const { project, shot } = footageProject()
    project.assets.city = asset('city', 'video', 1440, 1080)
    shot.fit = 'contain'
    const clip = convertToFormat(project, '9:16', { measure }).project.clips[shot.id] as VideoClip
    const [bw, bh] = fitSize(clip.fit, 1440, 1080, 1080, 1920)
    const m = layerMatrix(clip, 1, 1, bw, bh, 1080, 1920)
    expect(m[3]).toBeGreaterThanOrEqual(1920 - 1e-6)
    expect(m[5]).toBeLessThanOrEqual(1e-6)
  })
})

describe('convertToFormat: text and overlays', () => {
  function withText(text: string, y = 0.85): { project: Project; title: TextClip } {
    const { project } = footageProject()
    const track = createTrack('visual', 'Lyrics')
    project.tracks.unshift(track)
    const title = createTextClip({ trackId: track.id, text, start: 0, duration: 4, style: { fontSize: 64 } })
    title.transform.y = { value: y }
    project.clips[title.id] = title
    return { project, title }
  }

  function textBox(clip: TextClip, canvas: { width: number; height: number }) {
    const fontPx = fontPxFor(clip.style, canvas.height)
    const font = cssFont(clip.style, fontPx)
    const layout = layoutText({
      text: clip.text,
      style: clip.style,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      font,
      padding: 0,
      measure: (s) => measure(s, font),
    })
    const m = layerMatrix(clip, 1, 1, layout.width, layout.height, canvas.width, canvas.height)
    return {
      fontPx,
      lines: layout.lines.length,
      left: m[4],
      right: m[4] + m[0],
      top: m[5],
      bottom: m[5] + m[3],
    }
  }

  function insideSafeArea(box: ReturnType<typeof textBox>) {
    const safe = SAFE_AREAS['9:16']
    expect(box.left).toBeGreaterThanOrEqual(safe.left * 1080 - 1)
    expect(box.right).toBeLessThanOrEqual((1 - safe.right) * 1080 + 1)
    expect(box.top).toBeGreaterThanOrEqual(safe.top * 1920 - 1)
    expect(box.bottom).toBeLessThanOrEqual((1 - safe.bottom) * 1920 + 1)
  }

  it('keeps lyrics the same size against the shorter side, rewrapped inside the safe area', () => {
    const { project, title } = withText('Under the neon skyline we run until the morning')
    const before = textBox(title, { width: 1920, height: 1080 })
    const clip = convertToFormat(project, '9:16', { measure }).project.clips[title.id] as TextClip
    const after = textBox(clip, VERTICAL)
    expect(after.fontPx).toBeCloseTo(before.fontPx)
    expect(after.lines).toBeGreaterThan(before.lines)
    insideSafeArea(after)
  })

  it('shrinks text that would fill the frame, but keeps it legible', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const { project, title } = withText(words, 0.5)
    const clip = convertToFormat(project, '9:16', { measure }).project.clips[title.id] as TextClip
    const after = textBox(clip, VERTICAL)
    expect(after.fontPx).toBeLessThan(64)
    expect(after.fontPx).toBeGreaterThanOrEqual(0.03 * 1080 - 1e-6)
    expect(after.bottom - after.top).toBeLessThanOrEqual(1920 * (1 - 0.12 - 0.2) * 0.5 + 1)
  })

  it('moves a corner picture-in-picture inside the safe area at the same size', () => {
    const { project } = footageProject()
    project.assets.logo = asset('logo', 'image', 400, 400)
    const track = createTrack('visual', 'Logo')
    project.tracks.unshift(track)
    const logo = createImageClip({ trackId: track.id, assetId: 'logo', start: 0, duration: 4 })
    logo.fit = 'contain'
    logo.transform.x = { value: 0.92 }
    logo.transform.y = { value: 0.9 }
    logo.transform.scaleX = { value: 0.2 }
    logo.transform.scaleY = { value: 0.2 }
    project.clips[logo.id] = logo
    const { project: out, clips } = convertToFormat(project, '9:16', { measure })
    expect(clips[logo.id]).toBe('moved')
    const clip = out.clips[logo.id] as VisualClip
    const [bw, bh] = fitSize('contain', 400, 400, 1080, 1920)
    const m = layerMatrix(clip, 1, 1, bw, bh, 1080, 1920)
    // 0.2 of a 1080 px tall contain fit: 216 px, the same against the shorter side.
    expect(m[0]).toBeCloseTo(216)
    const safe = SAFE_AREAS['9:16']
    expect(m[4] + m[0]).toBeLessThanOrEqual((1 - safe.right) * 1080 + 1e-6)
    expect(m[5] + m[3]).toBeLessThanOrEqual((1 - safe.bottom) * 1920 + 1e-6)
  })

  it('leaves full-frame solids and visualizers alone', () => {
    const { project } = footageProject()
    const track = createTrack('visual', 'Visuals')
    project.tracks.unshift(track)
    const solid = createSolidClip({ trackId: track.id, color: '#000000', start: 0, duration: 4 })
    const visualizer: GeneratorClip = {
      ...createSolidClip({ trackId: track.id, color: '#000000', start: 4, duration: 4 }),
      type: 'generator',
      generatorId: 'visualizer.spectrum',
      params: {},
    } as unknown as GeneratorClip
    project.clips[solid.id] = solid
    project.clips[visualizer.id] = visualizer
    const { project: out, clips } = convertToFormat(project, '1:1', { measure })
    expect(out.clips[solid.id]).toBe(solid)
    expect(out.clips[visualizer.id]).toBe(visualizer)
    expect([clips[solid.id], clips[visualizer.id]]).toEqual(['unchanged', 'unchanged'])
  })
})

describe('export settings and outputs', () => {
  it('stores framing overrides per format, drops deleted clips and clears with null', () => {
    const { project, shot } = footageProject()
    const editor = new ProjectEditor(project)
    editor.dispatch(setFramingCommand(editor.getProject(), '9:16', shot.id, { offsetX: 0.3 }))
    editor.dispatch(setFramingCommand(editor.getProject(), '9:16', 'gone', { zoom: 2 }))
    expect(framingOverrides(editor.getProject(), '9:16')).toEqual({ [shot.id]: { offsetX: 0.3 } })
    expect(framingOverrides(editor.getProject(), '1:1')).toEqual({})
    // Planned outputs use the saved framing.
    const spec = newOutput(editor.getProject(), 'video', { aspect: '9:16' })
    const planned = planOutput(editor.getProject(), spec, { measure })
    const plain = planOutput(project, spec, { measure })
    expect((planned.project.clips[shot.id] as VideoClip).transform.x.value).not.toBeCloseTo(
      (plain.project.clips[shot.id] as VideoClip).transform.x.value,
    )
    editor.dispatch(setFramingCommand(editor.getProject(), '9:16', shot.id, null))
    expect(editor.getProject().extensions?.export).toBeUndefined()
    editor.undo()
    expect(framingOverrides(editor.getProject(), '9:16')).toEqual({ [shot.id]: { offsetX: 0.3 } })
  })

  it('suggests the full video and the other orientation, with square and portrait to add', () => {
    const { project } = footageProject()
    const { selected, more } = suggestedOutputs(project)
    expect(selected.map((o) => [o.kind, o.aspect, o.name])).toEqual([
      ['video', '16:9', 'Song'],
      ['video', '9:16', 'Song - Vertical'],
    ])
    expect(more.map((o) => o.aspect)).toEqual(['1:1', '4:5'])
  })

  it('plans frame size, duration and file size for an output', () => {
    const { project } = footageProject()
    const spec = newOutput(project, 'video', { aspect: '9:16', resolution: '720p' })
    const high = planOutput(project, spec, { measure })
    const small = planOutput(project, { ...spec, quality: 'small' }, { measure })
    expect(high.settings).toMatchObject({ width: 720, height: 1280, fps: 30, aspect: '9:16' })
    expect(high.duration).toBe(4)
    expect(high.frames).toBe(120)
    expect(high.fileName).toBe('Song - Vertical.mp4')
    expect(high.estimatedBytes).toBeCloseTo(((high.settings.videoBitrate! + 192_000) * 4) / 8, -3)
    expect(small.estimatedBytes).toBeLessThan(high.estimatedBytes / 2)
  })
})
