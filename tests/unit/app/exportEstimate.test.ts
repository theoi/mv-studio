import { describe, expect, it } from 'vitest'
import { drawnKey } from '../../../src/app/state/exportEstimate.ts'
import { createProject, ProjectEditor } from '../../../src/model/index.ts'

describe('what an export time trial is kept for', () => {
  it('stays the same through an analysis write, which stamps the project too, and changes when the drawing does', () => {
    const p = createProject()
    p.songAssetId = 'song'
    p.analysis.audio.song = {
      assetId: 'song',
      version: 'test',
      tempo: { bpm: 120, confidence: 1 },
      beats: [0, 0.5],
    }
    let ms = Date.parse(p.updatedAt)
    const editor = new ProjectEditor(p, { now: () => new Date((ms += 1000)) })
    const before = drawnKey(editor.getProject())
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: 'song',
        grid: { tempo: { bpm: 128, confidence: 1 }, beats: [0, 0.47] },
      },
      { history: 'skip' },
    )
    expect(editor.getProject().updatedAt).not.toBe(p.updatedAt)
    expect(drawnKey(editor.getProject())).toBe(before)
    editor.dispatch({ type: 'project.updateSettings', settings: { backgroundColor: '#ff0000' } })
    expect(drawnKey(editor.getProject())).not.toBe(before)
  })
})
