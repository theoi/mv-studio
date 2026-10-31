import { beforeEach, describe, expect, it } from 'vitest'
import type { ImageClip } from '../../../src/model/index.ts'
import {
  addedRiskNote,
  cameraMoveOf,
  cameraRisks,
  cameraTargets,
  motionOf,
  removeCameraMove,
  riskFacts,
  riskNote,
  riskyMoves,
  setCameraMove,
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

const smear = [{ risk: 'smear' as const, above: 30 }]
const bend = [{ risk: 'bend' as const, above: 20 }]

it('says how many of the stills just given a move may smear or bend, and what they may do', () => {
  expect(riskNote(1, [])).toBeNull()
  expect(riskNote(4, [[], []])).toBeNull()
  expect(riskNote(1, [smear])).toBe(
    'This image may smear behind foreground objects at this strength. Try a lower Strength.',
  )
  expect(riskNote(4, [[], smear])).toBe(
    '1 of 4 images may smear behind foreground objects at this strength. Try a lower Strength.',
  )
  expect(riskNote(4, [smear, smear, smear])).toBe(
    '3 of 4 images may smear behind foreground objects at this strength. Try a lower Strength.',
  )
  expect(riskNote(3, [smear, smear, smear])).toBe(
    'All 3 images may smear behind foreground objects at this strength. Try a lower Strength.',
  )
  expect(riskNote(1, [bend])).toBe(
    'This image may bend straight lines at this strength. Try a lower Strength.',
  )
  expect(riskNote(3, [bend, smear])).toBe(
    '2 of 3 images may smear behind foreground objects or bend straight lines at this strength. Try a lower Strength.',
  )
  // Bending at any strength: only another motion helps.
  const always = [{ risk: 'bend' as const, above: 0 }]
  expect(riskNote(1, [always])).toBe(
    'This image may bend straight lines at this strength. Try another Motion.',
  )
  expect(riskNote(2, [always, smear])).toBe(
    'All 2 images may smear behind foreground objects or bend straight lines at this strength. Try a lower Strength.',
  )
})

it('lists what a move may do above which strength, the lowest first, from the safe amounts', () => {
  const safe = { smear: 0.4, bend: 0.15 }
  expect(cameraRisks(safe, 15)).toEqual([])
  expect(cameraRisks(safe, 30)).toEqual([{ risk: 'bend', above: 15 }])
  expect(cameraRisks(safe, 50)).toEqual([
    { risk: 'bend', above: 15 },
    { risk: 'smear', above: 40 },
  ])
  expect(riskFacts(cameraRisks(safe, 50), 'long')).toEqual([
    'bend straight lines above 15%',
    'smear behind foreground objects above 40%',
  ])
  expect(riskFacts(cameraRisks(safe, 50), 'short')).toEqual(['bend lines above 15%', 'smear above 40%'])
  // Both from the same strength: one fact.
  expect(riskFacts(cameraRisks({ smear: 0.35, bend: 0.35 }, 50), 'short')).toEqual([
    'smear or bend lines above 35%',
  ])
  expect(riskFacts(cameraRisks({ smear: 0.4, bend: 0 }, 25), 'long')).toEqual([
    'bend straight lines at any strength',
  ])
  expect(riskFacts(cameraRisks({ smear: 0, bend: 0 }, 25), 'short')).toEqual([
    'smear or bend lines at any strength',
  ])
})

it('tells what moves may do at the strength they were added with', () => {
  const move = (intensity: number, safe: { smear: number; bend: number }) => ({
    clipId: 'c',
    effectInstanceId: 'fx',
    depthAssetId: 'd',
    intensity,
    safeIntensity: Math.min(safe.smear, safe.bend),
    safe,
    smearRisk: intensity > safe.smear,
    bendRisk: intensity > safe.bend,
  })
  expect(addedRiskNote({ moves: [move(0.25, { smear: 0.5, bend: 0.25 })] })).toBeNull()
  expect(addedRiskNote({ moves: [move(0.25, { smear: 0.5, bend: 0.1 })] })).toBe(
    'This image may bend straight lines at this strength. Try a lower Strength.',
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

  it('keeps a predicted risk only while the move keeps its preset and a strength above a safe amount', () => {
    const clipId = withMove()
    const other = stillClips(editor.getProject())[1]!.id
    const at = (intensity: number, safe: { smear: number; bend: number }) => ({
      clipId,
      effectInstanceId: 'move',
      depthAssetId: 'depth-1',
      intensity,
      safeIntensity: Math.min(safe.smear, safe.bend),
      safe,
      smearRisk: intensity > safe.smear,
      bendRisk: intensity > safe.bend,
    })
    const result = {
      moves: [at(0.4, { smear: 0.3, bend: 0.15 }), { ...at(0.4, { smear: 0.3, bend: 0.15 }), clipId: other }],
    }
    const risky = () =>
      riskyMoves(editor.getProject(), result, 'dolly-in').map((r) => [r.move.clipId, r.strength, r.risks])
    // The second clip has no move, so it is left out.
    expect(risky()).toEqual([
      [
        clipId,
        40,
        [
          { risk: 'bend', above: 15 },
          { risk: 'smear', above: 30 },
        ],
      ],
    ])
    expect(riskyMoves(editor.getProject(), result, 'orbit-right')).toEqual([])
    setCameraMove(clipId, { intensity: 0.2 })
    expect(risky()).toEqual([[clipId, 20, [{ risk: 'bend', above: 15 }]]])
    setCameraMove(clipId, { intensity: 0.15 })
    expect(risky()).toEqual([])
    setCameraMove(clipId, { intensity: 0.2 })
    setCameraMove(clipId, { preset: 'orbit-right' })
    expect(risky()).toEqual([])
    // Raised above the safe amount after it was added: the inspector's note covers that, not the result.
    const safe = { moves: [at(0.3, { smear: 0.3, bend: 0.3 })] }
    setCameraMove(clipId, { preset: 'dolly-in', intensity: 0.4 })
    expect(riskyMoves(editor.getProject(), safe, 'dolly-in')).toEqual([])
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
