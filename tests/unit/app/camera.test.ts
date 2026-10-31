import { beforeEach, describe, expect, it } from 'vitest'
import type { ImageClip } from '../../../src/model/index.ts'
import {
  cameraMoveOf,
  cameraTargets,
  motionOf,
  removeCameraMove,
  setCameraMove,
  smearNote,
  smearingMoves,
  stillClips,
  undoCameraMoves,
} from '../../../src/app/state/camera.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'

beforeEach(() => loadDemoProject())

const cameraEffect = (id: string) => ({ id, effectId: 'camera-3d', enabled: true, params: {} })

it('applies to the selected still, else to every still without a camera move', () => {
  const stills = stillClips(editor.getProject())
  expect(stills.length).toBeGreaterThan(1)
  const [first, second] = stills
  editor.dispatch({ type: 'effect.add', clipId: first!.id, effect: cameraEffect('fx'), index: 0 })
  const project = editor.getProject()

  expect(cameraTargets(project, { type: 'none' }).map((c) => c.id)).toEqual(stills.slice(1).map((c) => c.id))
  expect(cameraTargets(project, { type: 'clip', id: first!.id }).map((c) => c.id)).toEqual([first!.id])
  const video = Object.values(project.clips).find((c) => c.type === 'video')!
  expect(cameraTargets(project, { type: 'clip', id: video.id }).map((c) => c.id)).toContain(second!.id)
})

it('undoes the camera moves only while they are the latest edit', () => {
  const clipId = stillClips(editor.getProject())[0]!.id
  const result = { moves: [], label: 'Add 3D camera move' }
  editor.dispatch(
    { type: 'effect.add', clipId, effect: cameraEffect('fx'), index: 0 },
    { label: result.label },
  )
  editor.dispatch({ type: 'project.rename', name: 'Renamed' })
  expect(undoCameraMoves(result)).toBe(false)
  editor.undo()
  expect(undoCameraMoves(result)).toBe(true)
  expect(stillClips(editor.getProject()).find((c) => c.id === clipId)?.effects).toEqual([])
})

const fullMove = (id: string) => ({
  id,
  effectId: 'camera-3d',
  enabled: true,
  params: {
    depth: { value: 'depth-1' },
    preset: { value: 'dolly-in' },
    intensity: { value: 0.4 },
    focus: { value: 0.5 },
    progress: { value: 0, keyframes: [{ time: 0, value: 0, easing: 'linear' as const }] },
  },
})

it('says how many of the stills just given a move may smear', () => {
  expect(smearNote(1, 0)).toBeNull()
  expect(smearNote(4, 0)).toBeNull()
  expect(smearNote(1, 1)).toBe(
    'This image may smear behind the foreground at this strength. Try a lower Strength.',
  )
  expect(smearNote(4, 1)).toBe(
    '1 of 4 images may smear behind the foreground at this strength. Try a lower Strength.',
  )
  expect(smearNote(4, 3)).toBe(
    '3 of 4 images may smear behind the foreground at this strength. Try a lower Strength.',
  )
  expect(smearNote(3, 3)).toBe(
    'All 3 images may smear behind the foreground at this strength. Try a lower Strength.',
  )
})

describe('editing a move in Inspector › Motion', () => {
  const withMove = () => {
    const clipId = stillClips(editor.getProject())[0]!.id
    editor.dispatch([
      {
        type: 'effect.add',
        clipId,
        effect: { id: 'grain', effectId: 'grain', enabled: true, params: {} },
        index: 0,
      },
      { type: 'effect.add', clipId, effect: fullMove('move'), index: 1 },
    ])
    return clipId
  }
  const move = (clipId: string) => cameraMoveOf(editor.getProject().clips[clipId]!)

  it('reads the move wherever it sits in the effects, and maps presets back to the panel’s motions', () => {
    const clipId = withMove()
    expect(move(clipId)).toEqual({ index: 1, preset: 'dolly-in', intensity: 0.4 })
    expect(motionOf('dolly-in')).toBe('push')
    expect(motionOf('orbit-right')).toBe('orbit')
    expect(motionOf('tilt-up')).toBeUndefined()
    expect(cameraMoveOf(stillClips(editor.getProject())[1]!)).toBeUndefined()
  })

  it('changes the preset in place, keeping the depth map and the timing, as one undo step', () => {
    const clipId = withMove()
    expect(setCameraMove(clipId, { preset: 'orbit-right' })).toBe(true)
    const fx = (editor.getProject().clips[clipId] as ImageClip).effects[1]!
    expect(fx.params.preset).toEqual({ value: 'orbit-right' })
    expect(fx.params.depth).toEqual({ value: 'depth-1' })
    expect(fx.params.progress?.keyframes).toHaveLength(1)
    expect(editor.undoLabel()).toBe('Change 3D camera move')
    editor.undo()
    expect(move(clipId)?.preset).toBe('dolly-in')
  })

  it('folds a strength drag into one undo step and keeps it between 0 and 1', () => {
    const clipId = withMove()
    setCameraMove(clipId, { intensity: 0.55 }, true)
    setCameraMove(clipId, { intensity: 1.7 }, true)
    editor.endGesture()
    expect(move(clipId)?.intensity).toBe(1)
    editor.undo()
    expect(move(clipId)?.intensity).toBe(0.4)
  })

  it('keeps a predicted smear only while the move keeps its preset and a strength above the safe amount', () => {
    const clipId = withMove()
    const other = stillClips(editor.getProject())[1]!.id
    const at = (intensity: number) => ({
      clipId,
      effectInstanceId: 'move',
      depthAssetId: 'depth-1',
      intensity,
    })
    const result = {
      moves: [
        { ...at(0.4), safeIntensity: 0.15, smearRisk: true },
        { ...at(0.4), clipId: other, safeIntensity: 0.15, smearRisk: true },
      ],
    }
    const smearing = () => smearingMoves(editor.getProject(), result, 'dolly-in').map((m) => m.clipId)
    // The second clip has no move, so it is left out.
    expect(smearing()).toEqual([clipId])
    expect(smearingMoves(editor.getProject(), result, 'orbit-right')).toEqual([])
    setCameraMove(clipId, { intensity: 0.15 })
    expect(smearing()).toEqual([])
    setCameraMove(clipId, { intensity: 0.2 })
    expect(smearing()).toEqual([clipId])
    setCameraMove(clipId, { preset: 'orbit-right' })
    expect(smearing()).toEqual([])
    // Raised above the safe amount after it was added: the inspector's note covers that, not the result.
    const safe = { moves: [{ ...at(0.3), safeIntensity: 0.3, smearRisk: false }] }
    setCameraMove(clipId, { preset: 'dolly-in', intensity: 0.4 })
    expect(smearingMoves(editor.getProject(), safe, 'dolly-in')).toEqual([])
  })

  it('removes only the camera move', () => {
    const clipId = withMove()
    expect(removeCameraMove(clipId)).toBe(true)
    const effects = (editor.getProject().clips[clipId] as ImageClip).effects
    expect(effects.map((e) => e.id)).toEqual(['grain'])
    expect(removeCameraMove(clipId)).toBe(false)
    expect(setCameraMove(clipId, { preset: 'orbit-right' })).toBe(false)
  })
})
