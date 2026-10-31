import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEffectInstance, createGeneratorClip } from '../../../src/plugins/library.ts'
import { createTextClip } from '../../../src/model/index.ts'
import { animatableRow, reactionTarget } from '../../../src/app/screens/editor/inspector/animatable.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'

describe('react button targets', () => {
  it('maps inspector properties to what reacts to the music', () => {
    const text = createTextClip({ trackId: 't', text: 'Hi', start: 0, duration: 2 })
    const glow = createEffectInstance('glow')
    const clip = { ...text, effects: [glow] }
    expect(reactionTarget(clip, ['opacity'])).toEqual({ clipId: clip.id, property: 'opacity' })
    // Scale reacts on both axes from the one Scale row.
    expect(reactionTarget(clip, ['transform', 'scaleX'])).toEqual({ clipId: clip.id, property: 'scale' })
    expect(reactionTarget(clip, ['transform', 'x'])).toEqual({ clipId: clip.id, property: 'x' })
    expect(reactionTarget(clip, ['adjustments', 'contrast'])).toEqual({
      clipId: clip.id,
      property: 'adjustments.contrast',
    })
    expect(reactionTarget(clip, ['effects', 0, 'params', 'intensity'])).toEqual({
      clipId: clip.id,
      effectInstanceId: glow.id,
      param: 'intensity',
    })
    expect(reactionTarget(clip, ['effects', 1, 'params', 'intensity'])).toBeNull()
    expect(reactionTarget(clip, ['transform', 'anchorX'])).toBeNull()
    expect(reactionTarget(clip, ['style', 'fontSize'])).toBeNull()
    const bars = createGeneratorClip({
      trackId: 't',
      generatorId: 'visualizer.spectrum',
      start: 0,
      duration: 4,
    })
    expect(reactionTarget(bars, ['params', 'height'])).toEqual({ clipId: bars.id, param: 'height' })
  })
})

describe('a row for a property the clip lacks', () => {
  beforeEach(() => loadDemoProject())
  // The keyframe toast times itself out with window.setTimeout.
  beforeEach(() => vi.stubGlobal('window', { setTimeout: () => 0 }))
  afterEach(() => vi.unstubAllGlobals())

  const bareText = () => {
    const project = editor.getProject()
    const clip = Object.values(project.clips).find((c) => c.type === 'text' && !c.adjustments?.contrast)
    if (clip?.type !== 'text') throw new Error('The demo project has no text clip without contrast')
    return clip
  }

  it('creates the property on the first edit, which then coalesces into one undo step', () => {
    const clip = bareText()
    const row = animatableRow(clip, ['adjustments', 'contrast'], 0)
    expect(row.value).toBe(0)
    row.set(0.2)
    animatableRow(editor.getProject().clips[clip.id]!, ['adjustments', 'contrast'], 0).set(0.4)
    row.commit()
    const after = editor.getProject().clips[clip.id]
    expect(after?.type === 'text' && after.adjustments?.contrast?.value).toBe(0.4)
    editor.undo()
    const undone = editor.getProject().clips[clip.id]
    expect(undone?.type === 'text' && undone.adjustments?.contrast).toBeFalsy()
  })

  it('creates the property with its fallback value when a keyframe is added', () => {
    const clip = bareText()
    animatableRow(clip, ['adjustments', 'contrast'], 0).key()
    const after = editor.getProject().clips[clip.id]
    expect(after?.type === 'text' && after.adjustments?.contrast).toMatchObject({
      value: 0,
      keyframes: [{ value: 0 }],
    })
  })
})
