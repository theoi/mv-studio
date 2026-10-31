import { beforeEach, expect, it } from 'vitest'
import { cameraTargets, stillClips, undoCameraMoves } from '../../../src/app/state/camera.ts'
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
