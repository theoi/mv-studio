import { describe, expect, it } from 'vitest'
import { cameraPoseAt } from '../../../../src/vision/render/camera.ts'
import { cameraEffectUniforms } from '../../../../src/vision/render/cameraEffect.ts'

describe('cameraEffectUniforms', () => {
  it('passes the pose of the selected move at the current progress', () => {
    const uniforms = cameraEffectUniforms({
      preset: 'ken-burns',
      progress: 0.7,
      intensity: 0.8,
      focus: 0.3,
      depth: '',
    })
    const pose = cameraPoseAt({ preset: 'ken-burns', intensity: 0.8, focus: 0.3 }, 0.7)
    expect(uniforms).toEqual({
      cameraOffset: [pose.offsetX, pose.offsetY],
      cameraPan: [pose.panX, pose.panY],
      cameraZoom: pose.zoom,
      cameraDolly: pose.dolly,
      cameraFocus: 0.3,
    })
    expect(pose.offsetX).not.toBe(pose.offsetY)
    expect(pose.panX).not.toBe(pose.panY)
  })

  it('falls back to the default move for an unknown preset', () => {
    const params = { progress: 1, intensity: 1, focus: 0.5 }
    expect(cameraEffectUniforms({ ...params, preset: 'spin' })).toEqual(
      cameraEffectUniforms({ ...params, preset: 'dolly-in' }),
    )
    expect(cameraEffectUniforms({ ...params, preset: 'dolly-in' }).cameraZoom).toBeGreaterThan(1.1)
  })
})
