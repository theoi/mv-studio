import { describe, expect, it } from 'vitest'
import {
  EditError,
  ProjectEditor,
  anim,
  createAudioClip,
  createProject,
  createTextClip,
  createVideoClip,
  newId,
  parseProject,
  type Asset,
  type Project,
} from '../../../src/model/index.ts'

function videoAsset(): Asset {
  return {
    id: newId(),
    kind: 'video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    byteSize: 1000,
    storageKey: 'media/clip.mp4',
    duration: 20,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
}

function setup() {
  const project = createProject({ now: new Date(0) })
  const editor = new ProjectEditor(project, { now: () => new Date(1000) })
  const visual = project.tracks.find((t) => t.kind === 'visual')!
  const audio = project.tracks.find((t) => t.kind === 'audio')!
  const asset = videoAsset()
  editor.dispatch({ type: 'asset.add', asset })
  return { editor, visual, audio, asset, initial: project }
}

describe('ProjectEditor', () => {
  it('undoes and redoes a clip add, producing new immutable projects', () => {
    const { editor, visual, asset } = setup()
    const before = editor.getProject()
    const clip = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 2, duration: 4 })
    editor.dispatch({ type: 'clip.add', clip })
    const after = editor.getProject()
    expect(after).not.toBe(before)
    expect(after.clips[clip.id]?.start).toBe(2)
    expect(before.clips[clip.id]).toBeUndefined()

    expect(editor.undo()).toBe(true)
    expect(editor.getProject().clips[clip.id]).toBeUndefined()
    expect(editor.redo()).toBe(true)
    expect(editor.getProject().clips[clip.id]?.start).toBe(2)
  })

  it('lists undo and redo step labels, the next one to undo or redo first', () => {
    const { editor, visual, asset } = setup()
    const clip = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    editor.dispatch({ type: 'clip.add', clip }, { label: 'Add clip' })
    editor.dispatch({ type: 'clip.move', moves: [{ clipId: clip.id, start: 1 }] }, { label: 'Move clip' })
    editor.dispatch({ type: 'clip.move', moves: [{ clipId: clip.id, start: 2 }] }, { label: 'Move again' })
    editor.undo()
    expect(editor.history()).toEqual({
      undo: ['Move clip', 'Add clip', 'Import media'],
      redo: ['Move again'],
    })
    editor.undo()
    expect(editor.history().redo).toEqual(['Move clip', 'Move again'])
  })

  it('merges a drag gesture into one undo step via coalesceKey', () => {
    const { editor, visual, asset } = setup()
    const clip = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    editor.dispatch({ type: 'clip.add', clip })
    for (const start of [0.5, 1, 1.5, 2]) {
      editor.dispatch({ type: 'clip.move', moves: [{ clipId: clip.id, start }] }, { coalesceKey: 'drag-1' })
    }
    editor.endGesture()
    expect(editor.getProject().clips[clip.id]?.start).toBe(2)
    expect(editor.undoLabel()).toBe('Move clip')
    editor.undo()
    expect(editor.getProject().clips[clip.id]?.start).toBe(0)
    editor.undo()
    expect(editor.getProject().clips[clip.id]).toBeUndefined()
  })

  it('rejects an invalid batch atomically without a history entry', () => {
    const { editor, visual, asset } = setup()
    const before = editor.getProject()
    const ok = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    expect(() =>
      editor.dispatch([
        { type: 'clip.add', clip: ok },
        { type: 'clip.remove', clipIds: ['missing'] },
      ]),
    ).toThrow(EditError)
    expect(editor.getProject()).toBe(before)
    expect(editor.undoLabel()).toBe('Import media')
  })

  it('notifies subscribers with the change source', () => {
    const { editor } = setup()
    const sources: string[] = []
    editor.subscribe((_p, change) => sources.push(change.source))
    editor.dispatch({ type: 'project.rename', name: 'My video' })
    editor.undo()
    editor.redo()
    expect(sources).toEqual(['edit', 'undo', 'redo'])
    expect(editor.getProject().name).toBe('My video')
    expect(editor.getProject().updatedAt).toBe(new Date(1000).toISOString())
  })

  it('keeps derived writes out of history, and undo and redo around them leave them in place', () => {
    const { editor, visual, asset } = setup()
    const clip = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    editor.dispatch({ type: 'clip.add', clip })
    const sources: string[] = []
    editor.subscribe((_p, change) => sources.push(change.source))
    const analysis = { assetId: asset.id, version: 'test', data: { motion: [1, 2] } }
    editor.dispatch({ type: 'analysis.setVisual', analysis }, { history: 'skip' })
    expect(editor.undoLabel()).toBe('Add clip')
    editor.dispatch({ type: 'project.rename', name: 'Renamed' })

    const derived = () => editor.getProject().analysis.visual[asset.id]
    editor.undo()
    expect(editor.getProject().name).toBe('Untitled video')
    expect(derived()).toEqual(analysis)
    editor.undo()
    expect(editor.getProject().clips[clip.id]).toBeUndefined()
    expect(derived()).toEqual(analysis)
    editor.redo()
    editor.redo()
    expect(editor.getProject().clips[clip.id]?.start).toBe(0)
    expect(editor.getProject().name).toBe('Renamed')
    expect(derived()).toEqual(analysis)
    expect(sources).toEqual(['derived', 'edit', 'undo', 'undo', 'redo', 'redo'])
  })

  it('a derived write neither clears redo nor ends a gesture being coalesced', () => {
    const { editor, visual, asset } = setup()
    const analysis = (v: number) => ({ assetId: asset.id, version: 'test', data: { v } })
    editor.dispatch({ type: 'project.rename', name: 'A' })
    editor.undo()
    editor.dispatch({ type: 'analysis.setVisual', analysis: analysis(1) }, { history: 'skip' })
    expect(editor.redo()).toBe(true)
    expect(editor.getProject().name).toBe('A')

    const clip = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    editor.dispatch({ type: 'clip.add', clip })
    editor.dispatch({ type: 'clip.move', moves: [{ clipId: clip.id, start: 1 }] }, { coalesceKey: 'drag' })
    editor.dispatch({ type: 'analysis.setVisual', analysis: analysis(2) }, { history: 'skip' })
    editor.dispatch({ type: 'clip.move', moves: [{ clipId: clip.id, start: 2 }] }, { coalesceKey: 'drag' })
    editor.endGesture()
    editor.undo()
    expect(editor.getProject().clips[clip.id]?.start).toBe(0)
    expect(editor.getProject().analysis.visual[asset.id]?.data).toEqual({ v: 2 })
  })
})

