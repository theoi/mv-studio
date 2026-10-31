import { describe, expect, it } from 'vitest'
import { describeChanges, formatTime, previewCommands, summarizeChanges } from '../../../src/director/diff.ts'
import { createTextClip } from '../../../src/model/factory.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { makeProject } from './fixtures.ts'

function withText() {
  const project = makeProject()
  const track = project.tracks.find((t) => t.kind === 'visual')!
  const clip = createTextClip({ trackId: track.id, text: 'Hello there', start: 10, duration: 2 })
  const editor = new ProjectEditor(project)
  editor.dispatch({ type: 'clip.add', clip })
  return { project: editor.getProject(), clip, track }
}

describe('previewCommands', () => {
  it('describes added, changed and removed clips without touching the project', () => {
    const { project, clip, track } = withText()
    const added = createTextClip({ trackId: track.id, text: 'New line', start: 20, duration: 1 })
    const preview = previewCommands(project, [
      { type: 'clip.add', clip: added },
      { type: 'clip.move', moves: [{ clipId: clip.id, start: 12.5 }] },
      { type: 'clip.set', clipId: clip.id, path: ['style', 'color'], value: '#ff0000' },
    ])
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.summary).toBe('Adds 1 clip, changes 1 clip.')
    const change = preview.items.find((i) => i.action === 'change')!
    expect(change.label).toBe('Text "Hello there" at 0:12.5')
    expect(change.details).toEqual(['starts at 0:12.5 (was 0:10.0)', 'text color "#ff0000" (was "#ffffff")'])
    expect(change.range).toEqual({ start: 10, end: 14.5 })
    expect(preview.items.find((i) => i.action === 'add')?.label).toBe('Text "New line" at 0:20.0')
    expect(project.clips[clip.id]?.start).toBe(10)
  })

  it('reports an invalid command instead of applying part of the change', () => {
    const { project, clip } = withText()
    const preview = previewCommands(project, [
      { type: 'clip.move', moves: [{ clipId: clip.id, start: 3 }] },
      { type: 'clip.remove', clipIds: ['missing'] },
    ])
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.error.code).toBe('not-found')
  })

  it('names effects, keyframes and audio reactions that change', () => {
    const { project, clip } = withText()
    const editor = new ProjectEditor(project)
    editor.dispatch([
      {
        type: 'effect.add',
        clipId: clip.id,
        effect: { id: 'fx', effectId: 'glow', enabled: true, params: {} },
      },
      {
        type: 'keyframe.set',
        clipId: clip.id,
        path: ['opacity'],
        keyframe: { time: 0, value: 0, easing: 'linear' },
      },
      {
        type: 'clip.set',
        clipId: clip.id,
        path: ['transform', 'scaleX', 'modulation'],
        value: [{ source: { kind: 'beat' }, amount: 0.1, mode: 'multiply', smoothing: 0.2 }],
      },
    ])
    const [item] = describeChanges(project, editor.getProject())
    expect(item?.details).toEqual([
      'effect glow added',
      'animation added to opacity',
      'music reaction added to width scale',
    ])
  })

  it('summarizes several kinds of change in one sentence', () => {
    const { summary } = summarizeChanges([
      { action: 'add', target: 'clip', label: '', details: [] },
      { action: 'add', target: 'clip', label: '', details: [] },
      { action: 'add', target: 'track', label: '', details: [] },
      { action: 'remove', target: 'clip', label: '', details: [] },
    ])
    expect(summary).toBe('Adds 2 clips and 1 track, removes 1 clip.')
    expect(summarizeChanges([]).summary).toBe('No changes.')
  })

  it('formats times as minutes and tenths', () => {
    expect(formatTime(65.24)).toBe('1:05.2')
    expect(formatTime(7)).toBe('0:07.0')
  })
})
