import { describe, expect, it } from 'vitest'
import { storageKeysOf } from '../../../src/media/projectStore.ts'
import { createProject, ProjectEditor, type Asset, type Project } from '../../../src/model/index.ts'

const image = (id: string): Asset => ({
  id,
  kind: 'image',
  name: `${id}.png`,
  mimeType: 'image/png',
  byteSize: 1,
  storageKey: `media/${id}/${id}.png`,
  width: 1,
  height: 1,
  origin: { type: 'import' },
  createdAt: new Date(0).toISOString(),
})

const withHistory = (project: Project, undoHistory: unknown) => ({ ...project, undoHistory }) as Project

describe('the media a stored project uses', () => {
  it('includes what its saved undo and redo steps can bring back', () => {
    const editor = new ProjectEditor(createProject())
    editor.dispatch({ type: 'asset.add', asset: image('kept') })
    editor.dispatch({ type: 'asset.add', asset: image('removed') })
    editor.dispatch({ type: 'asset.remove', assetId: 'removed' })
    editor.dispatch({ type: 'asset.add', asset: image('undone') })
    editor.undo()
    expect(Object.keys(editor.getProject().assets)).toEqual(['kept'])
    const record = withHistory(editor.getProject(), editor.savedHistory())
    expect(new Set(storageKeysOf(record))).toEqual(
      new Set(['media/kept/kept.png', 'media/removed/removed.png', 'media/undone/undone.png']),
    )
  })

  it('reads steps that replace all the assets or an asset’s storage key', () => {
    const project = { ...createProject(), assets: { a: image('a') } }
    const step = (patches: unknown[]) => ({ label: 'Step', patches, inversePatches: [] })
    const record = withHistory(project, {
      updatedAt: project.updatedAt,
      undo: [step([{ op: 'replace', path: ['assets'], value: { b: image('b') } }])],
      redo: [step([{ op: 'replace', path: ['assets', 'a', 'storageKey'], value: 'media/a/moved.png' }])],
    })
    expect(new Set(storageKeysOf(record))).toEqual(
      new Set(['media/a/a.png', 'media/b/b.png', 'media/a/moved.png']),
    )
  })

  it('leaves out a history it can’t read, which is never restored either', () => {
    const project = { ...createProject(), assets: { a: image('a') } }
    expect(
      storageKeysOf(withHistory(project, { updatedAt: project.updatedAt, undo: 'steps', redo: [] })),
    ).toEqual(['media/a/a.png'])
  })
})
