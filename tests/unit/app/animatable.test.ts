import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEffectInstance, createGeneratorClip } from '../../../src/plugins/library.ts'
import { createTextClip } from '../../../src/model/index.ts'
import {
  animatableRow,
  reactionTarget,
  settingName,
} from '../../../src/app/screens/editor/inspector/animatable.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { set as setUi } from '../../../src/app/state/ui.ts'

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

  it('names the setting in the undo label', () => {
    const clip = bareText()
    animatableRow(clip, ['adjustments', 'contrast'], 0, { label: 'Contrast' }).set(0.3)
    expect(editor.undoLabel()).toBe('Change contrast')
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

describe('a keyframed row', () => {
  beforeEach(() => loadDemoProject())
  beforeEach(() => vi.stubGlobal('window', { setTimeout: () => 0 }))
  afterEach(() => vi.unstubAllGlobals())

  const textClip = (id: string) => {
    const clip = editor.getProject().clips[id]
    if (clip?.type !== 'text') throw new Error('expected a text clip')
    return clip
  }
  /** A text clip whose opacity goes from 0 at its start to 1 two seconds in, linearly. */
  const fading = () => {
    const project = editor.getProject()
    const clip = Object.values(project.clips).find(
      (c) =>
        c.type === 'text' &&
        !c.opacity.keyframes?.length &&
        !project.tracks.find((track) => track.id === c.trackId)?.locked,
    )
    if (!clip) throw new Error('The demo project has no unlocked text clip without keyframes')
    for (const [time, value] of [
      [0, 0],
      [2, 1],
    ] as const)
      editor.dispatch({
        type: 'keyframe.set',
        clipId: clip.id,
        path: ['opacity'],
        keyframe: { time, value, easing: 'linear' },
      })
    return textClip(clip.id)
  }
  const opacityOf = (id: string) => textClip(id).opacity

  it('shows the value at the playhead', () => {
    const clip = fading()
    expect(animatableRow(clip, ['opacity'], undefined, { playhead: clip.start + 0.5 }).value).toBe(0.25)
    expect(animatableRow(clip, ['opacity'], undefined, { playhead: clip.start + 3 }).value).toBe(1)
  })

  it('the keyframe button is pressed only with a keyframe at the playhead', () => {
    const clip = fading()
    const at = (t: number) =>
      animatableRow(clip, ['opacity'], undefined, { playhead: clip.start + t }).buttons
    expect(at(2)).toMatchObject({ keyed: true, keyAtPlayhead: true })
    expect(at(1)).toMatchObject({ keyed: true, keyAtPlayhead: false })
  })

  it('an edit between keyframes adds one at the playhead, as one undo step per gesture', () => {
    const clip = fading()
    const before = opacityOf(clip.id)
    setUi({ playhead: clip.start + 1 })
    const row = animatableRow(clip, ['opacity'], undefined, { label: 'Opacity' })
    row.set(0.8)
    row.set(0.9)
    row.commit()
    expect(opacityOf(clip.id)).toEqual({
      ...before,
      keyframes: [
        { time: 0, value: 0, easing: 'linear' },
        { time: 1, value: 0.9, easing: 'ease-in-out' },
        { time: 2, value: 1, easing: 'linear' },
      ],
    })
    expect(editor.undoLabel()).toBe('Change opacity')
    editor.undo()
    expect(opacityOf(clip.id)).toEqual(before)
  })

  it('an edit at a keyframe changes its value and keeps its time and easing', () => {
    const clip = fading()
    setUi({ playhead: clip.start + 2.002 })
    animatableRow(clip, ['opacity']).set(0.6)
    expect(opacityOf(clip.id).keyframes).toEqual([
      { time: 0, value: 0, easing: 'linear' },
      { time: 2, value: 0.6, easing: 'linear' },
    ])
  })

  it('the keyframe button keys the value at the playhead', () => {
    const clip = fading()
    setUi({ playhead: clip.start + 1.5 })
    animatableRow(clip, ['opacity']).key()
    expect(opacityOf(clip.id).keyframes?.[1]).toEqual({ time: 1.5, value: 0.75, easing: 'ease-in-out' })
  })

  it('Scale keys and edits both axes', () => {
    const clip = fading()
    const scale = () => [textClip(clip.id).transform.scaleX, textClip(clip.id).transform.scaleY]
    const row = () =>
      animatableRow(textClip(clip.id), ['transform', 'scaleX'], undefined, {
        linked: [['transform', 'scaleY']],
      })
    setUi({ playhead: clip.start })
    row().key()
    setUi({ playhead: clip.start + 2 })
    row().set(1.5)
    expect(scale().map((s) => s.keyframes?.map((k) => [k.time, k.value]))).toEqual([
      [
        [0, 1],
        [2, 1.5],
      ],
      [
        [0, 1],
        [2, 1.5],
      ],
    ])
  })
})

describe('a setting name', () => {
  it('names the setting with its effect without repeating a word where they meet', () => {
    expect(settingName('Amount', 'RGB split')).toBe('RGB split amount')
    expect(settingName('Grade', 'Color grade')).toBe('Color grade')
    expect(settingName('Grain size', 'Film grain')).toBe('Film grain size')
  })
})
