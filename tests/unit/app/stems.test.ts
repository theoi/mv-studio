import { describe, expect, it } from 'vitest'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import {
  resetStems,
  resetStemsLabel,
  songStemTrack,
  stemBadgeText,
  stemBars,
  stemExportWarning,
  stemFixLabel,
  stemMix,
  stemNoteText,
  toggledStems,
  toggleStem,
  type StemMix,
} from '../../../src/app/state/stems.ts'
import { STEM_NAMES, type Asset, type StemName, type Track } from '../../../src/model/index.ts'

describe('stemBars', () => {
  it('draws each bar at the loudest moment of its stretch, so short hits stay visible', () => {
    const features = {
      rate: 50,
      loudness: [0, 0.9, 0, 0, 0, 0, 0.2, 0.4, 0.1],
      bands: [],
      bandEdgesHz: [],
      onsets: [],
    }
    expect(stemBars(features, 3)).toEqual([0.9, 0, 0.4])
  })

  it('draws flat bars for a stem without features', () => {
    expect(stemBars(undefined, 4)).toEqual([0, 0, 0, 0])
  })
})

function stemAsset(name: StemName): Asset {
  return {
    id: `stem-${name}`,
    kind: 'audio',
    name: `song (${name}).ogg`,
    mimeType: 'audio/ogg',
    byteSize: 1,
    storageKey: `media/stem-${name}`,
    origin: { type: 'stem', parentAssetId: 'a-song' },
    createdAt: new Date(0).toISOString(),
  }
}

/** The demo project with the song's four stems attached. */
function withStems(): void {
  loadDemoProject()
  const songId = editor.getProject().songAssetId as string
  editor.dispatch(
    [
      ...STEM_NAMES.map((name) => ({ type: 'asset.add' as const, asset: stemAsset(name) })),
      {
        type: 'analysis.setStems',
        assetId: songId,
        stems: Object.fromEntries(STEM_NAMES.map((n) => [n, `stem-${n}`])),
        stemFeatures: {},
      },
    ],
    { history: 'skip' },
  )
}

const songTrack = () => songStemTrack(editor.getProject()) as Track

describe('stem mix description', () => {
  const mix = (solo: StemName[], muted: StemName[]): StemMix => ({ solo, muted })

  it('is null without separated stems or without flags, and lists the flags that take effect', () => {
    loadDemoProject()
    expect(songTrack().id).toBe('t-song')
    editor.dispatch({ type: 'track.update', trackId: 't-song', patch: { stems: { vocals: { solo: true } } } })
    expect(stemMix(editor.getProject())).toBeNull()
    withStems()
    expect(stemMix(editor.getProject())).toBeNull()
    editor.dispatch({
      type: 'track.update',
      trackId: 't-song',
      patch: { stems: { vocals: { solo: true }, drums: { muted: true }, bass: {} } },
    })
    expect(stemMix(editor.getProject())).toEqual({ solo: ['vocals'], muted: ['drums'] })
  })

  it('words the badge, the panel note, the export warning and its fix', () => {
    expect(stemBadgeText(mix(['vocals'], []))).toBe('Stems: vocals solo')
    expect(stemBadgeText(mix([], ['drums']))).toBe('Stems: drums muted')
    expect(stemBadgeText(mix(['vocals', 'bass'], []))).toBe('Stems: vocals, bass solo')
    expect(stemBadgeText(mix(['vocals'], ['drums']))).toBe('Stems: vocals solo · drums muted')

    expect(stemNoteText(mix(['vocals'], []))).toBe('Only the vocals play, in the preview and the export.')
    expect(stemNoteText(mix(['vocals', 'bass'], []))).toBe(
      'Only the vocals and bass play, in the preview and the export.',
    )
    expect(stemNoteText(mix([], ['drums']))).toBe('The drums are muted, in the preview and the export.')
    expect(stemNoteText(mix(['vocals'], ['drums']))).toBe(
      'Only the vocals play, in the preview and the export. The drums are muted.',
    )
    expect(stemNoteText(mix(['bass'], ['vocals', 'drums', 'other']))).toBe(
      'Only the bass plays, in the preview and the export. The vocals, drums and other stem are muted.',
    )

    expect(stemExportWarning(mix(['vocals'], []))).toBe('Only the vocals will play in this export.')
    expect(stemExportWarning(mix([], ['drums']))).toBe('The drums are muted in this export.')
    expect(stemExportWarning(mix(['vocals'], ['drums']))).toBe(
      'Only the vocals will play in this export, without the drums.',
    )
    expect([mix(['vocals'], []), mix([], ['drums']), mix(['vocals'], ['drums'])].map(stemFixLabel)).toEqual([
      'Unsolo',
      'Unmute',
      'Play all stems',
    ])
  })
})

describe('stem mute and solo commands', () => {
  it('toggles one flag as one undo step, keeping the other stems', () => {
    withStems()
    toggleStem('drums', 'muted')
    toggleStem('vocals', 'solo')
    expect(editor.undoLabel()).toBe('Solo vocals')
    expect(songTrack().stems).toEqual({ drums: { muted: true }, vocals: { solo: true } })
    toggleStem('vocals', 'muted')
    expect(songTrack().stems?.vocals).toEqual({ solo: true, muted: true })
    toggleStem('vocals', 'solo')
    expect(editor.undoLabel()).toBe('Unsolo vocals')
    toggleStem('vocals', 'muted')
    expect(editor.undoLabel()).toBe('Unmute vocals')
    // The last flag removed drops the stem's entry.
    expect(songTrack().stems).toEqual({ drums: { muted: true } })
    editor.undo()
    expect(songTrack().stems).toEqual({ drums: { muted: true }, vocals: { muted: true } })
  })

  it('resets every flag in one step, labelled after what was set', () => {
    withStems()
    toggleStem('vocals', 'solo')
    toggleStem('drums', 'muted')
    resetStems()
    expect(editor.undoLabel()).toBe('Play all stems')
    expect(stemMix(editor.getProject())).toBeNull()
    expect(songTrack().stems).toEqual({})
    editor.undo()
    expect(songTrack().stems).toEqual({ vocals: { solo: true }, drums: { muted: true } })

    expect(resetStemsLabel({ bass: { solo: true } })).toBe('Unsolo stems')
    expect(resetStemsLabel({ bass: { muted: true } })).toBe('Unmute stems')
    expect(toggledStems({ bass: { solo: true } }, 'bass', 'solo')).toEqual({})
  })
})
