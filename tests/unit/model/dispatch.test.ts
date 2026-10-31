import { describe, expect, it } from 'vitest'
import {
  EditError,
  ProjectEditor,
  createProject,
  createVideoClip,
  newId,
  type Asset,
  type EditCommand,
} from '../../../src/model/index.ts'

function setup() {
  const project = createProject({ now: new Date(0) })
  const track = project.tracks.find((t) => t.kind === 'visual')!
  const asset: Asset = {
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
  const clip = createVideoClip({ trackId: track.id, assetId: asset.id, start: 0, duration: 4 })
  return { project, asset, clip }
}

describe('ProjectEditor.dispatch keeps no reference to caller objects', () => {
  it('applies the same command list again after a dry run, including edits to a clip it adds', () => {
    const { project, asset, clip } = setup()
    const keyframe = { time: 0, value: 0, easing: 'linear' as const }
    const commands: EditCommand[] = [
      { type: 'asset.add', asset },
      { type: 'clip.add', clip },
      { type: 'keyframe.set', clipId: clip.id, path: ['opacity'], keyframe },
    ]
    new ProjectEditor(project).dispatch(commands)
    const editor = new ProjectEditor(project)
    editor.dispatch(commands)
    expect(editor.getProject().clips[clip.id]).toMatchObject({ opacity: { keyframes: [keyframe] } })
  })

  it('leaves dispatched objects mutable and independent of the project and its history', () => {
    const { project, asset, clip } = setup()
    const editor = new ProjectEditor(project)
    editor.dispatch([
      { type: 'asset.add', asset },
      { type: 'clip.add', clip },
    ])
    expect(Object.isFrozen(clip)).toBe(false)
    clip.start = 5
    expect(editor.getProject().clips[clip.id]?.start).toBe(0)
    editor.undo()
    editor.redo()
    expect(editor.getProject().clips[clip.id]?.start).toBe(0)
  })

  it('rejects commands that are not serializable and leaves the project unchanged', () => {
    const { project, asset, clip } = setup()
    const editor = new ProjectEditor(project)
    editor.dispatch([
      { type: 'asset.add', asset },
      { type: 'clip.add', clip },
    ])
    const before = editor.getProject()
    expect(() =>
      editor.dispatch({ type: 'clip.set', clipId: clip.id, path: ['name'], value: () => 'not data' }),
    ).toThrow(EditError)
    expect(editor.getProject()).toBe(before)
  })
})
