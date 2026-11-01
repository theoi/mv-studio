import { describe, expect, it } from 'vitest'
import { ASK_SCORE, keyCombo, paletteScore, type ScoreOptions } from '../../../src/app/state/paletteScore.ts'

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
  ['Separate stems', 'vocals drums bass isolate split'],
  ['Cut clips to the beat', 'auto-cut edit rhythm'],
  ['Split at playhead', 'clip cut'],
  ['Loop playback', 'repeat section'],
  ['Play / pause', ''],
  ['Set up an LLM (Ollama, LM Studio, OpenAI)', 'api key local model connect settings'],
  ['Connect a MIDI controller', 'vj device knobs pads'],
  // The clipboard entries that come with multi-select.
  ['Copy', 'selected selection'],
  ['Cut', 'selected selection'],
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
  // What searches that match nothing used to show (the scattered-letters tier).
  ['Switch to vertical 9:16', 'aspect ratio shorts reels tiktok'],
  ['Show or hide the library', 'panel media sidebar'],
]

/** Labels in palette order for a search: best first, hidden ones left out. */
function ranked(search: string, options: ScoreOptions = {}): string[] {
  return actions
    .map(([label, keywords, aliases]) => ({
      label,
      score: paletteScore(label, keywords ? [keywords] : [], search, aliases, options),
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

  it('finds a near miss of a word (a typo, an abbreviation) as the weakest match', () => {
    expect(ranked('seperate')).toEqual(['Separate stems'])
    expect(ranked('lyircs')).toEqual(['Time lyrics to the vocals'])
    expect(ranked('stms')).toEqual(['Separate stems'])
    expect(ranked('shorcuts')).toEqual(['Keyboard shortcuts'])
    expect(paletteScore('Separate stems', [], 'seperate')).toBeLessThan(
      paletteScore('Find matching footage', ['tags search clips'], 'tag'),
    )
  })

  it('hides every action that only shares scattered letters with the search', () => {
    // "home" showed Zoom to fit, Show or hide the library and Save frame; "select tool" showed Switch to vertical.
    for (const search of ['home', 'landscape', 'select tool', 'volume', 'qq'])
      expect(ranked(search), search).toEqual([])
    expect(ranked('fit')).toEqual(['Zoom to fit'])
  })

  it('needs no small words, object words or generic verbs, and ranks an action that has them higher', () => {
    expect(ranked('copy this clip')[0]).toBe('Copy')
    expect(ranked('please undo that')[0]).toBe('Undo')
    expect(ranked('make the timeline fit')[0]).toBe('Zoom to fit')
  })

  it('ranks the action whose name the words cover most first', () => {
    expect(ranked('cut the selected clips')[0]).toBe('Cut')
    expect(ranked('cut my clips to the beat')[0]).toBe('Cut clips to the beat')
  })

  it('finds an action by other words for its words, without one word standing in for another the search has', () => {
    expect(ranked('erase')[0]).toBe('Delete')
    expect(ranked('clone').slice(0, 2).sort()).toEqual(['Copy', 'Duplicate'])
    // "start" can't match the "playback" of Loop playback that "playback" already names.
    expect(ranked('start playback')[0]).toBe('Play / pause')
  })

  it('lists actions that match half of the words, one in the name, when asked to, below Ask Assist, ranked by how telling the matched words are', () => {
    const partial = { partial: true }
    // Edit history has "undo" only in its keywords.
    expect(ranked('undo the zebra', partial)).toEqual(['Undo'])
    expect(ranked('undo the zebra')).toEqual([])
    expect(paletteScore('Undo', [], 'undo the zebra', [], partial)).toBeLessThan(ASK_SCORE)
    expect(ranked('zebra crossing undo', partial)).toEqual([])
    expect(
      paletteScore(
        'Open settings',
        ['general autosave suggestions motion frame rate'],
        'mortgage rate',
        [],
        partial,
      ),
    ).toBe(0)
    const rare = (word: string) => (word === 'ollama' ? 3 : 1)
    const common = (word: string) => (word === 'ollama' ? 1 : 3)
    const llm = 'Set up an LLM (Ollama, LM Studio, OpenAI)'
    const midi = 'Connect a MIDI controller'
    const score = (label: string, weight: (word: string) => number) =>
      paletteScore(label, [], 'controller for ollama', [], { weight, partial: true })
    expect(score(llm, rare)).toBeGreaterThan(score(midi, rare))
    expect(score(llm, common)).toBeLessThan(score(midi, common))
  })

  it('keeps an action named only through other words below Ask Assist', () => {
    expect(paletteScore('Delete', [], 'erase')).toBeGreaterThan(0)
    expect(paletteScore('Delete', [], 'erase')).toBeLessThan(ASK_SCORE)
    expect(paletteScore('Delete', ['remove'], 'remove')).toBeGreaterThan(ASK_SCORE)
  })

  it('with strict, ranks an action first only for its own words', () => {
    const strict = { strict: true }
    // Another word for a typed one: below Ask Assist for a sentence, left out for a shorter search.
    expect(paletteScore('Delete', [], 'erase', [], strict)).toBe(0)
    expect(paletteScore('Delete', [], 'erase it please', [], strict)).toBeGreaterThan(0)
    expect(paletteScore('Delete', [], 'erase it please', [], strict)).toBeLessThan(ASK_SCORE)
    // Keywords alone: first for a short search, below Ask Assist for a sentence.
    expect(paletteScore('Delete', ['remove'], 'remove', [], strict)).toBeGreaterThan(ASK_SCORE)
    expect(paletteScore('Delete', ['remove'], 'remove it now please', [], strict)).toBeLessThan(ASK_SCORE)
    // A word of its name, and keywords for the others.
    expect(
      paletteScore('Use the split tool', ['razor blade cut'], 'use the razor tool', [], strict),
    ).toBeGreaterThan(ASK_SCORE)
  })

  it('with strict, reads an alias of several words as the action’s name only when the search has all of them', () => {
    const strict = { strict: true }
    expect(paletteScore('Delete', [], 'clip', ['remove clip'], strict)).toBeLessThan(
      paletteScore('Generate an AI image or clip', [], 'clip', [], strict),
    )
    expect(paletteScore('Delete', [], 'remove the clip', ['remove clip'], strict)).toBeGreaterThan(ASK_SCORE)
  })

  it('ranks a name word another word stands for below the name’s own word, though a keyword has the typed word', () => {
    const strict = { strict: true }
    expect(paletteScore('Switch to vertical 9:16', ['portrait'], 'portrait', [], strict)).toBeLessThan(
      paletteScore('Switch to portrait 4:5', [], 'portrait', [], strict),
    )
  })

  it('with strict, ranks no action above Ask Assist for a question', () => {
    const strict = { strict: true }
    expect(paletteScore('Cut', [], 'how do i cut', [], strict)).toBeGreaterThan(0)
    expect(paletteScore('Cut', [], 'how do i cut', [], strict)).toBeLessThan(ASK_SCORE)
    expect(paletteScore('Cut', [], 'cut it now please', [], strict)).toBeGreaterThan(ASK_SCORE)
  })

  it('with strict, keeps an action below Ask Assist when the search names something it doesn’t act on', () => {
    const copy = (search: string) =>
      paletteScore('Copy', [], search, [], { strict: true, context: 'Edit clip' })
    expect(copy('make a copy of this project')).toBeLessThan(ASK_SCORE)
    expect(copy('make a copy of this clip')).toBeGreaterThan(ASK_SCORE)
  })

  it('matches other forms of a word like the word itself', () => {
    const strict = { strict: true }
    expect(paletteScore('Mute track', [], 'muted tracks', [], strict)).toBeGreaterThan(ASK_SCORE)
    expect(
      paletteScore('Use the split tool', ['razor blade cut'], 'cutting tool', [], strict),
    ).toBeGreaterThan(ASK_SCORE)
    expect(paletteScore('Play / pause', [], 'pause playback', [], strict)).toBeGreaterThan(ASK_SCORE)
    // "-er" makes another word.
    expect(paletteScore('Play / pause', [], 'player')).toBe(0)
  })

  it('reads a typed shortcut as keys, never as letters that start words', () => {
    expect(keyCombo('Ctrl+Shift+Z')).toBe(keyCombo('Mod Shift Z'))
    expect(keyCombo('⌘⇧z')).toBe(keyCombo('Mod Shift Z'))
    expect(keyCombo('cmd + v')).toBe(keyCombo('Mod V'))
    expect(keyCombo('ctrl++')).toBe(keyCombo('Mod +'))
    expect(keyCombo('shift clips')).toBeUndefined()
    expect(paletteScore('Add a visualizer…', [], 'ctrl+v', [], { partial: true })).toBe(0)
    expect(paletteScore('Add a visualizer…', [], 'ctrl v visualizer', [], { partial: true })).toBe(0)
  })

  it('matches the small and optional words of a sentence as whole words only', () => {
    expect(paletteScore('Download project file', ['save backup portable'], 'how do i')).toBe(0)
    expect(paletteScore('Double tempo', ['bpm double time twice as fast'], 'how do i')).toBe(0)
    // A single word may be the start of a longer one.
    expect(paletteScore('Download project file', [], 'do')).toBeGreaterThan(0)
    expect(paletteScore('Go to the start', [], 'go to the start')).toBeGreaterThan(ASK_SCORE)
  })

  it('finds a word inside another only from four letters', () => {
    expect(paletteScore('Show the beat grid', ['show hide view bar lines'], 'get rid of the clip')).toBe(0)
    expect(paletteScore('Keyboard shortcuts', [], 'cuts')).toBeGreaterThan(0)
  })

  it('ranks a near miss of a name above a near miss of a keyword, and keeps the first two letters of a typo', () => {
    expect(ranked('spilt')[0]).toBe('Split at playhead')
    expect(paletteScore('Use the select tool', ['pointer arrow'], 'printer')).toBe(0)
    expect(paletteScore('Use the select tool', ['pointer arrow'], 'ponter')).toBeGreaterThan(0)
  })
})
