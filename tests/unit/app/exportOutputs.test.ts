import { describe, expect, it } from 'vitest'
import { initialItems, outputTitle } from '../../../src/app/screens/export/outputs.ts'
import { newOutput, setOutputsCommand } from '../../../src/export/index.ts'
import { applyCommand, createProject, type Project } from '../../../src/model/index.ts'

function exported(project: Project, specs: ReturnType<typeof newOutput>[]): Project {
  const copy = structuredClone(project)
  applyCommand(copy, setOutputsCommand(copy, specs))
  return copy
}

const listed = (project: Project, items: ReturnType<typeof initialItems>['items']) =>
  items.map((i) => [outputTitle(project, i.spec), i.on])

describe('the export dialog’s starting outputs', () => {
  it('in a new project are the full video, on, and the vertical version, off', () => {
    const project = createProject({ name: 'Song' })
    const { items, selectedId } = initialItems(project)
    expect(listed(project, items)).toEqual([
      ['Full video', true],
      ['Vertical', false],
    ])
    expect(selectedId).toBe(items[0]?.spec.id)
  })

  it('are the outputs the project last exported, all on', () => {
    const project = createProject({ name: 'Song' })
    const saved = exported(project, [
      newOutput(project, 'video'),
      newOutput(project, 'video', { aspect: '9:16' }),
      newOutput(project, 'teaser'),
    ])
    expect(listed(saved, initialItems(saved).items)).toEqual([
      ['Full video', true],
      ['Vertical', true],
      ['Chorus teaser', true],
    ])
  })

  it('turn the vertical version on and select it when the dialog opens for one', () => {
    const project = createProject({ name: 'Song' })
    const { items, selectedId } = initialItems(project, null, 'vertical')
    expect(listed(project, items)).toEqual([
      ['Full video', true],
      ['Vertical', true],
    ])
    expect(selectedId).toBe(items[1]?.spec.id)
  })
})
