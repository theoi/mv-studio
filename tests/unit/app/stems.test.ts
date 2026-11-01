import { describe, expect, it } from 'vitest'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import {
  audioErrorText,
  forgetStemPlaybackErrors,
  noteStemPlaybackError,
  resetStems,
  songStemTrack,
  stemBadge,
  stemBars,
  stemExportWarning,
  stemFallbackNote,
  stemMix,
  stemNoteText,
  toggledStems,
  toggleStem,
  unplayableStem,
  type StemMix,
} from '../../../src/app/state/stems.ts'
import { STEM_NAMES, type Asset, type StemName, type Track } from '../../../src/model/index.ts'
import { JobError } from '../../../src/shared/jobs.ts'

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
    // A short form that fits the header, solo before muted; the full line for the tooltip.
    expect(stemBadge(mix(['vocals'], []))).toEqual({
      text: 'Vocals solo',
      tone: 'warning',
      full: 'Stems: vocals solo',
    })
    expect(stemBadge(mix([], ['drums']))).toEqual({
      text: 'Drums muted',
      tone: 'accent',
      full: 'Stems: drums muted',
    })
    expect(stemBadge(mix(['vocals', 'bass'], []))).toEqual({
      text: '2 stems solo',
      tone: 'warning',
      full: 'Stems: vocals, bass solo',
    })
    expect(stemBadge(mix(['vocals'], ['drums']))).toEqual({
      text: 'Vocals solo',
      tone: 'warning',
      full: 'Stems: vocals solo · drums muted',
    })
    expect(stemBadge(mix([], ['drums', 'other'])).text).toBe('2 stems muted')

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
  })
})

describe('audioErrorText', () => {
  it('names the stem the preview could not play instead of its file, and keeps other messages', () => {
    withStems()
    const project = editor.getProject()
    const failure = (code: 'out-of-memory' | 'decode', assetId: string) =>
      new JobError(code, `The audio of “${assetId}.ogg” failed.`, { details: { assetId } })
    expect(audioErrorText(project, failure('out-of-memory', 'stem-vocals'))).toBe(
      'There is not enough memory to play the vocals separately. Playing the full song instead.',
    )
    expect(audioErrorText(project, failure('out-of-memory', 'stem-other'))).toBe(
      'There is not enough memory to play the other stem separately. Playing the full song instead.',
    )
    expect(audioErrorText(project, failure('decode', 'stem-drums'))).toBe(
      'The drums stem couldn’t be decoded. Playing the full song instead.',
    )
    expect(audioErrorText(project, failure('decode', 'a-song'))).toBe(
      'The audio of “a-song.ogg” failed. Playing the full song instead.',
    )
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

  it('resets every flag in one step', () => {
    withStems()
    toggleStem('vocals', 'solo')
    toggleStem('drums', 'muted')
    resetStems()
    expect(editor.undoLabel()).toBe('Play all stems')
    expect(stemMix(editor.getProject())).toBeNull()
    expect(songTrack().stems).toEqual({})
    editor.undo()
    expect(songTrack().stems).toEqual({ vocals: { solo: true }, drums: { muted: true } })
    toggleStem('bass', 'muted')
    resetStems()
    expect(editor.undoLabel()).toBe('Play all stems')
    expect(toggledStems({ bass: { solo: true } }, 'bass', 'solo')).toEqual({})
  })
})

describe('a stem the preview cannot play', () => {
  const failure = (code: 'out-of-memory' | 'decode', assetId: string) =>
    new JobError(code, 'A stem couldn’t be decoded.', { details: { assetId } })
  const project = () => editor.getProject()

  it('says the full song plays while the stem should be heard, until no stem is heard', () => {
    withStems()
    forgetStemPlaybackErrors(project(), [])
    toggleStem('vocals', 'solo')
    noteStemPlaybackError(project(), failure('decode', 'a-song'))
    expect(unplayableStem(project())).toBeNull()
    noteStemPlaybackError(project(), failure('decode', 'stem-vocals'))
    expect(unplayableStem(project())).toEqual({ name: 'vocals', failure: 'decode' })

    // Still heard with another solo; not heard once the drums play alone, and the preview keeps the failure.
    toggleStem('drums', 'solo')
    forgetStemPlaybackErrors(project(), [])
    expect(unplayableStem(project())).toEqual({ name: 'vocals', failure: 'decode' })
    toggleStem('vocals', 'solo')
    forgetStemPlaybackErrors(project(), [])
    expect(unplayableStem(project())).toBeNull()
    toggleStem('bass', 'muted')
    toggleStem('drums', 'solo')
    forgetStemPlaybackErrors(project(), [])
    expect(stemMix(project())).toEqual({ solo: [], muted: ['bass'] })
    expect(unplayableStem(project())).toEqual({ name: 'vocals', failure: 'decode' })

    // Once the preview plays the stem (an export decoded it again in the same cache), the failure is gone.
    noteStemPlaybackError(project(), failure('out-of-memory', 'stem-vocals'))
    expect(unplayableStem(project())).toEqual({ name: 'vocals', failure: 'out-of-memory' })
    forgetStemPlaybackErrors(project(), [{ assetId: 'stem-drums' }])
    expect(unplayableStem(project())).toEqual({ name: 'vocals', failure: 'out-of-memory' })
    forgetStemPlaybackErrors(project(), [{ assetId: 'stem-vocals' }])
    expect(unplayableStem(project())).toBeNull()
    noteStemPlaybackError(project(), failure('decode', 'stem-vocals'))

    // With every stem playing, the preview forgets the failure and decodes the stem again next time.
    resetStems()
    forgetStemPlaybackErrors(project(), [])
    toggleStem('vocals', 'solo')
    expect(unplayableStem(project())).toBeNull()
  })

  it('words the badge and the panel note', () => {
    // What you hear comes first, also over mutes alone; the tooltip says why.
    expect(stemBadge({ solo: ['vocals'], muted: [] }, { name: 'vocals', failure: 'decode' })).toEqual({
      text: 'Full song plays',
      tone: 'warning',
      full: 'Stems: full song plays · vocals solo. The vocals stem couldn’t be decoded, so the preview plays the full song.',
    })
    expect(stemBadge({ solo: [], muted: ['drums'] }, { name: 'vocals', failure: 'decode' })).toMatchObject({
      text: 'Full song plays',
      tone: 'warning',
    })
    expect(stemFallbackNote({ name: 'vocals', failure: 'decode' })).toBe(
      'The vocals stem couldn’t be decoded, so the preview plays the full song. The export tries the stem again.',
    )
    expect(stemFallbackNote({ name: 'other', failure: 'out-of-memory' })).toBe(
      'There is not enough memory to play the other stem separately, so the preview plays the full song. The export tries the stem again.',
    )
  })
})
