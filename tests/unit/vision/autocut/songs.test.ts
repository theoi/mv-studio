import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { songInfoFromProject } from '../../../../src/director/inputs.ts'
import { normalizedLabel } from '../../../../src/director/rules.ts'
import { createProject } from '../../../../src/model/factory.ts'
import type { AudioAnalysis, Project } from '../../../../src/model/types.ts'
import { cutSpans, type CutSpan } from '../../../../src/vision/autocut/rhythm.ts'

/** Analyses of real CC BY / BY-SA songs, written by tests/e2e/autocut-songs.spec.ts. */
const DIR = path.join(import.meta.dirname, 'songs')
const SONGS = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) }))

function projectFor(song: (typeof SONGS)[number]): Project {
  const p = createProject({ name: song.name, now: new Date(0) })
  const analysis: AudioAnalysis = {
    assetId: 'song',
    version: song.analyzer,
    tempo: song.tempo,
    beats: song.beats,
    downbeats: song.downbeats,
    sections: song.sections,
    energy: song.energy,
  }
  return {
    ...p,
    assets: {
      song: {
        id: 'song',
        kind: 'audio',
        name: `${song.name}.mp3`,
        mimeType: 'audio/mpeg',
        byteSize: 1,
        storageKey: 'song',
        duration: song.duration,
        origin: { type: 'import' },
        createdAt: new Date(0).toISOString(),
      },
    },
    songAssetId: 'song',
    analysis: { audio: { song: analysis }, visual: {} },
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

describe.each(SONGS)('auto-cut rhythm on $source.artist - $source.title', (song) => {
  const info = songInfoFromProject(projectFor(song))
  const { spans, grid, sections } = cutSpans(info, {
    pace: 'bar',
    followEnergy: true,
    cutOn: 'beats',
    range: { start: 0, end: info.duration },
  })
  const shotLength = (sectionId: string) =>
    mean(spans.filter((s) => s.sectionId === sectionId).map((s: CutSpan) => s.end - s.start))

  it('cuts every chorus faster than the verse before it', () => {
    const pairs = sections.flatMap((s, i) => {
      if (normalizedLabel(s.label) !== 'chorus') return []
      const verse = sections.slice(0, i).findLast((v) => normalizedLabel(v.label) === 'verse')
      return verse ? [{ chorus: shotLength(s.id), verse: shotLength(verse.id) }] : []
    })
    expect(pairs.length).toBeGreaterThanOrEqual(2)
    for (const p of pairs) expect(p.chorus, JSON.stringify(p)).toBeLessThan(p.verse * 0.85)
  })

  it('lands most cuts on bar lines', () => {
    const onBar = spans.filter((s) => grid.downbeats.some((d) => Math.abs(d - s.start) < grid.beatLength / 4))
    expect(onBar.length / spans.length).toBeGreaterThan(0.55)
  })
})
