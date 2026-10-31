import { describe, expect, it } from 'vitest'
import {
  aspectCommands,
  framingOverrides,
  layoutFrameOf,
  projectReframe,
  reframeCommands,
  reframedFrom,
  reframeModeOf,
  reframeOffer,
  setFramingCommand,
  setReframeModeCommand,
} from '../../../src/export/index.ts'
import {
  ProjectEditor,
  createProject,
  createTextClip,
  createTrack,
  createVideoClip,
  settingsForAspect,
  type Asset,
  type AspectPreset,
  type TextClip,
  type VideoClip,
} from '../../../src/model/index.ts'
import { buildVisualAnalysis } from '../../../src/vision/analysisData.ts'
import type { SubjectSample } from '../../../src/vision/types.ts'

const measure = (text: string, font: string) => text.length * Number(/([\d.]+)px/.exec(font)?.[1]) * 0.5

function asset(id: string): Asset {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    mimeType: 'video/mp4',
    byteSize: 1,
    storageKey: id,
    width: 1920,
    height: 1080,
    duration: 8,
    frameRate: 30,
    origin: { type: 'import' },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/** A 16:9 project with a shot whose subject stands right of center, and a lyric line low in the frame. */
function project(o: { subject?: boolean } = {}) {
  const p = createProject({ name: 'Song' })
  p.assets.city = asset('city')
  const shot = createVideoClip({ trackId: p.tracks[0]!.id, assetId: 'city', start: 0, duration: 4 })
  p.clips[shot.id] = shot
  const lyrics = createTrack('visual', 'Lyrics')
  p.tracks.unshift(lyrics)
  const line = createTextClip({ trackId: lyrics.id, text: 'Under the neon skyline', start: 0, duration: 4 })
  line.transform.y = { value: 0.92 }
  p.clips[line.id] = line
  if (o.subject !== false) {
    const samples: SubjectSample[] = []
    for (let t = 0; t <= 8; t += 0.2)
      samples.push({
        t,
        focus: { x: 0.8, y: 0.4 },
        box: { x: 0.75, y: 0.3, width: 0.1, height: 0.3 },
        confidence: 0.9,
        source: 'face',
      })
    p.analysis.visual.city = buildVisualAnalysis({
      assetId: 'city',
      duration: 8,
      sourceSize: { width: 1920, height: 1080 },
      subjects: { version: 1, mediaId: 'city', sourceSize: { width: 1920, height: 1080 }, samples },
    })
  }
  return { editor: new ProjectEditor(p), shot, line }
}

/** Switches the frame as Preview › aspect ratio does, leaving the clips as they are (the offer ignored). */
function switchFrame(editor: ProjectEditor, aspect: AspectPreset) {
  editor.dispatch(aspectCommands(editor.getProject(), settingsForAspect(aspect)))
}

/** Switches the frame and takes the offer to reframe. */
function switchAndReframe(editor: ProjectEditor, aspect: AspectPreset) {
  switchFrame(editor, aspect)
  const project = editor.getProject()
  const reframe = projectReframe(project, { measure, overrides: framingOverrides(project, aspect) })
  editor.dispatch(reframe.commands)
  return reframe
}

describe('reframeCommands', () => {
  it('moves footage onto its subject and text into the safe area of the new frame', () => {
    const { editor, shot, line } = project()
    const reframe = switchAndReframe(editor, '9:16')
    expect(reframe.changed).toEqual({ [shot.id]: 'reframed', [line.id]: 'text' })
    const clip = editor.getProject().clips[shot.id] as VideoClip
    // The subject is right of center, so the picture slides left.
    expect(clip.transform.x.value).toBeLessThan(0.4)
    const text = editor.getProject().clips[line.id] as TextClip
    expect(text.transform.y.value).toBeLessThan(0.8)
    expect(reframedFrom(clip)).toEqual({ aspect: '16:9', width: 1920, height: 1080 })
  })

  it('gives back the original layout when the frame is switched back and reframed again', () => {
    const { editor, shot, line } = project()
    const original = editor.getProject()
    switchAndReframe(editor, '9:16')
    const back = switchAndReframe(editor, '16:9')
    expect(Object.keys(back.changed).sort()).toEqual([shot.id, line.id].sort())
    const now = editor.getProject()
    for (const id of [shot.id, line.id]) {
      const { meta: _meta, ...clip } = now.clips[id]!
      const { meta: _before, ...before } = original.clips[id]!
      expect(clip).toEqual(before)
      expect(now.clips[id]!.meta?.reframe).toBeUndefined()
    }
  })

  it('starts from the original layout for a third frame, not from the last crop', () => {
    const { editor, shot } = project()
    switchAndReframe(editor, '9:16')
    switchAndReframe(editor, '1:1')
    const viaVertical = editor.getProject().clips[shot.id] as VideoClip
    const direct = project()
    switchAndReframe(direct.editor, '1:1')
    expect(viaVertical.transform).toEqual(
      (direct.editor.getProject().clips[direct.shot.id] as VideoClip).transform,
    )
  })

  it('starts from a layout edited by hand since the last reframe', () => {
    const { editor, shot } = project()
    switchAndReframe(editor, '9:16')
    editor.dispatch({ type: 'clip.set', clipId: shot.id, path: ['transform', 'x'], value: { value: 0.3 } })
    expect(reframedFrom(editor.getProject().clips[shot.id] as VideoClip)).toBeNull()
    switchAndReframe(editor, '16:9')
    // Back in 16:9 from a 9:16 crop: the hand-placed crop is kept, so the picture is zoomed in.
    const clip = editor.getProject().clips[shot.id] as VideoClip
    expect(clip.transform.scaleX.value).toBeGreaterThan(1.5)
  })

  it('leaves clips on locked tracks alone and lists footage centred for lack of subject analysis', () => {
    const { editor, shot, line } = project({ subject: false })
    editor.dispatch({ type: 'track.update', trackId: line.trackId, patch: { locked: true } })
    const reframe = switchAndReframe(editor, '9:16')
    expect(reframe.locked).toEqual([line.id])
    expect(reframe.centred).toEqual([shot.id])
    expect(editor.getProject().clips[line.id]).toEqual(line)
  })
})

describe('the offer after a frame change', () => {
  it('reframes from the frame the clips are still laid out for when an earlier offer was ignored', () => {
    const { editor, shot } = project()
    switchFrame(editor, '9:16')
    expect(layoutFrameOf(editor.getProject()).aspect).toBe('16:9')
    switchAndReframe(editor, '1:1')
    const direct = project()
    switchAndReframe(direct.editor, '1:1')
    const viaVertical = editor.getProject().clips[shot.id] as VideoClip
    const fromWide = direct.editor.getProject().clips[direct.shot.id] as VideoClip
    expect(viaVertical.transform).toEqual(fromWide.transform)
    expect(reframedFrom(viaVertical)?.aspect).toBe('16:9')
    expect(layoutFrameOf(editor.getProject()).aspect).toBe('1:1')
    expect(editor.getProject().extensions).toBeUndefined()
  })

  it('offers nothing back in the frame the clips are laid out for, and leaves them untouched', () => {
    const { editor } = project()
    const original = editor.getProject()
    switchFrame(editor, '9:16')
    expect(reframeOffer(editor.getProject())).toBe('reframe')
    switchFrame(editor, '16:9')
    expect(reframeOffer(editor.getProject())).toBeNull()
    const { updatedAt: _now, ...now } = editor.getProject()
    const { updatedAt: _then, ...then } = original
    expect(now).toEqual(then)
  })

  it('offers to restore the layout clips remember for the frame, and restores it', () => {
    const { editor, shot } = project()
    const original = editor.getProject().clips[shot.id]
    switchAndReframe(editor, '9:16')
    expect(reframeOffer(editor.getProject())).toBeNull()
    switchFrame(editor, '16:9')
    expect(reframeOffer(editor.getProject())).toBe('restore')
    switchAndReframe(editor, '16:9')
    const { meta: _meta, ...restored } = editor.getProject().clips[shot.id]!
    const { meta: _before, ...before } = original!
    expect(restored).toEqual(before)
  })
})

describe('reframe mode of a clip', () => {
  it('is set for every format, keeps framing adjustments, and reframes a reframed clip again', () => {
    const { editor, shot } = project()
    editor.dispatch(setFramingCommand(editor.getProject(), '9:16', shot.id, { offsetX: 0.2 }))
    switchAndReframe(editor, '9:16')
    const followed = editor.getProject().clips[shot.id] as VideoClip
    editor.dispatch(setReframeModeCommand(editor.getProject(), [shot.id], 'fit'))
    const withMode = editor.getProject()
    expect(reframeModeOf(withMode, shot.id)).toBe('fit')
    expect(framingOverrides(withMode, '9:16')[shot.id]).toEqual({ offsetX: 0.2, mode: 'fit' })
    expect(framingOverrides(withMode, '1:1')[shot.id]).toEqual({ mode: 'fit' })

    const again = reframeCommands(withMode, withMode.settings, {
      measure,
      overrides: framingOverrides(withMode, '9:16'),
      clipIds: [shot.id],
    })
    expect(again.changed).toEqual({ [shot.id]: 'fit' })
    editor.dispatch(again.commands)
    const fitted = editor.getProject().clips[shot.id] as VideoClip
    expect(fitted.transform.scaleX.value).toBeLessThan(followed.transform.scaleX.value)
    expect(reframedFrom(fitted)?.aspect).toBe('16:9')
  })

  it('remembers the frame of a clip that already fits, so a later choice reframes it', () => {
    const { editor, shot } = project({ subject: false })
    const reframe = switchAndReframe(editor, '9:16')
    expect(reframe.changed[shot.id]).toBeUndefined()
    const p = editor.getProject()
    expect(reframedFrom(p.clips[shot.id] as VideoClip)?.aspect).toBe('16:9')
    const fit = reframeCommands(p, p.settings, {
      measure,
      overrides: { [shot.id]: { mode: 'fit' } },
      clipIds: [shot.id],
    })
    expect(fit.changed).toEqual({ [shot.id]: 'fit' })
  })

  it('does nothing to a clip that was not reframed', () => {
    const { editor, shot } = project()
    const p = editor.getProject()
    const reframe = reframeCommands(p, p.settings, {
      measure,
      overrides: { [shot.id]: { mode: 'fit' } },
      clipIds: [shot.id],
    })
    expect(reframe.commands).toEqual([])
  })
})