describe('edit commands', () => {
  it('shifts sourceStart when trimming the start edge of a media clip', () => {
    const { editor, visual, asset } = setup()
    const clip = createVideoClip({
      trackId: visual.id,
      assetId: asset.id,
      start: 2,
      duration: 6,
      sourceStart: 1,
    })
    editor.dispatch({ type: 'clip.add', clip })
    editor.dispatch({ type: 'clip.trim', clipId: clip.id, start: 3, duration: 5 })
    const trimmed = editor.getProject().clips[clip.id]
    expect(trimmed).toMatchObject({ start: 3, duration: 5, sourceStart: 2 })
  })

  it('splits a clip and re-bases source offset and keyframes of the right part', () => {
    const { editor, visual, asset } = setup()
    const clip = createVideoClip({
      trackId: visual.id,
      assetId: asset.id,
      start: 10,
      duration: 4,
      sourceStart: 1,
    })
    clip.opacity = {
      value: 1,
      keyframes: [
        { time: 0, value: 0, easing: 'linear' },
        { time: 3, value: 1, easing: 'linear' },
      ],
    }
    editor.dispatch({ type: 'clip.add', clip })
    const rightId = newId()
    editor.dispatch({ type: 'clip.split', clipId: clip.id, time: 11, newClipId: rightId })
    const p = editor.getProject()
    expect(p.clips[clip.id]?.duration).toBe(1)
    const right = p.clips[rightId]
    expect(right).toMatchObject({ start: 11, duration: 3, sourceStart: 2 })
    expect(right && 'opacity' in right ? right.opacity.keyframes?.map((k) => k.time) : null).toEqual([-1, 2])
  })

  it('blocks edits on locked tracks', () => {
    const { editor, visual, asset } = setup()
    const clip = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    editor.dispatch({ type: 'clip.add', clip })
    editor.dispatch({ type: 'track.update', trackId: visual.id, patch: { locked: true } })
    expect(() => editor.dispatch({ type: 'clip.move', moves: [{ clipId: clip.id, start: 5 }] })).toThrow(
      /locked/,
    )
  })

  it('keeps audio clips off visual tracks', () => {
    const { editor, visual, asset } = setup()
    const clip = createAudioClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    expect(() => editor.dispatch({ type: 'clip.add', clip })).toThrow(/cannot go on a visual track/)
  })

  it('removing an asset removes its clips and analysis', () => {
    const { editor, visual, audio, asset } = setup()
    const v = createVideoClip({ trackId: visual.id, assetId: asset.id, start: 0, duration: 4 })
    const a = createAudioClip({ trackId: audio.id, assetId: asset.id, start: 0, duration: 4 })
    editor.dispatch([
      { type: 'clip.add', clip: v },
      { type: 'clip.add', clip: a },
      { type: 'project.setSong', assetId: asset.id },
      { type: 'analysis.setAudio', analysis: { assetId: asset.id, version: 't', beats: [0.5, 1] } },
    ])
    editor.dispatch({ type: 'asset.remove', assetId: asset.id })
    const p = editor.getProject()
    expect(Object.keys(p.clips)).toEqual([])
    expect(p.songAssetId).toBeUndefined()
    expect(p.analysis.audio[asset.id]).toBeUndefined()
  })

  it('sets keyframes sorted by time and replaces one at the same time', () => {
    const { editor, visual } = setup()
    const text = createTextClip({ trackId: visual.id, text: 'Hello', start: 0, duration: 4 })
    editor.dispatch({ type: 'clip.add', clip: text })
    const path = ['transform', 'x']
    editor.dispatch({
      type: 'keyframe.set',
      clipId: text.id,
      path,
      keyframe: { time: 2, value: 0.8, easing: 'ease-in-out' },
    })
    editor.dispatch({
      type: 'keyframe.set',
      clipId: text.id,
      path,
      keyframe: { time: 0, value: 0.2, easing: 'linear' },
    })
    editor.dispatch({
      type: 'keyframe.set',
      clipId: text.id,
      path,
      keyframe: { time: 2, value: 0.9, easing: 'linear' },
    })
    const clip = editor.getProject().clips[text.id]
    const keys = clip && clip.type === 'text' ? clip.transform.x.keyframes : undefined
    expect(keys?.map((k) => [k.time, k.value])).toEqual([
      [0, 0.2],
      [2, 0.9],
    ])
  })

  it('sets nested properties by path but protects identity fields', () => {
    const { editor, visual } = setup()
    const text = createTextClip({ trackId: visual.id, text: 'Hi', start: 0, duration: 2 })
    editor.dispatch({ type: 'clip.add', clip: text })
    editor.dispatch({ type: 'clip.set', clipId: text.id, path: ['style', 'color'], value: '#ff0000' })
    editor.dispatch({ type: 'clip.set', clipId: text.id, path: ['opacity'], value: anim(0.5) })
    const clip = editor.getProject().clips[text.id]
    expect(clip?.type === 'text' && clip.style.color).toBe('#ff0000')
    expect(clip?.type === 'text' && clip.opacity.value).toBe(0.5)
    expect(() =>
      editor.dispatch({ type: 'clip.set', clipId: text.id, path: ['trackId'], value: 'x' }),
    ).toThrow(EditError)
  })
})

