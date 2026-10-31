import { expect, it } from 'vitest'
import { describeClips, tagWords } from '../../../../src/vision/matching/tags.ts'
import { clipIndex, fakeMatcher, TOPICS } from '../autocut/fixtures.ts'

it('tags a clip with what stands out in it, its mood and, for video, fast or slow motion', async () => {
  const matcher = fakeMatcher()
  const [crowd, ocean, calm] = await describeClips(
    [
      clipIndex('crowd', 10, TOPICS.crowd!, 12),
      clipIndex('ocean', 10, TOPICS.ocean!, 1),
      clipIndex('city', 10, TOPICS.city!, 3),
    ],
    matcher,
  )
  expect(tagWords(crowd!, 'video')).toEqual(expect.arrayContaining(['crowd', 'fast']))
  expect(tagWords(ocean!, 'video')).toEqual(expect.arrayContaining(['water', 'slow']))
  expect(tagWords(ocean!, 'image')).not.toContain('slow')
  expect(tagWords(calm!, 'video')).toContain('city')
  expect(tagWords(calm!, 'video')).not.toEqual(expect.arrayContaining(['fast']))
  expect(tagWords(calm!, 'video')).not.toEqual(expect.arrayContaining(['slow']))
  expect(await describeClips([], matcher)).toEqual([])
})
