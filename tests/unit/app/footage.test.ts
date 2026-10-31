import { beforeEach, expect, it } from 'vitest'
import { clipTags } from '../../../src/app/state/footage.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { VISION_ANALYSIS_VERSION } from '../../../src/vision/analysisData.ts'

beforeEach(() => loadDemoProject())

const setTags = (assetId: string, tags: string[]) =>
  editor.dispatch(
    {
      type: 'analysis.setVisual',
      analysis: { assetId, version: VISION_ANALYSIS_VERSION, data: { duration: 4, tags } },
    },
    { history: 'skip' },
  )

it('shows the tags footage analysis stored, at most five, over the sample’s own descriptions', () => {
  const sample = clipTags(editor.getProject(), 'm-city')
  expect(sample.length).toBeGreaterThan(0)
  setTags('m-city', ['crowd', 'lights', 'night', 'energetic', 'fast', 'extra'])
  expect(clipTags(editor.getProject(), 'm-city')).toEqual(['crowd', 'lights', 'night', 'energetic', 'fast'])
  setTags('m-city', [])
  expect(clipTags(editor.getProject(), 'm-city')).toEqual([])
})

it('has no tags for a clip of the user’s own until it is analyzed', () => {
  editor.dispatch({
    type: 'asset.add',
    asset: {
      id: 'mine',
      kind: 'video',
      name: 'mine.mp4',
      mimeType: 'video/mp4',
      byteSize: 1,
      storageKey: 'media/mine',
      duration: 3,
      width: 640,
      height: 360,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
    },
  })
  expect(clipTags(editor.getProject(), 'mine')).toEqual([])
  setTags('mine', ['city'])
  expect(clipTags(editor.getProject(), 'mine')).toEqual(['city'])
})
