import { describe, expect, it } from 'vitest'
import { createEffectInstance, createGeneratorClip } from '../../../src/plugins/library.ts'
import { createTextClip } from '../../../src/model/index.ts'
import { reactionTarget } from '../../../src/app/screens/editor/inspector/animatable.ts'

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