describe('project extensions', () => {
  it('sets, replaces and removes a feature entry as undoable edits that survive save and load', () => {
    const { editor } = setup()
    editor.dispatch({ type: 'project.setExtension', key: 'vj', value: { pads: ['a'] } })
    editor.dispatch({ type: 'project.setExtension', key: 'other', value: 1 })
    editor.dispatch({ type: 'project.setExtension', key: 'vj', value: { pads: ['b'] } })
    expect(editor.getProject().extensions).toEqual({ vj: { pads: ['b'] }, other: 1 })
    const saved = parseProject(JSON.parse(JSON.stringify(editor.getProject())))
    expect(saved.extensions).toEqual({ vj: { pads: ['b'] }, other: 1 })

    editor.dispatch({ type: 'project.setExtension', key: 'vj', value: null })
    editor.dispatch({ type: 'project.setExtension', key: 'other', value: null })
    expect(editor.getProject().extensions).toBeUndefined()
    editor.undo()
    expect(editor.getProject().extensions).toEqual({ other: 1 })
    editor.undo()
    editor.undo()
    expect(editor.getProject().extensions).toEqual({ vj: { pads: ['a'] }, other: 1 })
  })

  it('rejects an empty key', () => {
    const { editor } = setup()
    expect(() => editor.dispatch({ type: 'project.setExtension', key: '', value: 1 })).toThrow(EditError)
  })
})

describe('parseProject', () => {
  it('accepts a current project and rejects newer or malformed data', () => {
    const project: Project = createProject()
    expect(parseProject(JSON.parse(JSON.stringify(project))).id).toBe(project.id)
    expect(() => parseProject({ ...project, schemaVersion: 99 })).toThrow(/newer version/)
    expect(() => parseProject({ schemaVersion: 1 })).toThrow(/missing/)
    expect(() => parseProject('nope')).toThrow(/Not a project/)
  })

  it('drops the downbeats a version 1 project stored from the fast analysis, keeping refined and user bars', () => {
    const analysis = (confidence: number) => ({
      assetId: `a${confidence}`,
      version: 'mvs-audio-2',
      tempo: { bpm: 120, confidence },
      beats: [0, 0.5, 1, 1.5, 2],
      downbeats: [0, 2],
    })
    const v1 = {
      ...JSON.parse(JSON.stringify(createProject())),
      schemaVersion: 1,
      analysis: {
        audio: { a0: analysis(0.6), a1: analysis(0.8), a2: analysis(0.95), a3: analysis(1) },
        visual: {},
      },
    }
    const project = parseProject(v1)
    expect(project.schemaVersion).toBe(2)
    const audio = project.analysis.audio
    expect(audio.a0).toEqual({ ...analysis(0.6), downbeats: undefined })
    expect('downbeats' in (audio.a0 ?? {})).toBe(false)
    expect(audio.a1?.downbeats).toBeUndefined()
    expect(audio.a1?.beats).toEqual([0, 0.5, 1, 1.5, 2])
    expect(audio.a2?.downbeats).toEqual([0, 2])
    expect(audio.a3?.downbeats).toEqual([0, 2])
  })
})
