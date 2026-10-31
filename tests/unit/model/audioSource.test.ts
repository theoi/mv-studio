import { describe, expect, it } from 'vitest'
import {
  EditError,
  ProjectEditor,
  createProject,
  createSolidClip,
  type GeneratorClip,
} from '../../../src/model/index.ts'

function setup() {
  const project = createProject({ now: new Date(0) })
  const visual = project.tracks.find((t) => t.kind === 'visual')!
  const { color: _color, ...base } = createSolidClip({
    trackId: visual.id,
    color: '#000',
    start: 0,
    duration: 4,
  })
  const generator: GeneratorClip = {
    ...base,
    type: 'generator',
    generatorId: 'visualizer.spectrum',
    params: {},
  }
  const solid = createSolidClip({ trackId: visual.id, color: '#fff', start: 4, duration: 4 })
  const editor = new ProjectEditor(project)
  editor.dispatch([
    { type: 'clip.add', clip: generator },
    { type: 'clip.add', clip: solid },
  ])
  return { editor, generator, solid }
}

describe('clip.setAudioSource', () => {
  it('picks a stem for a generator clip and goes back to the mix, one undo step each', () => {
    const { editor, generator } = setup()
    editor.dispatch({ type: 'clip.setAudioSource', clipId: generator.id, source: { stem: 'drums' } })
    expect(editor.getProject().clips[generator.id]).toMatchObject({ audio: { stem: 'drums' } })
    editor.dispatch({ type: 'clip.setAudioSource', clipId: generator.id, source: null })
    expect('audio' in editor.getProject().clips[generator.id]!).toBe(false)
    editor.undo()
    expect(editor.getProject().clips[generator.id]).toMatchObject({ audio: { stem: 'drums' } })
    editor.undo()
    expect('audio' in editor.getProject().clips[generator.id]!).toBe(false)
  })

  it('rejects other clip types and unknown stems without changing the project', () => {
    const { editor, generator, solid } = setup()
    const before = editor.getProject()
    expect(() =>
      editor.dispatch({ type: 'clip.setAudioSource', clipId: solid.id, source: { stem: 'drums' } }),
    ).toThrow(EditError)
    expect(() =>
      editor.dispatch({
        type: 'clip.setAudioSource',
        clipId: generator.id,
        source: { stem: 'guitar' as never },
      }),
    ).toThrow(EditError)
    expect(editor.getProject()).toBe(before)
  })
})
