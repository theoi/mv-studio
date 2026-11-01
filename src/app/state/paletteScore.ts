/*
 * Command palette ranking. An action whose name the search names comes first: the whole name, its start, or the start
 * of each of its words, then one of its aliases, then the start of its keywords, then words inside them, then near
 * misses of its words (typos, abbreviations). A search that matches none of these shows the empty note. "Ask Assist"
 * for a sentence ranks below the actions that match its words well, and above weak matches.
 */

/** Score of the "Ask Assist: “…”" row. */
export const ASK_SCORE = 0.5

/** Best score an alias match gets: with names that start with the search, below an action's own whole name. */
const ALIAS_SCORE = 0.9

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** "looks" names "look": a plural matches its singular. */
function startsWord(word: string, typed: string): boolean {
  return word.startsWith(typed) || (typed.length > 3 && typed.endsWith('s') && word === typed.slice(0, -1))
}

/** Small words a search may add ("fit the whole song") without them being in the name. */
const FILLER = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'for', 'with', 'my', 'it'])

function inOrder(text: string, letters: string): boolean {
  let i = 0
  for (const ch of text) if (ch === letters[i]) i++
  return i === letters.length
}

/** Edits (insert, delete, replace, swap two neighbors) from `a` to `b`. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const row = d[i]!
      row[j] = Math.min(
        d[i - 1]![j]! + 1,
        row[j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1)
    }
  return d[a.length]![b.length]!
}

/**
 * A typed word that misses `word` narrowly: one typo in it or in its start ("seperate", "expotr"), two from nine
 * letters, two neighbors swapped in a short word ("hoem"), or most of its letters in order from its first ("stms").
 * Letters scattered over several words don't count: "home" found Zoom to fit that way.
 */
function nearWord(word: string, typed: string): boolean {
  if (typed.length < 3) return false
  if (typed[0] === word[0] && typed.length >= word.length * 0.6 && inOrder(word, typed)) return true
  const start = word.slice(0, typed.length)
  if (typed.length < 5)
    return [word, start].some(
      (w) => w.length === typed.length && editDistance(w, typed) === 1 && sameLetters(w, typed),
    )
  const max = typed.length >= 9 ? 2 : 1
  return editDistance(word, typed) <= max || editDistance(start, typed) <= max
}

/** The same letters in another order, so a short word's one edit can only be a swap. */
function sameLetters(a: string, b: string): boolean {
  return [...a].sort().join('') === [...b].sort().join('')
}

/** How well the search names `name`, or 0 when some meant word is missing from it. */
function nameScore(name: string[], typed: string[], needed: string[]): number {
  const phrase = typed.join(' ')
  const full = name.join(' ')
  if (full === phrase) return 1
  if (full.startsWith(phrase)) return 0.95
  if (needed.every((t) => name.some((w) => startsWord(w, t))))
    return startsWord(name[0] ?? '', needed[0] ?? '') ? 0.9 : 0.8
  return 0
}

/**
 * 0 hides the action; higher ranks first. `aliases` are other names people use for the action ("screenshot" for
 * Save frame): a search that names one ranks the action like one whose own name starts with the search.
 */
export function paletteScore(
  label: string,
  keywords: readonly string[],
  search: string,
  aliases: readonly string[] = [],
): number {
  const typed = words(search)
  if (!typed.length) return 1
  const meant = typed.filter((t) => !FILLER.has(t))
  const needed = meant.length ? meant : typed
  const name = words(label)
  const named = Math.max(
    nameScore(name, typed, needed),
    ...aliases.map((alias) => Math.min(ALIAS_SCORE, nameScore(words(alias), typed, needed))),
  )
  if (named > 0) return named
  const extra = [...aliases, ...keywords].flatMap(words)
  if (needed.every((t) => [...name, ...extra].some((w) => startsWord(w, t)))) return 0.6
  const all = [...name, ...extra].join(' ')
  if (needed.every((t) => all.includes(t))) return 0.3
  return needed.every((t) => [...name, ...extra].some((w) => nearWord(w, t))) ? 0.1 : 0
}
