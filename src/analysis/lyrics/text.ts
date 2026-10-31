/** Lyrics text handling for alignment: parsing pasted lyrics and mapping words onto a CTC character vocabulary. */

export interface LyricsTextLine {
  text: string
  words: string[]
}

/** Section markers and notes people paste with lyrics, e.g. "[Chorus]" or "(x2)". */
const MARKER = /^[[(].*[\])]$/

/** Lines of pasted lyrics with their words; blank lines and section markers are dropped. */
export function parseLyricsText(text: string): LyricsTextLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !MARKER.test(l))
    .map((l) => ({ text: l, words: l.split(/\s+/) }))
}

const FOLD: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  þ: 'th',
  ð: 'd',
  ı: 'i',
}

/**
 * A word as the uppercase A-Z and apostrophe characters an English CTC model knows. Accents are stripped and
 * ligatures expanded, which aligns Latin-script languages well enough; other characters (digits, symbols) are
 * dropped, so a word may come back empty.
 */
export function alignmentKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/[ßæœøđłþðı]/g, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘`´]/g, "'")
    .toUpperCase()
    .replace(/[^A-Z']/g, '')
    .replace(/^'+|'+$/g, '')
}
