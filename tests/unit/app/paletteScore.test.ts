import { describe, expect, it } from 'vitest'
import { ASK_SCORE, paletteScore } from '../../../src/app/state/paletteScore.ts'

// Labels, keywords and aliases as the palette lists them.
const actions: [string, string, string[]?][] = [
  ['Time lyrics to the vocals', 'karaoke words align sync'],
  ['Put text behind the subject', 'segment cutout person mask'],
  ['Find matching footage', 'tags search clips'],
  ['Undo', ''],
  ['Edit history…', 'undo redo steps back'],
  ['Apply a look…', 'style grade filter restyle'],
  ['Zoom to fit', 'whole song timeline'],
  ['Zoom in', ''],
  ['Song analysis: tempo, beats and sections', 'bpm meter downbeat tap analyze'],
  ['Separate stems', 'vocals drums bass isolate'],
  ['Cut clips to the beat', 'auto-cut edit rhythm'],
  // The clipboard entries that come with multi-select.
  ['Copy', 'clipboard'],
  ['Cut', 'clipboard'],
  ['Paste at playhead', 'clipboard'],
  ['Duplicate', 'copy'],
  ['Delete', 'remove'],
  // Save frame and the entries that used to bury it for "frame" and "still".
  ['Save frame', 'image picture thumbnail', ['still', 'screenshot', 'PNG']],
  ['Add 3D camera motion to a still', 'depth parallax'],
  ['Generate an AI image or clip', 'fal text to video image'],
  ['Editing settings: snapping and durations', 'still text default'],
  ['Open settings', 'general autosave suggestions motion frame rate', ['preferences', 'options']],
  ['Keyboard shortcuts', '', ['hotkeys', 'key bindings', 'keymap']],
]

/** Labels in palette order for a search: best first, hidden ones left out. */
function ranked(search: string): string[] {
  return actions
    .map(([label, keywords, aliases]) => ({
      label,
      score: paletteScore(label, keywords ? [keywords] : [], search, aliases),
    }))
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((a) => a.label)
}

describe('palette ranking', () => {
  it('puts the action a single word names first', () => {
    expect(ranked('look')[0]).toBe('Apply a look…')
    expect(ranked('looks')[0]).toBe('Apply a look…')
    expect(ranked('undo')[0]).toBe('Undo')
    expect(ranked('undo')[1]).toBe('Edit history…')
    expect(ranked('fit')[0]).toBe('Zoom to fit')
    expect(ranked('tempo')[0]).toBe('Song analysis: tempo, beats and sections')
    expect(ranked('cut')[0]).toBe('Cut')
    expect(ranked('paste')[0]).toBe('Paste at playhead')
    expect(ranked('copy')[0]).toBe('Copy')
  })

  it('puts the action an alias names first, below an action named by the whole search', () => {
    expect(ranked('frame')[0]).toBe('Save frame')
    expect(ranked('still')[0]).toBe('Save frame')
    expect(ranked('still')[1]).toBe('Add 3D camera motion to a still')
    expect(ranked('screenshot')[0]).toBe('Save frame')
    expect(ranked('png')[0]).toBe('Save frame')
    expect(ranked('hotkeys')[0]).toBe('Keyboard shortcuts')
    expect(ranked('keys')[0]).toBe('Keyboard shortcuts')
    expect(paletteScore('Save frame', [], 'still', ['still'])).toBeLessThan(
      paletteScore('Still', [], 'still'),
    )
  })

  it('ranks an action named by a phrase above Ask Assist', () => {
    expect(paletteScore('Apply a look…', ['style grade filter restyle'], 'apply a look')).toBeGreaterThan(
      ASK_SCORE,
    )
    expect(paletteScore('Zoom to fit', ['whole song timeline'], 'zoom to fit')).toBeGreaterThan(ASK_SCORE)
    expect(paletteScore('Zoom to fit', ['whole song timeline'], 'fit the whole song')).toBeGreaterThan(
      ASK_SCORE,
    )
  })

  it('ranks Ask Assist first for a sentence no action names', () => {
    for (const [label, keywords, aliases] of actions)
      expect(paletteScore(label, [keywords], 'make the chorus more intense', aliases), label).toBeLessThan(
        ASK_SCORE,
      )
  })

  it('keeps scattered letters as the weakest match and hides what does not match', () => {
    expect(paletteScore('Find matching footage', ['tags search clips'], 'fit')).toBeGreaterThan(0)
    expect(paletteScore('Find matching footage', ['tags search clips'], 'fit')).toBeLessThan(
      paletteScore('Zoom to fit', [], 'fit'),
    )
    expect(paletteScore('Zoom in', [], 'qq')).toBe(0)
  })
})
