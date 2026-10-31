import { describe, expect, it } from 'vitest'
import { EditError, ProjectEditor, createProject } from '../../../src/model/index.ts'

describe('project.setExtension keys', () => {
  it('accepts feature ids', () => {
    const editor = new ProjectEditor(createProject())
    for (const key of ['vj', 'audio.stems', 'look-presets'])
      editor.dispatch({ type: 'project.setExtension', key, value: 1 })
    expect(Object.keys(editor.getProject().extensions ?? {})).toEqual(['vj', 'audio.stems', 'look-presets'])
  })

  it('rejects keys that are not feature ids, including __proto__', () => {
    const editor = new ProjectEditor(createProject())
    for (const key of ['__proto__', '', 'Vj', 'two words', '.vj', 'vj.'])
      expect(
        () => editor.dispatch({ type: 'project.setExtension', key, value: { polluted: true } }),
        key,
      ).toThrow(EditError)
    expect(editor.getProject().extensions).toBeUndefined()
  })
})
